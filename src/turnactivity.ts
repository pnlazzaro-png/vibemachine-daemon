// The turn on the Lock Screen and in the Dynamic Island: which stage is hot,
// whether it is working, waiting on the user, failed or done, the tokens the turn
// has used, and when it began (the phone runs the clock itself). Read off the
// same events the stream gets, with the app's own rules for stages
// (the app's TurnProgress.swift), so the activity and the lamps agree.
//
// TurnTracker is pure: feed it lines, read its state. TurnActivityPacer decides
// when a change is worth a push: at once for a new stage or status (no more
// than one every few seconds), the token count alone now and then.

import { isReleaseScript } from "./release.js";

export type StageName = "prompt" | "thinking" | "tools" | "writing" | "testing" | "commit" | "build" | "flight" | "preview" | "done";
export const STAGES: StageName[] = ["prompt", "thinking", "tools", "writing", "testing", "commit", "build", "flight", "preview", "done"];

export type TurnStatus = "working" | "waiting" | "failed" | "done" | "stopped";

/** The activity's content state, as the widget decodes it (TurnActivityAttributes.ContentState). */
export interface TurnActivityState {
  stage: StageName;
  status: TurnStatus;
  /** Every token the turn has sent and received so far, cache reads included: the receipt's total. */
  tokens: number;
  /** Of those, what Claude wrote. */
  output: number;
  /** Unix seconds: when the prompt went in, and when the turn finished. */
  startedAt: number;
  endedAt?: number;
  /** The stages the turn has touched, in the lamps' order. */
  lit: StageName[];
  /** A short line under the readouts: the build's error, say. */
  detail: string;
  /** The fastest ship on record, set by the upload that broke it. */
  record?: string;
  /** The account's five-hour window, 0…1, and when it resets (unix seconds): the session meter. */
  session?: number;
  sessionResetsAt?: number;
  /** While it waits on the user: the permission request the Lock Screen's Allow and Deny answer, and what it asks. */
  requestId?: string;
  ask?: string;
}

