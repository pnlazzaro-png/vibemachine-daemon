// The usage ledger: every API call Claude Code has made on this Mac, from
// every kind of session (the daemon's, the terminal's, the desktop app's,
// Remote Control's), read out of Claude Code's own transcripts under
// ~/.claude/projects. Each transcript line for an API response repeats the
// response's `message.id` and `usage` once per content block, so the ledger
// keeps one row per message id; summed that way it matches the CLI's own
// counters exactly. Around the calls it keeps the prompts, the tool calls
// (with the commands that commit, build, test and ship, and how they went),
// interrupts and turn times. Files are read from where the last scan left
// off, so after the first pass only appended lines cost anything.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "./db.js";
import { costOf } from "./pricing.js";

/** How long the scan reads before letting the event loop run. */
const SCAN_SLICE_MS = 20;

/** Who was driving: the phone (a daemon session), the terminal, the desktop app, or Remote Control from claude.ai. */
export type Source = "phone" | "terminal" | "desktop" | "remote" | "other";

/** What a Bash command was for, when it was one of the pipeline's. */
export type Stage = "commit" | "build" | "test" | "archive" | "testflight" | "deploy" | "push";

export interface LedgerEvents {
  /** New lines were read; the phone's stats are stale. */
  changed: [];
}

interface SessionSeen {
  cwd: string;
  source: Source;
  /** The source came from a line that said who was driving (or the daemon's list), not a guess. */
  sourceKnown: boolean;
  titled: boolean;
}

type Json = Record<string, unknown>;

export function stageOf(command: string): Stage | null {
  if (/\bgit\s+commit\b/.test(command)) return "commit";
  if (/\bgit\s+push\b/.test(command)) return "push";
  if (/testflight\.sh|\baltool\b.*--upload|notarytool\s+submit/.test(command)) return "testflight";
  if (/\bxcodebuild\b/.test(command)) {
    const words = command.split(/\s+/);
    if (words.includes("test")) return "test";
    if (words.includes("archive")) return "archive";
    return "build";
  }
  if (/\bnpm\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bswift\s+test\b|\bnode\s+--test\b|\bgo\s+test\b|\bcargo\s+test\b/.test(command)) return "test";
  if (/\bnpm\s+run\s+build\b|\bswift\s+build\b|\bcargo\s+build\b|\bgo\s+build\b|\btsc\b|\bxcodegen\b/.test(command)) return "build";
  if (/\bdeploy\b|\bwrangler\b|\bvercel\b|\bfly\s+deploy\b|\blaunchctl\s+(load|bootstrap|kickstart)\b/.test(command)) return "deploy";
  return null;
}

