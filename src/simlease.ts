// Turns on the simulator. Sessions and the daemon's rounds all install, launch and shoot on the one
// simulator, so whoever drives it holds the lease in DATA_DIR first; scripts/sim keeps it (and is
// the sessions' PreToolUse hook), so the daemon goes through the same script rather than a second
// copy of the rules. A round holds the lease as the daemon (its pid) and gives it back when done; a
// session's lease, held by its `claude`, is given back when its turn ends.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sim");
/** A round can run a while (every screen, each posed, with clips); the daemon being alive is what counts. */
const ROUND_IDLE_S = 30 * 60;

function sim(args: string[], timeoutMs: number): Promise<unknown> {
  return run("python3", [SCRIPT, ...args], { env: { ...process.env, DATA_DIR: config.dataDir }, timeout: timeoutMs });
}

/**
 * Wait up to `waitMs` for the simulator and take it for the daemon. True once held; false if
 * someone else kept it that long. Without the script (a checkout that doesn't ship it), always true.
 */
export async function claim(label: string, waitMs: number): Promise<boolean> {
  if (!fs.existsSync(SCRIPT)) return true;
  try {
    await sim(["claim", "--pid", String(process.pid), "--label", label, "--wait", String(waitMs / 1000), "--idle", String(ROUND_IDLE_S)], waitMs + 30_000);
    return true;
  } catch {
    return false;
  }
}

/** Give the lease back: the daemon's, or a session's (its `claude` pid) once its turn is over. */
export async function release(pid: number = process.pid): Promise<void> {
  if (!fs.existsSync(SCRIPT)) return;
  await sim(["release", "--pid", String(pid)], 15_000).catch(() => undefined);
}

/** Run `fn` holding the simulator, waiting up to `waitMs` for it; null, without running it, if it stayed busy. */
export async function holding<T>(label: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
  if (!(await claim(label, waitMs))) return null;
  try {
    return await fn();
  } finally {
    await release();
  }
}
