// A prompt queued while a TestFlight upload runs stops the upload, so the newer change ships with
// it in one build instead of two (decided 2026-10-27). Only early on, while it runs the tests
// or the archive (about the first two and a half of its four minutes): once it has reached the
// last step, the hand-off to Apple (`xcodebuild -exportArchive`, about a minute and a half), it is
// left to finish, since stopping it would save little and lose a build that's nearly there. The
// script is found among the session child's descendants and signalled with everything it started;
// its TERM trap says so in its output and hands the release notes back to "next", and the queued
// prompt's turn ships both.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** `ps` output as rows: pid, parent, the whole command line. */
export function parsePs(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

/**
 * The release script itself, as the kernel runs it (`/bin/bash ./scripts/testflight.sh`, or the
 * script's own path first), not the tool's `zsh -c "… testflight.sh > log"` wrapper around it:
 * stopping the wrapper would lose the script's last words.
 */
export function isUploadScript(command: string): boolean {
  const [first = "", second = ""] = command.trim().split(/\s+/);
  const script = /(^|\/)testflight\.sh$/;
  if (script.test(first)) return true;
  return /(^|\/)(ba|z)?sh$/.test(first) && script.test(second);
}

/** The upload's last step, the hand-off to Apple: past this point the upload is left to finish. */
export function isHandOff(command: string): boolean {
  return /(^|\/)xcodebuild\s/.test(command) && /\s-exportArchive(\s|$)/.test(command);
}

/**
 * Every upload script under `root` still in its early steps, with all it started: what to signal,
 * children first. A script already handing its build to Apple is left alone.
 */
export function uploadsToStop(rows: ProcessRow[], root: number): number[] {
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  const below = (pid: number): number[] => (children.get(pid) ?? []).flatMap((c) => [...below(c.pid), c.pid]);
  const found: number[] = [];
  const walk = (pid: number): void => {
    for (const c of children.get(pid) ?? []) {
      if (isUploadScript(c.command)) {
        const started = below(c.pid);
        const handingOff = rows.some((r) => started.includes(r.pid) && isHandOff(r.command));
        if (!handingOff) found.push(...started, c.pid);
      }
      else walk(c.pid);
    }
  };
  walk(root);
  return found;
}

/** Stops any upload running under the session's child; resolves to how many processes were signalled. */
export async function stopUploads(root: number | undefined): Promise<number> {
  if (!root) return 0;
  const { stdout } = await run("/bin/ps", ["-Ao", "pid=,ppid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  const pids = uploadsToStop(parsePs(stdout), root);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  return pids.length;
}
