// The session index: every Claude Code session the daemon has run, the live
// children, and the numbered stream of lines per session. Lines are stored
// verbatim and broadcast to whoever subscribed.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ClaudeSession, RefusedError, type Line, type PermissionDecision, type PermissionRequest } from "./claude.js";
import { promptContent, publicAttachment, rewriteEcho, saveAttachments, type AttachmentInput, type FramesById, type PublicAttachment } from "./attachments.js";
import { frameSheets, isVideo } from "./video.js";
import { config } from "./config.js";
import type { EventRow, SessionRow, SessionStatus, Store } from "./db.js";
import { commitsSince, gitHead, type PipelineLine } from "./pipeline.js";
import type { ActivityEvent, Notification } from "./notifier.js";
import { isImagePath, PreviewWatcher, type XcodebuildOutcome } from "./preview.js";
import { previewSummary, projectConfig } from "./project.js";
import { clock, fastestShipBefore } from "./stats.js";
import { askBody, sessionMeter, sessionNow, stageForPipeline, TurnActivityPacer, TurnTracker, type SessionNow, type StageName } from "./turnactivity.js";
import { stopUploads } from "./uploads.js";
import * as simLease from "./simlease.js";
import { KeepAwake } from "./keepawake.js";
import { withoutImageBytes } from "./trim.js";

export interface SessionManagerEvents {
  /** A line was appended to a session's stream. */
  event: [EventRow];
  /** A session row changed (status, cost, title…). */
  session: [SessionInfo];
  /** Something the phone should hear about when it isn't watching. */
  notify: [Notification];
  /** The turn's Live Activity: start, update, end. */
  activity: [ActivityEvent];
  /** A new five-hour reading, from any session: the phone's gauge follows the account, not one session. */
  meter: [NonNullable<ReturnType<typeof sessionMeter>>];
}

/** How much of a child's last words is kept for the phone: lines, and characters of them. */
const STDERR_KEPT = 5;
const STDERR_CHARS = 600;

interface Live {
  proc: ClaudeSession;
  /** The child's newest stderr lines: why it died, if it does. */
  stderrTail: string[];
  turnStartHead: string | null;
  seenCommits: Set<string>;
  /** The last look for new commits, so the next waits for it. */
  commitWatch: Promise<void>;
  idleTimer: NodeJS.Timeout | null;
  /** A prompt sent while the process was starting, if any. */
  inTurn: boolean;
  /** 1-based count of the turn in flight (or the last one). */
  turn: number;
  preview: PreviewWatcher;
  /** Bash commands by tool_use id, so a result can be read as a build's. */
  toolCommands: Map<string, string>;
  /** Images Claude asked to Read, by tool_use id, so the preview can show them once read. */
  imageReads: Map<string, string>;
  /** The last prompt sent with attachments, until the CLI echoes it (see attachments.ts). */
  echo: { text: string; attachments: PublicAttachment[] } | null;
  /** The effort changed mid-turn: end the child when the turn is over so the next prompt respawns it. */
  restartAfterTurn: boolean;
  /** When the host last sent an interrupt (taps are debounced), and the watchdog that ends the turn if no result follows. */
  lastInterruptAt: number;
  interruptWatchdog: NodeJS.Timeout | null;
  /** An interrupt was sent and the CLI hasn't acknowledged it yet. */
  interruptUnanswered: boolean;
  /** Set while the child is being ended on purpose; a prompt waits for it. */
  retiring: Promise<void> | null;
  /** When the turn in flight was asked for, so a ship at its end can be timed. */
  promptAt: string | null;
  /** The turn on the Lock Screen: what it has reached, and when to push it. */
  activity: { tracker: TurnTracker; pacer: TurnActivityPacer } | null;
  /** How the last turn's activity ended, for a phone whose token for it arrives after the end. */
  lastActivityEnd: { state: Record<string, unknown>; dismissAt: Date } | null;
  /** Release and build lines still running, by tool call: a backgrounded upload outlives its turn. */
  openPipelines: Map<string, StageName>;
  /** What the session list was last told this session is on, to tell it again only on a change. */
  lastNow: string;
}

/** A session row as the phone sees it: with what the project's preview offers, and the stage it is on. */
export type SessionInfo = SessionRow & {
  preview: ReturnType<typeof previewSummary>;
  now: SessionNow | null;
  /** Its newest picture, for the session list's row (2026-11-10); null with nothing shot. */
  thumb: { id: string; width: number; height: number } | null;
  /** Its last turns, oldest first: how long each took and whether it ended well. */
  trail: { ms: number; ok: boolean }[];
};

export interface NewSessionInput {
  cwd: string;
  prompt: string;
  title?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  attachments?: AttachmentInput[];
}

/** What the phone may change on a session after it started. */
/** Permission modes the CLI takes (`--permission-mode`, `set_permission_mode`). */
export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "bypassPermissions", "plan", "dontAsk"] as const;

export interface SessionOptions {
  model?: string | null;
  effort?: string | null;
  /** Switch the permission mode, live and for the next spawn. */
  permissionMode?: string;
}

