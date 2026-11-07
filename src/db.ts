// SQLite (node:sqlite): sessions, their numbered event lines, enrolled devices.
import fs from "node:fs";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./config.js";
import { withoutImageBytes } from "./trim.js";

export type SessionStatus = "starting" | "running" | "waiting" | "idle" | "ended" | "failed";

export interface SessionRow {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  /** `--effort` for the child: low, medium, high, xhigh, max; null is the CLI's default. */
  effort: string | null;
  permission_mode: string;
  status: SessionStatus;
  summary: string | null;
  cost_usd: number;
  turns: number;
  /** When it was swiped out of the phone's list; null while it is in it. A new prompt brings it back. */
  archived_at: string | null;
  last_seq: number;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  seq: number;
  session_id: string;
  ts: string;
  type: string;
  subtype: string | null;
  json: string;
}

export interface CaptureRow {
  id: string;
  session_id: string;
  turn: number;
  screen: string;
  /** A simulator shot before or after a build, or an image Claude read ("look"). */
  kind: "before" | "after" | "look";
  path: string;
  width: number;
  height: number;
  created_at: string;
}

/** A file the phone sent with a prompt; the bytes live under DATA_DIR/attachments. */
export interface AttachmentRow {
  id: string;
  session_id: string;
  turn: number;
  name: string;
  media_type: string;
  path: string;
  size: number;
  created_at: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  public_key: string; // base64 X9.63 (04 || X || Y)
  created_at: string;
  last_seen: string | null;
  /** APNs device token (hex) and which APNs environment it belongs to. */
  push_token: string | null;
  push_environment: string | null;
  push_error: string | null;
  /** ActivityKit push-to-start token, so the daemon can start a Live Activity from the Mac. */
  activity_start_token: string | null;
}

export interface ActivityTokenRow {
  device_id: string;
  session_id: string;
  token: string;
  environment: string;
  updated_at: string;
}

/**
 * The schema's version, kept in SQLite's user_version. Bump it with any change below that alters
 * existing tables; on the first open after a bump the database is copied to `<file>.before-v<N>`
 * first (`VACUUM INTO`, so the copy is compact), keeping only the newest copy. A database from
 * before versioning (user_version 0) has version 1's schema and is just marked. Version 2 (2026-10-31):
 * sessions.archived_at.
 */