/** What a permission request asks, in a line: the tool and its description, as the push says it. */
export function askLine(req: Line): string {
  const line = [req.display_name ?? req.tool_name, req.description].filter((p) => typeof p === "string" && p !== "").join(" · ");
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** The five-hour window off a rate_limit_event, as the app reads it (StreamReducer's fiveHourUtilization). */
export function sessionMeter(line: Record<string, unknown>): { utilization: number; resetsAt?: number } | null {
  if (line.type !== "rate_limit_event") return null;
  const info = line.rate_limit_info as Record<string, unknown> | undefined;
  const window = (info?.unifiedWindows as Record<string, unknown> | undefined)?.five_hour as Record<string, unknown> | undefined;
  const utilization = window?.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const resetsAt = typeof window?.resetsAt === "number" ? window.resetsAt : undefined;
  return { utilization: Math.min(Math.max(utilization, 0), 1), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * A usage window as it stands at `nowMs`: once its reset time has passed it is empty, whatever the
 * last report said. Claude Code only reports a window when a call is made, so between the reset and
 * the next prompt the newest reading is the old window's; the gauge goes back to zero instead.
 */
export function windowNow<T extends { utilization: number; resetsAt?: number }>(window: T, nowMs = Date.now()): T {
  return window.resetsAt !== undefined && nowMs >= window.resetsAt * 1000 ? { ...window, utilization: 0 } : window;
}

type Line = Record<string, unknown>;

interface Usage {
  input: number;
  output: number;
}

/** Which stage a tool call belongs to: the app's TurnProgress.stage(forTool:input:). */
export function stageForTool(name: string, input: unknown): StageName {
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) return "writing";
  if (name !== "Bash") return "tools";
  const command = typeof (input as { command?: unknown } | undefined)?.command === "string" ? ((input as { command: string }).command) : "";
  // An upload by hand (altool or Transporter) is a flight too: its success clears a script run that failed.
  const upload = (command.includes("altool") && (command.includes("--upload-app") || command.includes("--upload-package"))) || command.includes("iTMSTransporter");
  if (isReleaseScript(command) || upload) return "flight";
  if (command.includes("xcodebuild") && command.split(" ").includes("test")) return "testing";
  if (command.includes("npm test") || command.includes("--test") || command.startsWith("pytest") || command.includes(" test ")) return "testing";
  return "tools";
}

/** The lamp a pipeline line lights: the app's Stage(pipeline:). */
export function stageForPipeline(stage: unknown): StageName | null {
  switch (stage) {
    case "commit": return "commit";
    case "build": case "deploy": case "migration": return "build";
    case "archive": case "apple": case "installed": return "flight";
    default: return null;
  }
}

/** What a session is on right now, for the phone's session list: a stage and how it is going. */
export interface SessionNow {
  stage: StageName;
  status: TurnStatus;
}

/**
 * A session's stage for the list: the turn in flight's hot stage; between turns, a release script
 * still running in the background (a flight that outlives its turn); otherwise how the last turn
 * ended. Null for a session with nothing on record since the daemon started.
 */
export function sessionNow(turn: TurnActivityState | null, background: StageName[], lastEnd: { stage?: unknown; status?: unknown } | null): SessionNow | null {
  if (turn) return { stage: turn.stage, status: turn.status };
  const after = background.at(-1);
  if (after) return { stage: after, status: "working" };
  if (lastEnd && STAGES.includes(lastEnd.stage as StageName)) {
    return { stage: lastEnd.stage as StageName, status: (lastEnd.status as TurnStatus) ?? "done" };
  }
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageOf(u: unknown): Usage | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  return {
    input: num(o.input_tokens) + num(o.cache_read_input_tokens) + num(o.cache_creation_input_tokens),
    output: num(o.output_tokens),
  };
}

export class TurnTracker {
  private hot: StageName = "prompt";
  private status: TurnStatus = "working";
  private readonly touched = new Set<StageName>(["prompt"]);
  private readonly failed = new Set<StageName>();
  /** Permission requests waiting on the user: the stage each is about, and what it asks. */
  private readonly waiting = new Map<string, { stage: StageName; ask: string }>();
  /** Each model call's usage, by message id: partial messages repeat a message, so it is kept, not summed. */
  private readonly calls = new Map<string, Usage>();
  private currentMessage: string | null = null;
  /** The result's own tally, once it comes: authoritative. */
  private final: Usage | null = null;
  private endedAt: number | undefined;
  private detail = "";
  private record: string | undefined;
  private meter: { utilization: number; resetsAt?: number } | null;

  /** `meter`: the newest five-hour figure known when the turn began, from any session. `now`: the clock, for the meter's reset. */
  constructor(readonly startedAt: number, meter: { utilization: number; resetsAt?: number } | null = null, private readonly now: () => number = Date.now) {
    this.meter = meter;
  }

  get finished(): boolean {
    return this.endedAt !== undefined;
  }

  feed(line: Line): void {
    if (this.finished) return;
    switch (line.type) {
      case "stream_event":
        this.streamEvent(line.event as Line | undefined);
        break;
      case "assistant":
        this.assistant(line);
        break;
      case "control_request": {
        const req = line.request as Line | undefined;
        if (req?.subtype === "can_use_tool" && typeof line.request_id === "string") {
          const stage = stageForTool(String(req.tool_name ?? ""), req.input);
          this.waiting.set(line.request_id, { stage, ask: askLine(req) });
          this.touch(stage);
        }
        break;
      }
      case "pipeline": {
        const stage = stageForPipeline(line.stage);
        if (!stage) break;
        this.touch(stage);
        if (line.status === "running") this.hot = stage;
        // A failed build that was then built again is a built one.
        if (line.status === "failed") {
          this.failed.add(stage);
          this.detail = typeof line.detail === "string" ? line.detail : typeof line.title === "string" ? line.title : "";
        } else if (line.status === "done") {
          this.failed.delete(stage);
          if (this.failed.size === 0) this.detail = "";
        }
        break;
      }
      case "preview":
        this.touch("preview");
        if (line.status === "capturing") this.hot = "preview";
        break;
      case "host":
        if (line.subtype === "permission_response" && typeof line.request_id === "string") this.waiting.delete(line.request_id);
        if (line.subtype === "turn_ended") this.end("stopped");
        break;
      case "rate_limit_event":
        this.meter = sessionMeter(line) ?? this.meter;
        break;
      case "result": {
        this.final = usageOf(line.usage);
        const interrupted = line.terminal_reason === "aborted_streaming";
        this.end(interrupted ? "stopped" : line.subtype === "success" ? "done" : "failed");
        break;
      }
    }
  }

  /** The upload broke the record: the line the card shows. */
  setRecord(record: string): void {
    this.record = record;
  }

  private streamEvent(event: Line | undefined): void {
    if (!event) return;
    if (event.type === "message_start") {
      const message = event.message as Line | undefined;
      const id = typeof message?.id === "string" ? message.id : null;
      this.currentMessage = id;
      const u = usageOf(message?.usage);
      if (id && u) this.calls.set(id, u);
      // A model call under way and nothing else lit: it is thinking, as the app says.
      this.hot = "thinking";
      this.touch("thinking");
    } else if (event.type === "message_delta") {
      const u = usageOf(event.usage);
      if (this.currentMessage && u) {
        const known = this.calls.get(this.currentMessage) ?? { input: 0, output: 0 };
        this.calls.set(this.currentMessage, { input: Math.max(known.input, u.input), output: Math.max(known.output, u.output) });
      }
    } else if (event.type === "content_block_start") {
      const block = event.content_block as Line | undefined;
      if (block?.type === "thinking") {
        this.hot = "thinking";
        this.touch("thinking");
      }
    }
  }

  private assistant(line: Line): void {
    const message = line.message as Line | undefined;
    const id = typeof message?.id === "string" ? message.id : null;
    const u = usageOf(message?.usage);
    if (id && u) {
      const known = this.calls.get(id) ?? { input: 0, output: 0 };
      this.calls.set(id, { input: Math.max(known.input, u.input), output: Math.max(known.output, u.output) });
    }
    const content = Array.isArray(message?.content) ? (message!.content as Line[]) : [];
    for (const block of content) {
      if (block.type === "tool_use") {
        const stage = stageForTool(String(block.name ?? ""), block.input);
        this.hot = stage;
        this.touch(stage);
      } else if (block.type === "thinking") {
        this.touch("thinking");
      }
    }
  }

  private touch(stage: StageName): void {
    this.touched.add(stage);
  }

  private end(status: TurnStatus): void {
    if (this.finished) return;
    this.status = status;
    this.endedAt = Math.floor(Date.now() / 1000);
    this.waiting.clear();
    this.hot = "done";
    if (status === "done") this.touch("done");
  }

  get state(): TurnActivityState {
    const sum = [...this.calls.values()].reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output }), { input: 0, output: 0 });
    const usage = this.final && this.final.input + this.final.output >= sum.input + sum.output ? this.final : sum;
    let stage = this.hot;
    let status = this.status;
    let asking: { requestId: string; ask: string } | null = null;
    if (!this.finished) {
      // What matters most right now: a failure, then a wait on the user, then what is running.
      const failed = STAGES.find((s) => this.failed.has(s));
      const waiting = [...this.waiting.entries()][0];
      if (failed) {
        stage = failed;
        status = "failed";
      } else if (waiting) {
        stage = waiting[1].stage;
        status = "waiting";
        asking = { requestId: waiting[0], ask: waiting[1].ask };
      }
    }
    return {
      stage,
      status,
      tokens: usage.input + usage.output,
      output: usage.output,
      startedAt: this.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      lit: STAGES.filter((s) => this.touched.has(s)),
      detail: this.detail,
      ...(this.record ? { record: this.record } : {}),
      ...(this.meter ? { session: windowNow(this.meter, this.now()).utilization, ...(this.meter.resetsAt !== undefined ? { sessionResetsAt: this.meter.resetsAt } : {}) } : {}),
      ...(asking ?? {}),
    };
  }
}