/** A request the daemon won't act on as asked: the caller's to fix (a 400). */
export class BadRequestError extends Error {}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly live = new Map<string, Live>();
  /** The account's newest five-hour reading, from any session: read once from the store, then kept as lines arrive. */
  private meter: ReturnType<typeof sessionMeter> | undefined;

  constructor(
    private readonly store: Store,
    /** Holds the Mac awake while any turn is in flight (keepawake.ts). */
    private readonly keepAwake = new KeepAwake(),
  ) {
    super();
    // Anything marked live when the daemon last stopped is not live now, and a turn it was in
    // never got its result: close its prompts and the turn on the stream, so a phone replaying
    // the history doesn't find a card still waiting.
    for (const s of store.listSessions(1000)) {
      const live = s.status === "running" || s.status === "waiting" || s.status === "starting";
      // Prompts left open in any session's history (an idle one too: earlier daemons didn't close them).
      const closed = this.closeOpenPrompts(s.id);
      if (live) {
        this.append(s.id, { type: "host", subtype: "turn_ended", reason: "daemon_restart", ts: new Date().toISOString() });
        this.setStatus(s.id, "idle");
      } else if (closed) {
        console.log(`[${s.id.slice(0, 8)}] closed ${closed} prompt(s) left open in its history`);
      }
    }
  }

  /** Stale lines for every prompt the stream opened and never closed. */
  private closeOpenPrompts(id: string): number {
    const open = this.store.openPermissionRequests(id);
    for (const requestId of open) {
      this.append(id, { type: "host", subtype: "permission_response", request_id: requestId, behavior: "stale", ts: new Date().toISOString() });
    }
    return open.length;
  }

  /** Stale prompts and a turn_ended line, for a turn that will never finish. */
  private closeOnStream(id: string, reason: string): void {
    this.closeOpenPrompts(id);
    this.append(id, { type: "host", subtype: "turn_ended", reason, ts: new Date().toISOString() });
  }

  list(): SessionInfo[] {
    return this.store.listSessions().map((row) => this.decorate(row));
  }

  get(id: string): SessionInfo | undefined {
    const row = this.store.getSession(id);
    return row ? this.decorate(row) : undefined;
  }

  events(id: string, since: number, limit?: number): EventRow[] {
    return this.store.eventsSince(id, since, limit);
  }

  pendingPermissions(id: string): PermissionRequest[] {
    return [...(this.live.get(id)?.proc.pending.values() ?? [])];
  }

  async create(input: NewSessionInput): Promise<SessionRow> {
    const cwd = input.cwd;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new BadRequestError(`cwd is not a directory: ${cwd}`);
    // The picker lists repos under PROJECTS_DIR; a request naming any other folder is refused, not obeyed.
    const root = fs.realpathSync(config.projectsDir);
    const real = fs.realpathSync(cwd);
    if (real !== root && !real.startsWith(root + path.sep)) throw new BadRequestError(`cwd must be a folder under PROJECTS_DIR (${config.projectsDir}): ${cwd}`);
    const id = randomUUID();
    const title = input.title?.trim() || titleFrom(input.prompt) || input.attachments?.[0]?.name || "Untitled";
    const row = this.store.insertSession({
      id,
      title,
      cwd,
      model: input.model ?? (config.defaultModel || null),
      effort: input.effort ?? null,
      permission_mode: input.permissionMode ?? config.defaultPermissionMode,
      status: "starting",
      created_at: new Date().toISOString(),
    });
    this.emit("session", this.decorate(row));
    await this.spawn(row, false);
    await this.prompt(id, input.prompt, input.attachments);
    return this.store.getSession(id)!;
  }

  async prompt(id: string, text: string, attachments: AttachmentInput[] = []): Promise<void> {
    let row = this.store.getSession(id);
    if (!row) throw new Error("no such session");
    // Another turn for an archived session (from `vm say`, say) puts it back in the list.
    if (row.archived_at) row = this.store.setArchived(id, false)!;
    let live = this.live.get(id);
    if (live?.retiring) {
      // A settings change is ending the child; the resumed one picks up the new flags.
      await live.retiring;
      live = this.live.get(id);
      row = this.store.getSession(id)!;
    }
    if (!live || live.proc.exited) {
      live = await this.spawn(row, true);
    }
    const turn = row.turns + 1;
    const saved = saveAttachments(this.store, id, turn, attachments);
    // A video's frames are laid out on sheets before the prompt goes (a few seconds for a minute of it).
    const frames: FramesById = new Map();
    for (const { row } of saved) if (isVideo(row.media_type)) frames.set(row.id, await frameSheets(row.path));
    if (live.inTurn) {
      // Sent while a turn runs: the CLI holds it and echoes it only when its turn comes, so the
      // phone hears now that it is queued and can show it waiting.
      this.append(id, { type: "host", subtype: "queued", text, attachments: saved.map((s) => publicAttachment(s.row)), ts: new Date().toISOString() });
      // A TestFlight upload under way stops, where the project asks for that (`.vibemachine.json`,
      // `"release": { "stop_on_prompt": true }`): the queued change ships with this one, in one build.
      // Only there: anyone's repo may have a `testflight.sh` of its own, with no trap to tidy up.
      if (projectConfig(row.cwd).stopUploadsOnPrompt) {
        void stopUploads(live.proc.pid)
          .then((n) => { if (n > 0) console.log(`[${id.slice(0, 8)}] a prompt was queued: stopped the TestFlight upload (${n} processes)`); })
          .catch((err: unknown) => console.error(`[${id.slice(0, 8)}] stopping the upload failed:`, err));
      }
    }
    live.echo = saved.length > 0 ? { text, attachments: saved.map((s) => publicAttachment(s.row)) } : null;
    // Sent mid-turn, the prompt joins the running turn: its commits so far still count.
    const fresh = !live.inTurn;
    if (fresh) live.turnStartHead = await gitHead(row.cwd);
    this.setInTurn(live, true);
    live.turn = turn;
    live.promptAt = new Date().toISOString();
    await live.preview.startTurn(live.turn, { shootBefore: true });
    this.clearIdle(live);
    live.proc.prompt(promptContent(text, saved, frames));
    this.setStatus(id, "running");
    if (fresh) this.startActivity(id, live, row, turn, text);
  }

  /** A new turn: its Live Activity, started by push, then moved along as its lines arrive. */
  private startActivity(id: string, live: Live, row: SessionRow, turn: number, prompt: string): void {
    live.activity?.pacer.stop();
    const tracker = new TurnTracker(Math.floor(Date.now() / 1000), this.latestMeter());
    const pacer = new TurnActivityPacer(
      () => tracker.state,
      (state, important) => this.emit("activity", { sessionId: id, event: "update", state: { ...state }, urgent: important }),
    );
    live.activity = { tracker, pacer };
    live.lastActivityEnd = null;
    // A new turn's lines say what is running from here; one left open before it would never close.
    live.openPipelines.clear();
    const state = tracker.state;
    pacer.started(state);
    this.emit("activity", {
      sessionId: id,
      event: "start",
      attributes: { sessionId: id, project: projectName(row.cwd), title: row.title, turn },
      state: { ...state },
      // iOS starts an activity by push only with an alert carrying a title and a body; without one
      // it drops the push without a word. No sound: a turn starting needn't buzz the phone.
      alert: { title: projectName(row.cwd), body: activityAlertBody(prompt, row.title) },
      quiet: true,
    });
  }

  /** The newest five-hour reading the daemon has seen in any session. */
  latestMeter(): ReturnType<typeof sessionMeter> {
    if (this.meter === undefined) {
      const row = this.store.lastEventOfTypeAnywhere("rate_limit_event");
      let line: Record<string, unknown> | null = null;
      try {
        line = row ? (JSON.parse(row.json) as Record<string, unknown>) : null;
      } catch {
        line = null;
      }
      this.meter = line ? sessionMeter(line) : null;
    }
    return this.meter;
  }

  /** Each line the stream gets, read for the activity; the turn's end ends it. */
  private feedActivity(id: string, line: Record<string, unknown>): void {
    const meter = sessionMeter(line);
    if (meter) {
      this.meter = meter;
      this.emit("meter", meter);
    }
    const activity = this.live.get(id)?.activity;
    if (!activity || activity.tracker.finished) return;
    activity.tracker.feed(line);
    if (!activity.tracker.finished) {
      activity.pacer.poke();
      return;
    }
    activity.pacer.stop();
    const live = this.live.get(id)!;
    live.activity = null;
    // On the Lock Screen a while, to be read, then gone.
    const end = { state: { ...activity.tracker.state } as Record<string, unknown>, dismissAt: new Date(Date.now() + 10 * 60_000) };
    live.lastActivityEnd = end;
    this.emit("activity", { sessionId: id, event: "end", ...end });
  }

  /**
   * The phone reported an activity's token for this session. If no turn is running, the turn it
   * belongs to ended before the token came (a short one): the end is sent again so it lands.
   */
  activityTokenArrived(id: string): void {
    const live = this.live.get(id);
    if (!live || live.activity) return;
    const end = live.lastActivityEnd ?? { state: { stage: "done", status: "stopped", tokens: 0, output: 0, startedAt: 0, lit: [], detail: "" }, dismissAt: new Date() };
    this.emit("activity", { sessionId: id, event: "end", ...end });
  }

  /**
   * Change the model or effort. The model switches in the live child at once;
   * effort is a spawn flag, so the child is ended (after its turn, if it is in
   * one) and the next prompt resumes the conversation with the new level.
   */
  async setOptions(id: string, opts: SessionOptions): Promise<SessionInfo> {
    const row = this.store.getSession(id);
    if (!row) throw new Error("no such session");
    const patch: { model?: string | null; effort?: string | null; permission_mode?: string } = {};
    if (opts.model !== undefined && opts.model !== row.model) patch.model = opts.model;
    if (opts.effort !== undefined && opts.effort !== row.effort) patch.effort = opts.effort;
    if (opts.permissionMode !== undefined && opts.permissionMode !== row.permission_mode) patch.permission_mode = opts.permissionMode;
    if (Object.keys(patch).length === 0) return this.decorate(row);
    const live = this.live.get(id);
    if (live && !live.proc.exited && patch.model) {
      // Before the row changes, so a refused model leaves the session as it was.
      await live.proc.setModel(patch.model);
    }
    if (live && !live.proc.exited && patch.permission_mode) {
      // Takes effect in the live child at once; the row makes the next spawn match. A refusal
      // throws before the row changes, so the phone never shows a mode the CLI isn't in.
      await live.proc.setPermissionMode(patch.permission_mode);
    }
    this.patch(id, patch);
    this.append(id, { type: "host", subtype: "settings", ...patch, ts: new Date().toISOString() });
    if (live && !live.proc.exited && patch.permission_mode === "bypassPermissions") {
      // "Never ask" also covers what was already asked: the prompts the CLI raised before the switch.
      for (const requestId of [...live.proc.pending.keys()]) this.answer(id, requestId, { behavior: "allow" });
    }
    if (live && !live.proc.exited && patch.effort !== undefined) {
      if (live.inTurn) live.restartAfterTurn = true;
      else void this.retire(live);
    }
    return this.get(id)!;
  }

  /** Screenshot the project's app in the simulator now (vm preview, or the phone). */
  async capturePreview(id: string): Promise<void> {
    const row = this.store.getSession(id);
    if (!row) throw new Error("no such session");
    let live = this.live.get(id);
    if (!live) {
      // No child needed for a screenshot: a watcher on its own, for the last turn.
      const preview = new PreviewWatcher(this.store, id, row.cwd, (line) => this.append(id, line));
      await preview.startTurn(row.turns);
      await preview.captureNow();
      return;
    }
    await live.preview.captureNow();
  }

  answer(id: string, requestId: string, decision: PermissionDecision): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    const ok = live.proc.answer(requestId, decision);
    if (ok) {
      this.append(id, {
        type: "host",
        subtype: "permission_response",
        request_id: requestId,
        behavior: decision.behavior,
        ...(decision.behavior === "deny" ? { message: decision.message } : {}),
        ts: new Date().toISOString(),
      });
      if (live.proc.pending.size === 0) this.setStatus(id, "running");
      return true;
    }
    // The CLI no longer has this request (it was interrupted, or answered elsewhere): say so on the
    // stream, so every phone takes the card down, rather than failing the tap.
    this.append(id, { type: "host", subtype: "permission_response", request_id: requestId, behavior: "stale", ts: new Date().toISOString() });
    return true;
  }

  /** Interrupts within this window of each other are one interrupt (the stop button gets tapped a lot). */
  static readonly INTERRUPT_DEBOUNCE_MS = 2000;
  /** After an interrupt (or the CLI's own interrupted line) with no `result` by then, the turn is over. */
  static readonly INTERRUPT_RESULT_GRACE_MS = 6000;

  async interrupt(id: string): Promise<boolean> {
    const live = this.live.get(id);
    if (!live || live.proc.exited) return false;
    const now = Date.now();
    if (now - live.lastInterruptAt < SessionManager.INTERRUPT_DEBOUNCE_MS) return true;
    live.lastInterruptAt = now;
    this.append(id, { type: "host", subtype: "interrupt", ts: new Date().toISOString() });
    // The CLI abandons a permission prompt it is waiting on, and never answers it: close the cards now.
    this.dropPending(id, live, "interrupted");
    // Armed before the CLI answers: one wedged on a dead stream never does (2026-11-04).
    live.interruptUnanswered = true;
    this.armInterruptWatchdog(id, live);
    await live.proc.interrupt();
    live.interruptUnanswered = false;
    return true;
  }

  /** Forget every pending permission request and tell the stream why. */
  private dropPending(id: string, live: Live, behavior: "interrupted" | "stale"): void {
    for (const requestId of [...live.proc.pending.keys()]) {
      live.proc.pending.delete(requestId);
      this.append(id, { type: "host", subtype: "permission_response", request_id: requestId, behavior, ts: new Date().toISOString() });
    }
  }

  /**
   * A turn interrupted while a permission prompt was open ends without a `result` line
   * (Claude Code 2.1.281). If none arrives in time, end the turn ourselves. If the CLI hasn't
   * even acknowledged the interrupt, it is wedged: end the child, whose exit ends the turn, and
   * the next prompt resumes the conversation.
   */
  private armInterruptWatchdog(id: string, live: Live): void {
    if (live.interruptWatchdog) clearTimeout(live.interruptWatchdog);
    live.interruptWatchdog = setTimeout(() => {
      live.interruptWatchdog = null;
      if (!live.inTurn || live.proc.exited) return;
      if (live.interruptUnanswered) {
        console.log(`[${id.slice(0, 8)}] the CLI never answered the interrupt; stopping the child`);
        live.proc.kill();
        return;
      }
      console.log(`[${id.slice(0, 8)}] no result after the interrupt; ending the turn`);
      void this.endTurnWithoutResult(id, live);
    }, SessionManager.INTERRUPT_RESULT_GRACE_MS);
    live.interruptWatchdog.unref();
  }

  /**
   * A turn over, the simulator is no longer its session's: a session idle between prompts would
   * otherwise keep it from every other one until its lease lapsed (scripts/sim).
   */
  private async giveBackSimulator(live: Live): Promise<void> {
    const pid = live.proc.pid;
    if (pid !== undefined) await simLease.release(pid);
  }

  /** Every turn's start and end come through here, so the Mac is kept awake for exactly those spans. */
  private setInTurn(live: Live, inTurn: boolean): void {
    live.inTurn = inTurn;
    this.keepAwake.set(live, inTurn);
  }

  private async endTurnWithoutResult(id: string, live: Live): Promise<void> {
    this.setInTurn(live, false);
    this.dropPending(id, live, "interrupted");
    this.append(id, { type: "host", subtype: "turn_ended", reason: "interrupted", ts: new Date().toISOString() });
    const row = this.store.getSession(id);
    this.patch(id, { turns: (row?.turns ?? 0) + 1 });
    await this.recordCommits(id, live);
    await this.giveBackSimulator(live);
    await live.preview.endTurn(null);
    this.setStatus(id, "idle");
    if (live.restartAfterTurn) {
      live.restartAfterTurn = false;
      void this.retire(live);
    } else {
      this.armIdle(id, live);
    }
  }

  /** A stage line from outside (build, deploy…); see pipeline.ts. */
  addPipeline(id: string, line: PipelineLine): EventRow {
    if (!this.store.getSession(id)) throw new Error("no such session");
    return this.append(id, line);
  }

  /**
   * Out of the phone's list, or back into it. Not while a turn runs or waits on you: what is still
   * going stays in sight. Nothing is deleted; the stream, captures and costs stay.
   */
  archive(id: string, archived: boolean): SessionInfo {
    const row = this.store.getSession(id);
    if (!row) throw new Error("no such session");
    if (archived && (row.status === "starting" || row.status === "running" || row.status === "waiting")) throw new RefusedError("the session is in a turn; archive it once the turn ends");
    const updated = this.decorate(this.store.setArchived(id, archived)!);
    this.emit("session", updated);
    return updated;
  }

  /** Stop a live child (it can be resumed by the next prompt). */
  stop(id: string): boolean {
    const live = this.live.get(id);
    if (!live) return false;
    this.clearIdle(live);
    live.proc.end();
    return true;
  }

  shutdown(): void {
    for (const live of this.live.values()) {
      this.clearIdle(live);
      live.proc.end();
    }
    this.keepAwake.stop();
  }

  private async spawn(row: SessionRow, resume: boolean): Promise<Live> {
    const proc = new ClaudeSession({
      id: row.id,
      cwd: row.cwd,
      resume,
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      permissionMode: row.permission_mode,
    });
    const live: Live = {
      proc,
      turnStartHead: null,
      seenCommits: new Set(),
      commitWatch: Promise.resolve(),
      idleTimer: null,
      inTurn: false,
      turn: row.turns,
      preview: new PreviewWatcher(this.store, row.id, row.cwd, (line) => this.append(row.id, line)),
      toolCommands: new Map(),
      imageReads: new Map(),
      echo: null,
      restartAfterTurn: false,
      promptAt: null,
      activity: null,
      lastActivityEnd: null,
      openPipelines: new Map(),
      lastNow: "null",
      lastInterruptAt: 0,
      interruptWatchdog: null,
      interruptUnanswered: false,
      retiring: null,
      stderrTail: [],
    };
    // An upload the tool backgrounded ends after its tool call: the watcher says how.
    live.preview.onOutcome = (outcome) => this.buildOutcome(row.id, live, outcome);
    this.live.set(row.id, live);

    // A handler that throws (a write the database refused, say) is this session's trouble alone:
    // said in the log, never left to reach the process and stop every other session's turn.
    const guarded = (what: string, body: () => void): void => {
      try {
        body();
      } catch (err) {
        console.error(`[${row.id.slice(0, 8)}] ${what} failed:`, err);
      }
    };
    proc.on("line", (line) => void this.onLine(row.id, live, line).catch((err: unknown) => console.error(`[${row.id.slice(0, 8)}] a line failed:`, err)));
    proc.on("permission", (req) => guarded("a permission prompt", () => {
      this.setStatus(row.id, "waiting");
      const current = this.store.getSession(row.id);
      this.emit("notify", {
        sessionId: row.id,
        kind: "permission",
        title: `${projectName(row.cwd)} needs your OK`,
        body: askBody(req as unknown as Record<string, unknown>) || (current?.title ?? "a tool"),
        requestId: req.request_id,
      });
    }));
    proc.on("stderr", (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      console.error(`[${row.id.slice(0, 8)}] ${trimmed}`);
      // The last few lines are kept: if the child dies, they are why, and the phone should say so.
      live.stderrTail = [...live.stderrTail, ...trimmed.split("\n").map((l) => l.trim()).filter(Boolean)].slice(-STDERR_KEPT);
    });
    proc.on("exit", ({ code, signal }) => guarded("the exit", () => {
      this.clearIdle(live);
      const why = code !== 0 && live.stderrTail.length > 0 ? live.stderrTail.join("\n").slice(-STDERR_CHARS) : null;
      this.append(row.id, { type: "host", subtype: "exit", code, signal, ...(why ? { stderr: why } : {}), ts: new Date().toISOString() });
      if (live.interruptWatchdog) clearTimeout(live.interruptWatchdog);
      const midTurn = live.inTurn;
      // Whatever it was doing, a child that's gone holds the Mac awake no longer.
      this.setInTurn(live, false);
      const current = this.store.getSession(row.id);
      if (current && midTurn) {
        // The child died mid-turn (or was stopped while waiting on a prompt): nothing will answer now.
        // While the session is still among the live ones, so the turn's Live Activity hears it end
        // and leaves the Lock Screen instead of showing a turn at work for ever.
        this.closeOnStream(row.id, `exited${code !== null ? ` ${code}` : ""}`);
        if (code !== 0) {
          this.emit("notify", {
            sessionId: row.id,
            kind: "stopped",
            title: `${projectName(row.cwd)}: Claude Code stopped`,
            body: why?.split("\n").at(-1) ?? `It exited${code !== null ? ` with status ${code}` : ""} in the middle of a turn.`,
          });
        }
      }
      if (this.live.get(row.id) === live) this.live.delete(row.id);
      if (!current) return;
      if (midTurn && code !== 0) this.setStatus(row.id, "failed");
      else if (current.status !== "ended") this.setStatus(row.id, "idle");
    }));
    proc.start();
    return live;
  }

  private async onLine(id: string, live: Live, line: Line): Promise<void> {
    if (live.echo) {
      // The prompt coming back with its images in it: keep the records, not the bytes.
      const rewritten = rewriteEcho(line, live.echo);
      if (rewritten) {
        line = rewritten as Line;
        live.echo = null;
      }
    }
    // A screenshot Claude read is kept by the preview as a file; the table keeps the line without its bytes.
    this.append(id, line.type === "user" ? withoutImageBytes(line) : line);
    // Claude Code isn't signed in (or the .env's API key was refused): its own words say to run
    // /login, which nobody can do from a phone. Say what to do on the Mac, in the stream and as a push.
    if (line.type === "assistant" && line.error === "authentication_failed") {
      const viaKey = !!process.env.ANTHROPIC_API_KEY?.trim();
      const text = viaKey
        ? "Claude Code refused the API key in the daemon's .env. Check ANTHROPIC_API_KEY on the Mac (or remove it to use your sign-in), then send the prompt again."
        : "Claude Code isn't signed in on this Mac. On the Mac, run claude in a terminal and sign in with your own account, then send the prompt again. vibemachine doctor checks it.";
      this.append(id, { type: "host", subtype: "notice", text, ts: new Date().toISOString() });
      this.emit("notify", { sessionId: id, kind: "stopped", title: `${projectName(live.proc.cwd)}: Claude Code isn't signed in`, body: viaKey ? "The API key in .env was refused" : "Run claude on the Mac and sign in" });
    }
    if (line.type === "assistant") {
      for (const block of contentBlocks(line)) {
        if (block.type === "tool_use" && block.name === "Read" && typeof block.id === "string") {
          const file = (block.input as { file_path?: unknown } | undefined)?.file_path;
          if (isImagePath(file as string | undefined)) live.imageReads.set(block.id, file as string);
          if (live.imageReads.size > 200) live.imageReads.delete(live.imageReads.keys().next().value!);
        }
        if (block.type === "tool_use" && block.name === "Bash" && typeof block.id === "string") {
          const command = (block.input as { command?: unknown } | undefined)?.command;
          if (typeof command === "string") live.toolCommands.set(block.id, command);
          if (live.toolCommands.size > 200) live.toolCommands.delete(live.toolCommands.keys().next().value!);
          // A build or archive: its pipeline lines light the turn activity's lamps.
          if (typeof command === "string") live.preview.beforeTool(block.id, command);
        }
      }
    } else if (line.type === "user") {
      for (const block of contentBlocks(line)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.includes("[Request interrupted by user")) {
          this.dropPending(id, live, "interrupted");
          if (live.inTurn) this.armInterruptWatchdog(id, live);
          continue;
        }
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const image = live.imageReads.get(block.tool_use_id);
        if (image) {
          live.imageReads.delete(block.tool_use_id);
          if (block.is_error !== true) void live.preview.sawImage(image).catch((err: unknown) => console.error(`[${id.slice(0, 8)}] look failed:`, err));
        }
        const command = live.toolCommands.get(block.tool_use_id);
        live.toolCommands.delete(block.tool_use_id);
        const outcome = await live.preview.afterTool(block.tool_use_id, command, resultText(block.content, line.tool_use_result), block.is_error === true);
        if (outcome) this.buildOutcome(id, live, outcome);
      }
    } else if (line.type === "system" && line.subtype === "task_notification" && !live.inTurn) {
      // A background task finished after the turn's result and woke Claude, with no prompt: the
      // session works again until the next result (which ends it as any turn ends). No new turn
      // number, Live Activity or preview round: it's the same turn, picked up again.
      this.setInTurn(live, true);
      this.clearIdle(live);
      this.setStatus(id, "running");
    } else if (line.type === "system" && line.subtype === "post_turn_summary") {
      const detail = typeof line.status_detail === "string" ? line.status_detail : null;
      if (detail) this.patch(id, { summary: detail });
    } else if (line.type === "system" && line.subtype === "vcs_state_changed" && line.kind === "commit") {
      await this.recordCommits(id, live);
    } else if (line.type === "result") {
      this.setInTurn(live, false);
      if (live.interruptWatchdog) {
        clearTimeout(live.interruptWatchdog);
        live.interruptWatchdog = null;
      }
      const cost = typeof line.total_cost_usd === "number" ? line.total_cost_usd : undefined;
      const row = this.store.getSession(id);
      this.patch(id, {
        turns: (row?.turns ?? 0) + 1,
        ...(cost !== undefined ? { cost_usd: cost } : {}),
      });
      await this.recordCommits(id, live);
      const caption = captionFrom(this.store.getSession(id)?.summary ?? null, line);
      await this.giveBackSimulator(live);
      await live.preview.endTurn(caption);
      this.setStatus(id, "idle");
      if (live.restartAfterTurn) {
        live.restartAfterTurn = false;
        void this.retire(live);
      } else {
        this.armIdle(id, live);
      }
      const note = turnEndPush(projectName(live.proc.cwd), line, caption ?? (row?.title ?? ""));
      if (note) this.emit("notify", { sessionId: id, ...note });
    }
  }

  /**
   * The turn's commits not yet on the stream. One round at a time for a session: lines arrive
   * without waiting for each other, and two rounds reading git together would each post the same
   * commits.
   */
  private recordCommits(id: string, live: Live): Promise<void> {
    const round = live.commitWatch.then(async () => {
      try {
        const found = await commitsSince(live.proc.cwd, live.turnStartHead, live.seenCommits);
        for (const sha of found.shas) live.seenCommits.add(sha);
        // The turn they belong to, so the phone shows each diff among that turn's pages.
        for (const line of found.lines) this.append(id, { ...line, turn: live.turn });
      } catch (err) {
        console.error(`[${id.slice(0, 8)}] commit watch failed:`, err);
      }
    });
    live.commitWatch = round;
    return round;
  }

  /** End the child on purpose and wait for it to go; the next prompt resumes the conversation. */
  private retire(live: Live): Promise<void> {
    if (live.retiring) return live.retiring;
    live.retiring = new Promise<void>((resolve) => {
      if (live.proc.exited) return resolve();
      const deadline = setTimeout(() => live.proc.kill(), 8_000);
      live.proc.once("exit", () => {
        clearTimeout(deadline);
        resolve();
      });
      this.clearIdle(live);
      live.proc.end();
    });
    return live.retiring;
  }

  private armIdle(id: string, live: Live): void {
    this.clearIdle(live);
    if (config.idleMinutes <= 0) return;
    live.idleTimer = setTimeout(() => {
      if (!live.inTurn && live.proc.pending.size === 0) {
        console.log(`[${id.slice(0, 8)}] idle for ${config.idleMinutes} min; stopping the child (resumes on next prompt)`);
        live.proc.end();
      }
    }, config.idleMinutes * 60_000);
    live.idleTimer.unref();
  }

  private clearIdle(live: Live): void {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
  }

  /**
   * A TestFlight upload just finished: the time from this turn's prompt to now, against the fastest
   * ship the ledger knows from before it. A new record (or the first ship ever) says so on the
   * Live Activity and the Lock Screen.
   */
  /** A build or upload ended: a record if the ship set one, a push if it failed. */
  private buildOutcome(id: string, live: Live, outcome: XcodebuildOutcome): void {
    const project = projectName(live.proc.cwd);
    const record = outcome.ok && outcome.shipped ? this.shipRecord(live) : null;
    if (record && live.activity && !live.activity.tracker.finished) {
      // The upload broke the record: the turn's card says so, with a sound.
      live.activity.tracker.setRecord(`fastest ship · ${record.time}${record.previous ? ` · was ${record.previous}` : ""}`);
      this.emit("activity", { sessionId: id, event: "update", state: { ...live.activity.tracker.state }, alert: { title: "NEW RECORD", body: `${project} shipped in ${record.time}` }, alertKind: "shipped" });
    }
    const note = buildPush(project, outcome);
    if (note) this.emit("notify", { sessionId: id, ...note });
  }

  private shipRecord(live: Live): { time: string; ms: number; previous: string | null } | null {
    if (!live.promptAt) return null;
    const ms = Date.now() - new Date(live.promptAt).getTime();
    if (ms <= 0) return null;
    const best = fastestShipBefore(this.store, live.promptAt);
    if (best && best.ms <= ms) return null;
    return { time: clock(ms), ms, previous: best ? clock(best.ms) : null };
  }

  private append(id: string, line: Record<string, unknown>): EventRow {
    const row = this.store.appendEvent(id, line);
    this.emit("event", row);
    this.feedActivity(id, line);
    this.followNow(id, line);
    return row;
  }

  /** A pipeline line opened or closed, or the turn moved on: the session list hears the session's new stage. */
  private followNow(id: string, line: Record<string, unknown>): void {
    const live = this.live.get(id);
    if (!live) return;
    if (line.type === "pipeline" && typeof line.ref === "string") {
      const stage = stageForPipeline(line.stage);
      if (stage && line.status === "running") live.openPipelines.set(line.ref, stage);
      else live.openPipelines.delete(line.ref);
    }
    const now = JSON.stringify(this.now(id));
    if (now === live.lastNow) return;
    live.lastNow = now;
    const row = this.store.getSession(id);
    if (row) this.emit("session", this.decorate(row));
  }

  private now(id: string): SessionNow | null {
    const live = this.live.get(id);
    if (!live) return null;
    return sessionNow(live.activity?.tracker.state ?? null, [...live.openPipelines.values()], live.lastActivityEnd?.state ?? null);
  }

  private decorate(row: SessionRow): SessionInfo {
    return { ...row, preview: previewSummary(row.cwd), now: this.now(row.id), thumb: this.store.sessionThumb(row.id), trail: this.trail(row) };
  }

  /** A session's turn trail, read again only when another turn has ended. */
  private trails = new Map<string, { turns: number; trail: { ms: number; ok: boolean }[] }>();
  private trail(row: SessionRow): { ms: number; ok: boolean }[] {
    const kept = this.trails.get(row.id);
    if (kept && kept.turns === row.turns) return kept.trail;
    const trail = this.store.turnTrail(row.id);
    this.trails.set(row.id, { turns: row.turns, trail });
    return trail;
  }

  private setStatus(id: string, status: SessionStatus): void {
    this.patch(id, { status });
  }

  private patch(id: string, patch: Parameters<Store["updateSession"]>[1]): void {
    const row = this.store.updateSession(id, patch);
    if (row) this.emit("session", this.decorate(row));
  }
}

