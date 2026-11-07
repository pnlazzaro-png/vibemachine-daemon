// One Claude Code child per session: `claude -p` speaking stream-json both
// ways, run under the user's own claude.ai sign-in (no API key). It emits Claude
// Code's stream-json events, plus control requests for permission prompts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config, toolPath } from "./config.js";
import type { ContentBlock } from "./attachments.js";

/** The CLI said no to a control request (a model or permission mode it won't switch to). */
export class RefusedError extends Error {}
/** The CLI itself can't be run here (not installed, wrong path): a setup problem, not a request's. */
export class UnavailableError extends Error {}

export type Line = Record<string, unknown> & { type: string };

/** `--effort` levels the CLI takes. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  display_name?: string;
  input: unknown;
  description?: string;
  tool_use_id?: string;
  permission_suggestions?: unknown[];
  blocked_path?: string;
  decision_reason?: string;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string };

export interface ClaudeSessionOptions {
  id: string;
  cwd: string;
  model?: string;
  /** Only set at spawn: there is no control request for it, so a change means a new child. */
  effort?: string;
  permissionMode?: string;
  /** true: `--resume <id>`; false: `--session-id <id>` (brand new). */
  resume: boolean;
}

export interface ClaudeSessionEvents {
  line: [Line];
  permission: [PermissionRequest];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  stderr: [string];
}

export class ClaudeSession extends EventEmitter<ClaudeSessionEvents> {
  readonly id: string;
  readonly cwd: string;
  readonly pending = new Map<string, PermissionRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private readonly opts: ClaudeSessionOptions;
  /** Control requests the host sent, awaiting a control_response. */
  private readonly waiting = new Map<string, (response: unknown) => void>();
  exited = false;
  /** Why the child never ran, when it didn't. */
  private startError: string | null = null;

  constructor(opts: ClaudeSessionOptions) {
    super();
    this.opts = opts;
    this.id = opts.id;
    this.cwd = opts.cwd;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  static args(opts: ClaudeSessionOptions): string[] {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      // Both are needed: the first is the policy, the second routes the
      // prompts to us over stdio. Without the second every prompt is denied.
      "--permission-prompts", "host",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", opts.permissionMode ?? config.defaultPermissionMode,
      // Lets the phone's "never" key switch a running session to bypassPermissions; without it the
      // CLI refuses set_permission_mode (bypass_not_launched). It starts nothing in bypass by itself.
      "--allow-dangerously-skip-permissions",
      // The daemon's screenshots live outside the repo; in scope, a Read of one doesn't prompt.
      "--add-dir", path.join(config.dataDir, "captures"),
    ];
    const model = opts.model ?? (config.defaultModel || undefined);
    if (model) args.push("--model", model);
    if (opts.effort) args.push("--effort", opts.effort);
    args.push(opts.resume ? "--resume" : "--session-id", opts.id);
    return args;
  }

  start(): void {
    if (this.child) throw new Error("already started");
    const child = spawn(config.claudeBin, ClaudeSession.args(this.opts), {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: toolPath,
        // Claude Code refuses to nest inside another Claude Code session.
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
      },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    child.on("exit", (code, signal) => this.finish(code, signal));
    // No such binary, or it can't be run: Node reports it here and may never say "exit".
    child.on("error", (err) => {
      this.startError = `couldn't run ${config.claudeBin}: ${err.message} (install Claude Code, set CLAUDE_BIN in .env, or run \`vibemachine doctor\`)`;
      this.emit("stderr", this.startError);
      this.finish(null, null);
    });
    // Writing to a child that has just gone would otherwise throw from the socket.
    child.stdin.on("error", (err) => this.emit("stderr", `stdin: ${err.message}`));
    // The handshake that makes the CLI treat us as the SDK host.
    void this.control({ subtype: "initialize" });
  }

  /** Send a user turn: a string, or text and image blocks. Its echo (`user`, isReplay) comes back on stdout. */
  prompt(content: string | ContentBlock[]): void {
    this.write({ type: "user", message: { role: "user", content } });
  }

  answer(requestId: string, decision: PermissionDecision): boolean {
    const req = this.pending.get(requestId);
    if (!req) return false;
    this.pending.delete(requestId);
    const response =
      decision.behavior === "allow"
        ? {
            behavior: "allow",
            updatedInput: decision.updatedInput ?? req.input,
            ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
          }
        : { behavior: "deny", message: decision.message };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    return true;
  }

  async interrupt(): Promise<unknown> {
    return this.control({ subtype: "interrupt" });
  }

  /** Switch the permission mode at once; the CLI confirms or refuses (auto isn't offered on every model). */
  async setPermissionMode(mode: string): Promise<void> {
    const response = (await this.control({ subtype: "set_permission_mode", mode })) as { subtype?: unknown; error?: unknown } | undefined;
    if (response?.subtype === "error") throw new RefusedError(typeof response.error === "string" ? response.error : `the CLI refused ${mode}`);
  }

  /** Switch the model for the next request; the CLI confirms or refuses. */
  async setModel(model: string): Promise<void> {
    const response = (await this.control({ subtype: "set_model", model })) as { subtype?: unknown; error?: unknown } | undefined;
    if (response?.subtype === "error") throw new RefusedError(typeof response.error === "string" ? response.error : "the CLI refused the model");
  }

  /** Close stdin; the CLI finishes the current turn and exits 0. */
  end(): void {
    this.child?.stdin.end();
  }

  /** SIGTERM, then SIGKILL if it's still there: a CLI wedged on a dead stream ignores SIGTERM (2.1.281). */
  kill(): void {
    if (!this.child || this.exited) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.exited) this.child?.kill("SIGKILL");
    }, 3_000).unref();
  }

  private control(request: Record<string, unknown>): Promise<unknown> {
    const request_id = `host-${randomUUID()}`;
    return new Promise((resolve) => {
      this.waiting.set(request_id, resolve);
      this.write({ type: "control_request", request_id, request });
    });
  }

  /** The child is gone, however it went: settle every waiter once and tell the session. */
  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    if (this.buffer.trim()) this.onData("\n");
    for (const resolve of this.waiting.values()) resolve({ error: "process exited" });
    this.waiting.clear();
    this.emit("exit", { code, signal });
  }

  private write(obj: unknown): void {
    if (this.startError) throw new UnavailableError(this.startError);
    if (!this.child || this.exited || !this.child.stdin.writable) throw new Error("session process is not running");
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const raw = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!raw) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        this.emit("stderr", `unparsable stdout line: ${raw.slice(0, 200)}\n`);
        continue;
      }
      this.route(line);
    }
  }

  private route(line: Line): void {
    if (line.type === "control_request") {
      const request = (line.request ?? {}) as Record<string, unknown>;
      const request_id = String(line.request_id);
      if (request.subtype === "can_use_tool") {
        const req: PermissionRequest = { ...(request as Omit<PermissionRequest, "request_id">), request_id } as PermissionRequest;
        this.pending.set(request_id, req);
        this.emit("line", line);
        this.emit("permission", req);
      } else {
        // Hooks, MCP and other host services we don't offer: acknowledge empty.
        this.write({ type: "control_response", response: { subtype: "success", request_id, response: {} } });
        this.emit("line", line);
      }
      return;
    }
    if (line.type === "control_response") {
      const response = (line.response ?? {}) as Record<string, unknown>;
      const id = String(response.request_id);
      const resolve = this.waiting.get(id);
      if (resolve) {
        this.waiting.delete(id);
        // The whole response: `subtype` says success or error, `response` carries the payload.
        resolve(response);
      }
    }
    this.emit("line", line);
  }
}
