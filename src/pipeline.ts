// The pipeline around a turn. Today: commits Claude made in the session's
// repo, found by comparing HEAD before and after. Build, deploy, migration,
// archive, Apple and installed stages arrive through POST /sessions/:id/pipeline
// from project scripts until each has a watcher of its own.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Stage = "commit" | "build" | "deploy" | "migration" | "archive" | "apple" | "installed";
export type StageStatus = "running" | "done" | "failed";
export const STAGES: readonly Stage[] = ["commit", "build", "deploy", "migration", "archive", "apple", "installed"];
export const STAGE_STATUSES: readonly StageStatus[] = ["running", "done", "failed"];

export interface PipelineLine {
  type: "pipeline";
  stage: Stage;
  status: StageStatus;
  title: string;
  detail?: string;
  log?: string;
  /** For commits: the sha, so a stage is never reported twice. */
  ref?: string;
  ts: string;
  [k: string]: unknown;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

export async function gitHead(cwd: string): Promise<string | null> {
  const out = await git(cwd, "rev-parse", "HEAD");
  return out ? out.trim() : null;
}

/** Commits reachable from HEAD but not from `since`, oldest first. */
export async function commitsSince(cwd: string, since: string | null): Promise<PipelineLine[]> {
  const head = await gitHead(cwd);
  if (!head || head === since) return [];
  const range = since ? `${since}..HEAD` : "HEAD";
  const list = await git(cwd, "log", "--reverse", "--format=%H%x09%h%x09%s", range);
  if (!list) return [];
  const lines: PipelineLine[] = [];
  for (const row of list.split("\n").filter(Boolean)) {
    const [sha = "", short = "", subject = ""] = row.split("\t");
    const stat = (await git(cwd, "show", "--stat", "--format=", sha)) ?? "";
    const summary = stat.trim().split("\n").pop()?.trim() ?? "";
    const show = (await git(cwd, "show", "--format=medium", "--stat", "--patch", sha)) ?? "";
    lines.push({
      type: "pipeline",
      stage: "commit",
      status: "done",
      title: `${short} ${subject}`,
      detail: summary,
      log: show.length > 60_000 ? show.slice(0, 60_000) + "\n…" : show,
      ref: sha,
      ts: new Date().toISOString(),
    });
  }
  return lines;
}