export const SCHEMA_VERSION = 2;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = dbPath, schemaVersion = SCHEMA_VERSION) {
    this.db = new DatabaseSync(path);
    const found = (this.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
    const existing = (this.db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get() as { n: number }).n > 0;
    if (path !== ":memory:" && existing && found > 0 && found < schemaVersion) this.backup(path, schemaVersion);
    if (found > schemaVersion) console.warn(`db: written by a newer daemon (schema ${found}, this one knows ${schemaVersion}); run vibemachine update`);
    // The streams, prompts and push tokens are the user's alone: owner-only, whatever the umask was.
    if (path !== ":memory:") {
      for (const f of [path, `${path}-wal`, `${path}-shm`]) {
        try {
          fs.chmodSync(f, 0o600);
        } catch {
          /* not made yet */
        }
      }
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL,
        summary TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        subtype TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen TEXT
      );
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        screen TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS captures_session ON captures(session_id, turn);
      CREATE TABLE IF NOT EXISTS activity_tokens (
        device_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        token TEXT NOT NULL,
        environment TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (device_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attachments_session ON attachments(session_id, turn);
      -- The usage ledger (usage.ts): every API call Claude Code made on this Mac, read from its
      -- transcripts, one row per message id; the prompts, tool calls and turns around them; and
      -- the transcript files themselves, with how far each has been read.
      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        ts TEXT NOT NULL,
        day TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write_5m INTEGER NOT NULL,
        cache_write_1h INTEGER NOT NULL,
        thinking INTEGER NOT NULL,
        cost_usd REAL,
        sidechain INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
      CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
      CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id, ts);
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        source TEXT NOT NULL,
        ts TEXT NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        tool TEXT,
        stage TEXT,
        ok INTEGER,
        value INTEGER,
        done_ts TEXT
      );
      CREATE INDEX IF NOT EXISTS activity_ts ON activity(ts);
      CREATE INDEX IF NOT EXISTS activity_session ON activity(session_id, ts);
      CREATE TABLE IF NOT EXISTS transcripts (
        session_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT,
        first_ts TEXT NOT NULL,
        last_ts TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_files (
        path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL
      );
    `);
    // Columns added after the first release.
    this.addColumns("devices", ["push_token", "push_environment", "push_error", "activity_start_token"]);
    this.addColumns("sessions", ["effort", "archived_at"]);
    // When a tool finished (the ship times need it): the ledger reads every transcript again to
    // fill it in for the rows it already has (inserts are ignored, the updates land).
    if (this.addColumns("activity", ["done_ts"]).length > 0) this.db.exec(`DELETE FROM usage_files`);
    if (found < schemaVersion) this.db.exec(`PRAGMA user_version = ${Math.floor(schemaVersion)}`);
  }

  /** A compact copy of the database before a migration; older copies go. */
  private backup(path: string, version: number): void {
    const dir = nodePath.dirname(path);
    const base = nodePath.basename(path);
    const target = nodePath.join(dir, `${base}.before-v${version}`);
    for (const f of fs.readdirSync(dir)) if (f.startsWith(`${base}.before-v`)) fs.rmSync(nodePath.join(dir, f), { force: true });
    this.db.prepare(`VACUUM INTO ?`).run(target);
    fs.chmodSync(target, 0o600);
    console.log(`db: copied to ${target} before the schema moves to version ${version}`);
  }

  /** Adds the columns the table lacks; returns the ones it added. */
  private addColumns(table: string, columns: string[]): string[] {
    const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const added: string[] = [];
    for (const column of columns) {
      if (have.has(column)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      added.push(column);
    }
    return added;
  }

  // Sessions

  insertSession(s: Omit<SessionRow, "cost_usd" | "turns" | "last_seq" | "summary" | "updated_at" | "effort" | "archived_at"> & { effort?: string | null }): SessionRow {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, model, effort, permission_mode, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.title, s.cwd, s.model, s.effort ?? null, s.permission_mode, s.status, s.created_at, s.created_at);
    return this.getSession(s.id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  listSessions(limit = 100): SessionRow[] {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`).all(limit) as unknown as SessionRow[];
  }

  updateSession(id: string, patch: Partial<Pick<SessionRow, "status" | "summary" | "cost_usd" | "turns" | "title" | "last_seq" | "model" | "effort" | "permission_mode">>): SessionRow | undefined {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return this.getSession(id);
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => patch[k] ?? null);
    this.db.prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, new Date().toISOString(), id);
    return this.getSession(id);
  }

  /** In or out of the list, without moving it in the list's order (updated_at stays). */
  setArchived(id: string, archived: boolean): SessionRow | undefined {
    this.db.prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(archived ? new Date().toISOString() : null, id);
    return this.getSession(id);
  }

  // Events

  appendEvent(sessionId: string, event: Record<string, unknown>): EventRow {
    const ts = new Date().toISOString();
    const type = typeof event.type === "string" ? event.type : "unknown";
    const subtype = typeof event.subtype === "string" ? event.subtype : null;
    const json = JSON.stringify(event);
    const info = this.db
      .prepare(`INSERT INTO events (session_id, ts, type, subtype, json) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, ts, type, subtype, json);
    const seq = Number(info.lastInsertRowid);
    this.db.prepare(`UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?`).run(seq, ts, sessionId);
    return { seq, session_id: sessionId, ts, type, subtype, json };
  }

  eventsSince(sessionId: string, since: number, limit = 2000): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(sessionId, since, limit) as unknown as EventRow[];
  }

  /** Permission requests the stream opened and never closed with a host permission_response. */
  openPermissionRequests(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT json_extract(json, '$.request_id') AS id FROM events
         WHERE session_id = ? AND type = 'control_request' AND json_extract(json, '$.request.subtype') = 'can_use_tool'
           AND json_extract(json, '$.request_id') NOT IN (
             SELECT json_extract(json, '$.request_id') FROM events
             WHERE session_id = ? AND type = 'host' AND subtype = 'permission_response')`,
      )
      .all(sessionId, sessionId) as { id: string | null }[];
    return rows.map((r) => r.id).filter((id): id is string => typeof id === "string");
  }

  /** The latest line of a type in any session: the account's newest rate-limit reading, say. */
  lastEventOfTypeAnywhere(type: string): EventRow | undefined {
    return this.db.prepare(`SELECT * FROM events WHERE type = ? ORDER BY ts DESC LIMIT 1`).get(type) as EventRow | undefined;
  }

  /** The latest line of a type for a session (used to recover a pending permission after restart). */
  lastEventOfType(sessionId: string, type: string): EventRow | undefined {
    return this.db
      .prepare(`SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1`)
      .get(sessionId, type) as EventRow | undefined;
  }

  // Captures (simulator screenshots; the files live under DATA_DIR/captures)

  insertCapture(c: Omit<CaptureRow, "created_at">): CaptureRow {
    this.db
      .prepare(`INSERT INTO captures (id, session_id, turn, screen, kind, path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.session_id, c.turn, c.screen, c.kind, c.path, c.width, c.height, new Date().toISOString());
    return this.getCapture(c.id)!;
  }

  getCapture(id: string): CaptureRow | undefined {
    return this.db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id) as CaptureRow | undefined;
  }

  /** The newest simulator capture of a screen for any session in a cwd: the next turn's "before". */
  latestCapture(cwd: string, screen: string): CaptureRow | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM captures c JOIN sessions s ON s.id = c.session_id
         WHERE s.cwd = ? AND c.screen = ? AND c.kind != 'look' ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get(cwd, screen) as CaptureRow | undefined;
  }

  /** The newest capture of a screen in a cwd other than `except` (the one just taken): what it showed before. */
  latestCaptureBefore(cwd: string, screen: string, except: string): CaptureRow | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM captures c JOIN sessions s ON s.id = c.session_id
         WHERE s.cwd = ? AND c.screen = ? AND c.kind != 'look' AND c.id != ? ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get(cwd, screen, except) as CaptureRow | undefined;
  }

  deleteCapture(id: string): void {
    this.db.prepare(`DELETE FROM captures WHERE id = ?`).run(id);
  }

  // Attachments (files the phone sent with a prompt; under DATA_DIR/attachments)

  insertAttachment(a: Omit<AttachmentRow, "created_at">): AttachmentRow {
    this.db
      .prepare(`INSERT INTO attachments (id, session_id, turn, name, media_type, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.id, a.session_id, a.turn, a.name, a.media_type, a.path, a.size, new Date().toISOString());
    return this.getAttachment(a.id)!;
  }

  getAttachment(id: string): AttachmentRow | undefined {
    return this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
  }

  // Devices and pairing

  insertDevice(d: Pick<DeviceRow, "id" | "name" | "public_key">): DeviceRow {
    this.db
      .prepare(`INSERT OR REPLACE INTO devices (id, name, public_key, created_at, last_seen) VALUES (?, ?, ?, ?, NULL)`)
      .run(d.id, d.name, d.public_key, new Date().toISOString());
    return this.getDevice(d.id)!;
  }

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as DeviceRow | undefined;
  }

  listDevices(): DeviceRow[] {
    return this.db.prepare(`SELECT * FROM devices ORDER BY created_at`).all() as unknown as DeviceRow[];
  }

  touchDevice(id: string): void {
    this.db.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  /**
   * Streaming deltas (and the thinking-token ticks) older than `before`: the full message follows
   * each, and a replay skips them (server.ts isLiveOnly), so past their turn they are only bulk.
   * They are most of the table. Sessions still running keep theirs.
   */
  pruneLiveOnly(before: Date): number {
    return Number(
      this.db
        .prepare(`DELETE FROM events WHERE ts < ? AND (type = 'stream_event' OR (type = 'system' AND subtype = 'thinking_tokens')) AND session_id NOT IN (SELECT id FROM sessions WHERE status IN ('starting', 'running', 'waiting'))`)
        .run(before.toISOString()).changes,
    );
  }

  /**
   * Image bytes out of tool results stored after `afterSeq` (lines are stored without them since
   * 2026-10-29; older ones carried a screenshot's base64 twice). How many changed, and the newest
   * seq looked at, to start from next time.
   */
  dropImageBytes(afterSeq: number): { rows: number; lastSeq: number } {
    const lastSeq = Number((this.db.prepare(`SELECT coalesce(max(seq), 0) AS n FROM events`).get() as { n: number }).n);
    if (lastSeq <= afterSeq) return { rows: 0, lastSeq };
    const found = this.db
      .prepare(`SELECT seq, json FROM events WHERE seq > ? AND seq <= ? AND type = 'user' AND (json LIKE '%"type":"image"%' OR json LIKE '%"base64"%')`)
      .all(afterSeq, lastSeq) as { seq: number; json: string }[];
    const update = this.db.prepare(`UPDATE events SET json = ? WHERE seq = ?`);
    let rows = 0;
    this.db.exec("BEGIN");
    try {
      for (const row of found) {
        const event = JSON.parse(row.json) as Record<string, unknown>;
        const slim = withoutImageBytes(event);
        if (slim === event) continue;
        update.run(JSON.stringify(slim), row.seq);
        rows++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { rows, lastSeq };
  }

  /**
   * The file rewritten without its free pages when they come to a quarter of it and at least
   * `minFree` bytes (after a prune, SQLite keeps the space for reuse). Only while no session is in a
   * turn: VACUUM holds the database for a few seconds. The bytes it gave back.
   */
  compact(minFree = 32 * 1024 * 1024): number {
    const pragma = (name: string) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
    const pageSize = pragma("page_size");
    const pages = pragma("page_count");
    const free = pragma("freelist_count");
    if (free * pageSize < minFree || free < pages / 4) return 0;
    const live = (this.db.prepare(`SELECT count(*) AS n FROM sessions WHERE status IN ('starting', 'running', 'waiting')`).get() as { n: number }).n;
    if (live > 0) return 0;
    this.db.exec("VACUUM");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Math.max(0, (pages - pragma("page_count")) * pageSize);
  }

  /** Attachments sent before `before`: their rows, and the files they named (for the caller to delete). */
  pruneAttachments(before: Date): string[] {
    const rows = this.db.prepare(`SELECT path FROM attachments WHERE created_at < ?`).all(before.toISOString()) as { path: string }[];
    this.db.prepare(`DELETE FROM attachments WHERE created_at < ?`).run(before.toISOString());
    return rows.map((r) => r.path);
  }

  removeDevice(id: string): boolean {
    this.db.prepare(`DELETE FROM activity_tokens WHERE device_id = ?`).run(id);
    return this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id).changes > 0;
  }

  // Push

  setPushToken(id: string, token: string | null, environment: string | null): void {
    this.db.prepare(`UPDATE devices SET push_token = ?, push_environment = ?, push_error = NULL WHERE id = ?`).run(token, environment, id);
  }

  setPushError(id: string, error: string | null): void {
    this.db.prepare(`UPDATE devices SET push_error = ? WHERE id = ?`).run(error, id);
  }

  setActivityStartToken(id: string, token: string | null): void {
    this.db.prepare(`UPDATE devices SET activity_start_token = ? WHERE id = ?`).run(token, id);
  }

  /** Devices that can be pushed to. */
  pushDevices(): DeviceRow[] {
    return this.db.prepare(`SELECT * FROM devices WHERE push_token IS NOT NULL`).all() as unknown as DeviceRow[];
  }

  setActivityToken(deviceId: string, sessionId: string, token: string, environment: string): void {
    this.db
      .prepare(
        `INSERT INTO activity_tokens (device_id, session_id, token, environment, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id, session_id) DO UPDATE SET token = excluded.token, environment = excluded.environment, updated_at = excluded.updated_at`,
      )
      .run(deviceId, sessionId, token, environment, new Date().toISOString());
  }

  activityTokens(sessionId: string): ActivityTokenRow[] {
    return this.db.prepare(`SELECT * FROM activity_tokens WHERE session_id = ?`).all(sessionId) as unknown as ActivityTokenRow[];
  }

  allActivityTokens(): ActivityTokenRow[] {
    return this.db.prepare(`SELECT * FROM activity_tokens`).all() as unknown as ActivityTokenRow[];
  }

  clearActivityToken(deviceId: string, sessionId: string): void {
    this.db.prepare(`DELETE FROM activity_tokens WHERE device_id = ? AND session_id = ?`).run(deviceId, sessionId);
  }

  /** One code is live at a time: a new one retires the last, so `vm pair` twice doesn't leave two doors open. */
  createPairingCode(code: string, expiresAt: Date): void {
    this.db.prepare(`DELETE FROM pairing_codes`).run();
    this.db.prepare(`INSERT OR REPLACE INTO pairing_codes (code, expires_at) VALUES (?, ?)`).run(code, expiresAt.toISOString());
  }

  /** Consumes the code if it is valid. */
  redeemPairingCode(code: string): boolean {
    const row = this.db.prepare(`SELECT expires_at FROM pairing_codes WHERE code = ?`).get(code) as { expires_at: string } | undefined;
    if (!row) return false;
    this.db.prepare(`DELETE FROM pairing_codes WHERE code = ?`).run(code);
    return new Date(row.expires_at).getTime() > Date.now();
  }

  close(): void {
    this.db.close();
  }
}
