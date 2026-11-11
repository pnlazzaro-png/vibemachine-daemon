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

const GIT_BUFFER = 4 * 1024 * 1024;

async function git(cwd: string, maxBuffer: number, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer });
    return stdout;
  } catch {
    return null;
  }
}

export async function gitHead(cwd: string): Promise<string | null> {
  const out = await git(cwd, GIT_BUFFER, "rev-parse", "HEAD");
  return out ? out.trim() : null;
}

/** How many of a turn's newest commits get a line, a diff and two `git show` each. */
export const COMMIT_DETAIL_MAX = 5;
const LOG_MAX = 60_000;

export interface CommitLines {
  /** Oldest first: one line for the older commits together when there are too many, then the newest few each with its diff. */
  lines: PipelineLine[];
  /** Every commit the lines cover, so none is reported twice. */
  shas: string[];
}

/**
 * Commits reachable from HEAD but not from `since`, less the ones in `seen`. A turn that moves HEAD
 * across many (a pull, a rebase, a first clone) gets the newest `detailMax` in full and one line for
 * the rest: a line and two `git show` for each of 300 held the turn's end back 15 seconds.
 *
 * The line for the rest is a commit line like the others but with no `ref`, which is what the phone
 * takes for a commit with a diff to open; its log lists them, newest first.
 */
export async function commitsSince(cwd: string, since: string | null, seen: ReadonlySet<string> = new Set(), detailMax = COMMIT_DETAIL_MAX): Promise<CommitLines> {
  const head = await gitHead(cwd);
  if (!head || head === since) return { lines: [], shas: [] };
  const range = since ? `${since}..HEAD` : "HEAD";
  const list = await git(cwd, 64 * 1024 * 1024, "log", "--reverse", "--format=%H%x09%h%x09%s", range);
  if (!list) return { lines: [], shas: [] };
  const rows = list
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [sha = "", short = "", subject = ""] = row.split("\t");
      return { sha, short, subject };
    })
    .filter((c) => c.sha && !seen.has(c.sha));
  const cut = Math.max(0, rows.length - Math.max(0, detailMax));
  const rest = rows.slice(0, cut);
  const lines: PipelineLine[] = [];
  if (rest.length > 0) {
    let log = "";
    let listed = 0;
    for (const c of rest.toReversed()) {
      const next = `${c.short} ${c.subject}\n`;
      if (log.length + next.length > LOG_MAX) break;
      log += next;
      listed += 1;
    }
    if (listed < rest.length) log += `… and ${rest.length - listed} older\n`;
    lines.push({
      type: "pipeline",
      stage: "commit",
      status: "done",
      title: `${rest.length} earlier ${rest.length === 1 ? "commit" : "commits"}`,
      detail: rest.length === 1 ? rest[0]!.short : `${rest[0]!.short}..${rest.at(-1)!.short}`,
      log,
      count: rest.length,
      ts: new Date().toISOString(),
    });
  }
  for (const { sha, short, subject } of rows.slice(cut)) {
    const stat = (await git(cwd, GIT_BUFFER, "show", "--stat", "--format=", sha)) ?? "";
    const summary = stat.trim().split("\n").pop()?.trim() ?? "";
    const show = (await git(cwd, GIT_BUFFER, "show", "--format=medium", "--stat", "--patch", sha)) ?? "";
    lines.push({
      type: "pipeline",
      stage: "commit",
      status: "done",
      title: `${short} ${subject}`,
      detail: summary,
      log: show.length > LOG_MAX ? show.slice(0, LOG_MAX) + "\n…" : show,
      ref: sha,
      ts: new Date().toISOString(),
    });
  }
  return { lines, shas: rows.map((c) => c.sha) };
}