/** The start alert's line: the prompt, on one line and short, or the session's title for an empty one. */
/**
 * The push a turn's result makes, if any. A turn the person stopped themselves (an interrupt while
 * Claude wrote or while a tool ran) makes none. A result that is an error says the session stopped
 * and why, in the CLI's own words when it has them: the usage limit comes as a "success" carrying
 * is_error and the 429's message ("You've hit your 5-hour limit · resets 6pm"), and was pushed as
 * "done" until 2026-11-11.
 */
export function turnEndPush(project: string, line: Line, caption: string): Omit<Notification, "sessionId"> | null {
  if (line.terminal_reason === "aborted_streaming" || line.terminal_reason === "aborted_tools") return null;
  const said = typeof line.result === "string" ? line.result.trim() : "";
  if (line.is_error === true || line.subtype !== "success") {
    const limit = line.api_error_status === 429 || /\b(usage|session|5-hour|weekly) limit\b|out of usage/i.test(said);
    return { kind: "stopped", title: `${project}: ${limit ? "usage limit" : "stopped"}`, body: said.split("\n")[0] || caption || "The turn ended with an error." };
  }
  return { kind: "turn_done", title: `${project}: done`, body: caption };
}

/** The push a build or an upload ending makes, if any: an upload that landed, or a build that failed. */
export function buildPush(project: string, outcome: XcodebuildOutcome): Omit<Notification, "sessionId"> | null {
  if (outcome.ok) return outcome.shipped ? { kind: "shipped", title: `${project}: on TestFlight`, body: outcome.detail } : null;
  if (outcome.deliberate) return null;
  return { kind: "build_failed", title: `${project}: ${outcome.title ?? `${outcome.stage} failed`}`, body: outcome.detail || "see the log in the stream" };
}