/** The local calendar day of an instant, as the phone groups them. */
export function localDay(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sourceOf(line: Json, daemonIds: Set<string>, sessionId: string): Source {
  if (daemonIds.has(sessionId)) return "phone";
  switch (line.entrypoint) {
    case "cli":
      return "terminal";
    case "claude-desktop":
      return "desktop";
    case "sdk-cli":
      // The SDK entry point that isn't the daemon: Remote Control (`claude --sdk-url`).
      return "remote";
    default:
      // Lines synced in from claude.ai carry no version or entry point at all.
      return typeof line.version === "string" ? "other" : "remote";
  }
}

const roots = new Map<string, string>();

/** The repo a directory is in (the nearest parent with a .git), so a session's `cd`s don't split a project. */
export function projectRoot(cwd: string): string {
  const cached = roots.get(cwd);
  if (cached) return cached;
  let dir = cwd;
  let root = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      root = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  roots.set(cwd, root);
  return root;
}

function titleFrom(text: string): string | null {
  const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
  if (!first) return null;
  return first.length > 72 ? first.slice(0, 71).trimEnd() + "…" : first;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export class UsageLedger extends EventEmitter<LedgerEvents> {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending: NodeJS.Timeout | null = null;
  private scanning: Promise<number> | null = null;

  constructor(
    private readonly store: Store,
    readonly root = path.join(os.homedir(), ".claude", "projects"),
  ) {
    super();
  }

  /** The first scan, then the folder watched and a slow sweep in case the watch misses one. */
  start(): void {
    void this.scan().then((rows) => console.log(`usage: ledger up to date (${rows} new rows from ${this.root})`));
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, () => this.schedule());
      this.watcher.on("error", (err) => console.error("usage: watch failed:", err));
    } catch (err) {
      console.error("usage: can't watch the transcripts:", err);
    }
    this.timer = setInterval(() => this.schedule(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) clearTimeout(this.pending);
  }

  private schedule(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.scan();
    }, 1500);
    this.pending.unref();
  }

  /** Read whatever is new in every transcript. Resolves to the number of rows added. */
  scan(): Promise<number> {
    if (this.scanning) return this.scanning;
    // The reading itself is synchronous, so the guard is cleared once the promise settles, not
    // inside the body (which would run before the promise is even assigned).
    const run = (async () => {
      let added = 0;
      try {
        const daemonIds = new Set((this.store.db.prepare(`SELECT id FROM sessions`).all() as { id: string }[]).map((r) => r.id));
        // Each file is read in one go, but between files the event loop gets a turn every so often, so
        // a first scan of a big ~/.claude doesn't hold up the phone's requests and stream.
        let since = Date.now();
        for (const file of this.transcripts()) {
          added += this.scanFile(file, daemonIds);
          if (Date.now() - since > SCAN_SLICE_MS) {
            await new Promise((resolve) => setImmediate(resolve));
            since = Date.now();
          }
        }
      } catch (err) {
        console.error("usage: scan failed:", err);
      }
      if (added > 0) this.emit("changed");
      return added;
    })();
    this.scanning = run.finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  /** Every transcript: `<project>/<session>.jsonl` and the subagents' under `<project>/<session>/subagents/`. */
  private transcripts(): string[] {
    const out: string[] = [];
    if (!fs.existsSync(this.root)) return out;
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
        else if (e.isDirectory() && depth < 3 && e.name !== "memory" && e.name !== "tool-results") walk(p, depth + 1);
      }
    };
    walk(this.root, 0);
    return out;
  }

  private scanFile(file: string, daemonIds: Set<string>): number {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return 0;
    }
    const db = this.store.db;
    const known = db.prepare(`SELECT offset, size, mtime FROM usage_files WHERE path = ?`).get(file) as { offset: number; size: number; mtime: number } | undefined;
    if (known && known.size === stat.size && known.mtime === stat.mtimeMs) return 0;
    let offset = known && known.offset <= stat.size ? known.offset : 0;
    if (stat.size === offset) {
      db.prepare(`INSERT OR REPLACE INTO usage_files (path, offset, size, mtime) VALUES (?, ?, ?, ?)`).run(file, offset, stat.size, stat.mtimeMs);
      return 0;
    }
    const fd = fs.openSync(file, "r");
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    // Only whole lines: the last one may still be being written.
    const end = buffer.lastIndexOf(0x0a);
    let added = 0;
    if (end >= 0) {
      const text = buffer.toString("utf8", 0, end + 1);
      const seen = new Map<string, SessionSeen>();
      db.exec("BEGIN");
      try {
        for (const raw of text.split("\n")) {
          if (!raw) continue;
          let line: Json;
          try {
            line = JSON.parse(raw) as Json;
          } catch {
            continue;
          }
          added += this.apply(line, file, daemonIds, seen);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      offset += end + 1;
    }
    db.prepare(`INSERT OR REPLACE INTO usage_files (path, offset, size, mtime) VALUES (?, ?, ?, ?)`).run(file, offset, stat.size, stat.mtimeMs);
    return added;
  }

  /** One transcript line into the ledger. Returns how many rows it added. */
  private apply(line: Json, file: string, daemonIds: Set<string>, seen: Map<string, SessionSeen>): number {
    const type = line.type;
    const sessionId = typeof line.sessionId === "string" ? line.sessionId : path.basename(file, ".jsonl");
    const ts = typeof line.timestamp === "string" ? line.timestamp : null;
    const db = this.store.db;

    // Titles the CLI or the user gave the session, whenever they appear.
    if (type === "ai-title" || type === "custom-title") {
      const title = [line.title, line.customTitle, line.aiTitle].find((t): t is string => typeof t === "string" && t.trim().length > 0);
      if (title) db.prepare(`UPDATE transcripts SET title = ? WHERE session_id = ?`).run(title.trim(), sessionId);
      return 0;
    }
    if (!ts) return 0;

    // A subagent's lines count as usage, but its prompts are Claude's, not the user's.
    const sidechain = line.isSidechain === true;
    let s = seen.get(sessionId);
    if (!s || (typeof line.cwd === "string" && !sidechain)) {
      s = {
        cwd: typeof line.cwd === "string" ? projectRoot(line.cwd) : (s?.cwd ?? path.basename(path.dirname(file))),
        source: s?.source ?? sourceOf(line, daemonIds, sessionId),
        sourceKnown: s?.sourceKnown ?? (daemonIds.has(sessionId) || typeof line.entrypoint === "string"),
        titled: s?.titled ?? false,
      };
      seen.set(sessionId, s);
    }
    if (!s.sourceKnown && (daemonIds.has(sessionId) || typeof line.entrypoint === "string")) {
      // The first lines said nothing about who was driving; this one does. Rows already kept follow.
      s.source = sourceOf(line, daemonIds, sessionId);
      s.sourceKnown = true;
      for (const table of ["usage", "activity", "transcripts"]) db.prepare(`UPDATE ${table} SET source = ? WHERE session_id = ?`).run(s.source, sessionId);
    }
    const day = localDay(ts);
    const touch = (title: string | null) => {
      if (sidechain) return;
      db.prepare(
        `INSERT INTO transcripts (session_id, cwd, source, title, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           cwd = excluded.cwd, source = excluded.source,
           title = coalesce(transcripts.title, excluded.title),
           first_ts = min(transcripts.first_ts, excluded.first_ts),
           last_ts = max(transcripts.last_ts, excluded.last_ts)`,
      ).run(sessionId, s!.cwd, s!.source, title, ts, ts);
    };

    if (type === "assistant") {
      const message = line.message as Json | undefined;
      const usage = message?.usage as Json | undefined;
      const id = message?.id;
      const model = message?.model;
      if (!usage || typeof id !== "string" || typeof model !== "string" || model === "<synthetic>") return 0;
      let added = 0;
      const creation = usage.cache_creation as Json | undefined;
      const tokens = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite5m: num(creation?.ephemeral_5m_input_tokens),
        cacheWrite1h: num(creation?.ephemeral_1h_input_tokens),
      };
      // Older lines say only how much was written, not for how long: the CLI uses the hour.
      if (tokens.cacheWrite5m + tokens.cacheWrite1h === 0) tokens.cacheWrite1h = num(usage.cache_creation_input_tokens);
      const thinking = num((usage.output_tokens_details as Json | undefined)?.thinking_tokens);
      const r = db
        .prepare(
          `INSERT OR IGNORE INTO usage (id, session_id, cwd, source, model, ts, day, input, output, cache_read, cache_write_5m, cache_write_1h, thinking, cost_usd, sidechain)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, sessionId, s.cwd, s.source, model, ts, day, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite5m, tokens.cacheWrite1h, thinking, costOf(model, tokens), sidechain ? 1 : 0);
      added += Number(r.changes);
      touch(null);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Json[]) {
          if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
          const tool = typeof block.name === "string" ? block.name : "tool";
          const command = (block.input as Json | undefined)?.command;
          const stage = tool === "Bash" && typeof command === "string" ? stageOf(command) : null;
          const t = db
            .prepare(`INSERT OR IGNORE INTO activity (id, session_id, cwd, source, ts, day, kind, tool, stage) VALUES (?, ?, ?, ?, ?, ?, 'tool', ?, ?)`)
            .run(block.id, sessionId, s.cwd, s.source, ts, day, tool, stage);
          added += Number(t.changes);
        }
      }
      return added;
    }

    if (type === "user") {
      if (line.isMeta === true || sidechain) return 0;
      const message = line.message as Json | undefined;
      const content = message?.content;
      let text: string | null = null;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const blocks = content as Json[];
        const results = blocks.filter((b) => b?.type === "tool_result");
        if (results.length > 0) {
          for (const b of results) {
            if (typeof b.tool_use_id !== "string") continue;
            db.prepare(`UPDATE activity SET ok = ?, done_ts = ? WHERE id = ? AND kind = 'tool'`).run(b.is_error === true ? 0 : 1, ts, b.tool_use_id);
          }
          return 0;
        }
        text = blocks
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
      }
      if (text === null) return 0;
      const trimmed = text.trim();
      const uuid = typeof line.uuid === "string" ? line.uuid : `${sessionId}-${ts}`;
      if (trimmed.includes("[Request interrupted by user")) {
        touch(null);
        return Number(db.prepare(`INSERT OR IGNORE INTO activity (id, session_id, cwd, source, ts, day, kind) VALUES (?, ?, ?, ?, ?, ?, 'interrupt')`).run(uuid, sessionId, s.cwd, s.source, ts, day).changes);
      }
      // The CLI's own notes (<local-command-stdout>, <command-name>, <system-reminder>) aren't prompts.
      if (!trimmed || trimmed.startsWith("<")) return 0;
      touch(s.titled ? null : titleFrom(trimmed));
      s.titled = true;
      return Number(db.prepare(`INSERT OR IGNORE INTO activity (id, session_id, cwd, source, ts, day, kind) VALUES (?, ?, ?, ?, ?, ?, 'prompt')`).run(uuid, sessionId, s.cwd, s.source, ts, day).changes);
    }

    if (type === "system" && line.subtype === "turn_duration" && typeof line.durationMs === "number") {
      const uuid = typeof line.uuid === "string" ? line.uuid : `${sessionId}-turn-${ts}`;
      return Number(
        db
          .prepare(`INSERT OR IGNORE INTO activity (id, session_id, cwd, source, ts, day, kind, value) VALUES (?, ?, ?, ?, ?, ?, 'turn', ?)`)
          .run(uuid, sessionId, s.cwd, s.source, ts, day, Math.round(line.durationMs)).changes,
      );
    }
    return 0;
  }
}