/**
 * When to push. A new stage or status goes at once, unless the last push was under `gap` ago, in
 * which case it goes when the gap is up (the newest state, not each one between). The token count
 * alone is sent no more than every `tokenGap`.
 */
export class TurnActivityPacer {
  private last: TurnActivityState | null = null;
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly read: () => TurnActivityState,
    private readonly send: (state: TurnActivityState, important: boolean) => void,
    private readonly gap = 5_000,
    private readonly tokenGap = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The state has (maybe) changed. */
  poke(): void {
    const state = this.read();
    const important = this.isImportant(state);
    const tokensMoved = !this.last || state.tokens !== this.last.tokens || state.session !== this.last.session;
    if (!important && !tokensMoved) return;
    const wait = (important ? this.gap : this.tokenGap) - (this.now() - this.lastAt);
    if (wait <= 0) {
      this.flush();
      return;
    }
    if (this.timer) {
      // An important change shortens a wait that was only for the tokens.
      if (!important) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Sent at the start: the baseline later changes are measured against. */
  started(state: TurnActivityState): void {
    this.last = state;
    this.lastAt = this.now();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private isImportant(state: TurnActivityState): boolean {
    const l = this.last;
    return !l || l.stage !== state.stage || l.status !== state.status || l.lit.length !== state.lit.length || l.detail !== state.detail || l.record !== state.record || l.requestId !== state.requestId;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const state = this.read();
    const important = this.isImportant(state);
    if (!important && this.last && state.tokens === this.last.tokens && state.session === this.last.session) return;
    this.last = state;
    this.lastAt = this.now();
    this.send(state, important);
  }
}