export function activityAlertBody(prompt: string, title: string): string {
  const line = prompt.replace(/\s+/g, " ").trim() || title.trim() || "A new turn";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}


interface Block {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function contentBlocks(line: Line): Block[] {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** A tool result's text: the Bash tool's stdout and stderr when relayed, else the content blocks. */
/** A tool result's text: the Bash tool's own stdout and stderr when it gives them, else the content. */
export function resultText(content: unknown, structured: unknown): string {
  // A command the tool put in the background has empty output fields; its notice (the task id and
  // the file its output goes to) is only in the content, and the upload watch needs it.
  const backgrounded = !!structured && typeof structured === "object" && typeof (structured as { backgroundTaskId?: unknown }).backgroundTaskId === "string";
  if (!backgrounded && structured && typeof structured === "object" && "stdout" in structured) {
    const s = structured as { stdout?: unknown; stderr?: unknown };
    return [s.stdout, s.stderr].filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type?: unknown; text?: unknown }[])
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join("\n");
  }
  return "";
}

/** The caption on a turn's screenshots: Claude's own one-line summary, else its final words. */
function captionFrom(summary: string | null, result: Line): string | null {
  if (summary?.trim()) return summary.trim();
  const text = typeof result.result === "string" ? result.result.trim() : "";
  const first = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  return first ? (first.length > 200 ? first.slice(0, 199).trimEnd() + "…" : first) : null;
}

/** The prompt's first line, trimmed to fit; empty when there is no prompt. */
function titleFrom(prompt: string): string {
  const first = prompt.trim().split("\n")[0] ?? "";
  return first.length > 72 ? first.slice(0, 71).trimEnd() + "…" : first;
}
