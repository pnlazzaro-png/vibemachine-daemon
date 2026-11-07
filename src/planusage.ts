// The plan's usage windows as the Claude app shows them: the session, the
// week, and each per-model week (Fable). A rate_limit_event only carries the
// first two, once per process; Claude Code's `get_usage` control request asks
// the account itself and lists the per-model ones in `model_scoped`. A short
// child answers it (no prompt, no model call, no transcript) and the answer is
// kept for a minute.
import { spawn } from "node:child_process";
import { config, toolPath } from "./config.js";

export interface PlanWindow {
  /** 0…1, as the rate_limit_event reports it (get_usage says percent). */
  utilization: number;
  resets_at: string | null;
}

export interface PlanUsage {
  five_hour: PlanWindow | null;
  seven_day: PlanWindow | null;
  /** Per-model weekly windows, named as the server names them ("Fable"). */
  models: (PlanWindow & { name: string })[];
  at: string;
}

const FRESH_MS = 60_000;
const TIMEOUT_MS = 20_000;

/** get_usage's `rate_limits` into windows; null when the plan has none (an API key). */
export function parsePlanUsage(rateLimits: unknown, at: string): PlanUsage | null {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const r = rateLimits as Record<string, unknown>;
  const window = (v: unknown): PlanWindow | null => {
    if (!v || typeof v !== "object") return null;
    const { utilization, resets_at } = v as { utilization?: unknown; resets_at?: unknown };
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
    return { utilization: utilization / 100, resets_at: typeof resets_at === "string" ? new Date(resets_at).toISOString() : null };
  };
  const models = (Array.isArray(r.model_scoped) ? r.model_scoped : []).flatMap((m: unknown) => {
    const name = (m as { display_name?: unknown } | null)?.display_name;
    const w = window(m);
    return typeof name === "string" && w ? [{ name, ...w }] : [];
  });
  return { five_hour: window(r.five_hour), seven_day: window(r.seven_day), models, at };
}

/** One short child: the SDK handshake, then get_usage. Rejects on a refusal, a dead child or a timeout. */
function ask(): Promise<PlanUsage | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      cwd: config.dataDir,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, PATH: toolPath, CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined },
    });
    let buffer = "";
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      fn();
    };
    const timer = setTimeout(() => settle(() => reject(new Error("get_usage timed out"))), TIMEOUT_MS);
    child.on("error", (err) => settle(() => reject(err)));
    child.on("exit", () => settle(() => reject(new Error("claude exited before answering get_usage"))));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let line: { type?: string; response?: { subtype?: string; request_id?: string; error?: string; response?: { rate_limits?: unknown } } };
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        if (line.type !== "control_response" || line.response?.request_id !== "usage") continue;
        const r = line.response;
        settle(() => (r.subtype === "success" ? resolve(parsePlanUsage(r.response?.rate_limits, new Date().toISOString())) : reject(new Error(r.error ?? "get_usage refused"))));
      }
    });
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
    send({ type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } });
  });
}

let latest: PlanUsage | null = null;
let fetchedAt = 0;
let inFlight: Promise<PlanUsage | null> | null = null;

function refresh(): Promise<PlanUsage | null> {
  inFlight ??= ask()
    .then((u) => {
      latest = u;
      fetchedAt = Date.now();
      return u;
    })
    .catch((err: Error) => {
      console.error(`plan usage: ${err.message}`);
      fetchedAt = Date.now(); // don't ask again on every request while it's failing
      return latest;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** The plan's windows: the kept answer at once (asking again behind it when it's over a minute old), or the first answer. */
export async function planUsage(): Promise<PlanUsage | null> {
  if (Date.now() - fetchedAt < FRESH_MS) return latest;
  const next = refresh();
  return latest ?? next;
}
