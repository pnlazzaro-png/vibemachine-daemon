// The stats page's numbers, read off the usage ledger (usage.ts) for a span
// of time: totals and the span before them, a series by day or month split
// by model, the work by project and by who was driving, the tools, what the
// pipeline shipped, the arcade's high scores, the punch card of when the
// prompts came, where the plan's windows stand, and every project's commits
// ever, from git. All in one reply, so the phone draws the page from a
// single GET.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "./db.js";
import { windowNow } from "./turnactivity.js";
import type { PlanUsage } from "./planusage.js";
import { localDay } from "./usage.js";

export interface StatsQuery {
  /** ISO instants; null `since` means from the first call on record, null `until` means now. */
  since: string | null;
  until: string | null;
  bucket: "day" | "month";
  /** Only this project (its cwd). */
  cwd: string | null;
}

interface Totals {
  cost_usd: number;
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  thinking: number;
  tokens: number;
  unpriced: number;
  sessions: number;
  prompts: number;
  tools: number;
  tool_errors: number;
  interrupts: number;
  turns: number;
  turn_ms: number;
}

interface Bucket {
  bucket: string;
  cost_usd: number;
  tokens: number;
  output: number;
  prompts: number;
  models: Record<string, { cost_usd: number; tokens: number; output: number }>;
}

export interface Score {
  label: string;
  value: string;
  detail: string;
  /** What kind of number, so the phone can pick a lens. */
  kind: "cost" | "time" | "count" | "streak";
  /** The project the feat belongs to (its folder name), for the arcade's initials; null for a span-wide feat. */
  project: string | null;
  /** The measure behind `value` (dollars, milliseconds, a count), so the phone can tell a new record. */
  n: number;
  /** Which way beats the record. */
  better: "high" | "low";
}

/** One thing the span shipped, for the ticker along the foot of the stats page. */
export interface ShippedItem {
  ts: string;
  kind: "commit" | "build" | "testflight" | "deploy";
  /** The project's folder name. */
  project: string;
  /** A commit's short hash and subject, from git; null for a build, an upload or a deploy. */
  title: string | null;
  /** A run of the same untitled thing in a row (four builds while a change was tried) is one item. */
  count: number;
}

export interface StatsReport {
  range: { since: string; until: string; bucket: "day" | "month"; cwd: string | null };
  totals: Totals;
  previous: { cost_usd: number; tokens: number; prompts: number } | null;
  series: Bucket[];
  models: { model: string; cost_usd: number; requests: number; input: number; output: number; cache_read: number; cache_write: number; thinking: number }[];
  projects: { cwd: string; name: string; cost_usd: number; tokens: number; sessions: number; prompts: number; tools: number; commits: number; builds: number; builds_failed: number; tests: number }[];
  sources: { source: string; cost_usd: number; sessions: number; prompts: number }[];
  tools: { tool: string; count: number; errors: number }[];
  stages: Record<string, { done: number; failed: number; open: number }>;
  scores: Score[];
  /** Prompts by weekday (0 is Sunday) and hour, in the Mac's local time: the punch card. */
  punch: number[][];
  /** The plan's windows: the session, the week, and each per-model week (`models`, e.g. Fable). */
  windows: { five_hour: Window | null; seven_day: Window | null; models: (Window & { name: string })[]; at: string | null };
  /** The span's commits, builds, uploads and deploys that went through, newest first. */
  shipped: ShippedItem[];
  /** Every project's commits ever (the span doesn't narrow it), most first: see `repoCommits`. */
  repos: RepoCommits[];
}

/** A project's whole history in git: every commit on its branch, and how many say Claude co-wrote them. */
type Window = { utilization: number; resets_at: string | null };

export interface RepoCommits {
  cwd: string;
  name: string;
  commits: number;
  /** Commits carrying a `Co-Authored-By: Claude` line. */
  claude: number;
  /** The first commit's date (ISO). */
  first: string | null;
}

const EMPTY_TOTALS: Totals = {
  cost_usd: 0, requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, thinking: 0, tokens: 0, unpriced: 0,
  sessions: 0, prompts: 0, tools: 0, tool_errors: 0, interrupts: 0, turns: 0, turn_ms: 0,
};

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** `clockMs`: now, for the usage windows' resets. `plan`: the account's own windows (planusage.ts), fresher than the last rate_limit_event and the only source of the per-model ones. */
export function statsReport(store: Store, q: StatsQuery, clockMs = Date.now(), plan: PlanUsage | null = null): StatsReport {
  const db = store.db;
  // All time starts at the first thing on record, a prompt as much as a call: a ship is timed from its prompt.
  const first = (db.prepare(`SELECT min(ts) AS ts FROM (SELECT min(ts) AS ts FROM usage UNION ALL SELECT min(ts) FROM activity)`).get() as { ts: string | null }).ts;
  const until = q.until ?? new Date().toISOString();
  const since = q.since ?? first ?? until;
  const where = (alias: string) => `${alias}.ts >= ? AND ${alias}.ts < ?` + (q.cwd ? ` AND ${alias}.cwd = ?` : "");
  const args = (s: string, u: string) => (q.cwd ? [s, u, q.cwd] : [s, u]);

  const totals = (s: string, u: string): Totals => {
    const usage = db
      .prepare(
        `SELECT count(*) AS requests, coalesce(sum(cost_usd), 0) AS cost_usd, coalesce(sum(input), 0) AS input, coalesce(sum(output), 0) AS output,
                coalesce(sum(cache_read), 0) AS cache_read, coalesce(sum(cache_write_5m + cache_write_1h), 0) AS cache_write, coalesce(sum(thinking), 0) AS thinking,
                sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced, count(DISTINCT session_id) AS sessions
         FROM usage u WHERE ${where("u")}`,
      )
      .get(...args(s, u)) as Record<string, unknown>;
    const activity = db
      .prepare(`SELECT kind, count(*) AS count, coalesce(sum(value), 0) AS value, sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed FROM activity a WHERE ${where("a")} GROUP BY kind`)
      .all(...args(s, u)) as { kind: string; count: number; value: number; failed: number }[];
    const byKind = Object.fromEntries(activity.map((r) => [r.kind, r]));
    const t: Totals = {
      ...EMPTY_TOTALS,
      requests: n(usage.requests),
      cost_usd: n(usage.cost_usd),
      input: n(usage.input),
      output: n(usage.output),
      cache_read: n(usage.cache_read),
      cache_write: n(usage.cache_write),
      thinking: n(usage.thinking),
      unpriced: n(usage.unpriced),
      sessions: n(usage.sessions),
      prompts: n(byKind.prompt?.count),
      tools: n(byKind.tool?.count),
      tool_errors: n(byKind.tool?.failed),
      interrupts: n(byKind.interrupt?.count),
      turns: n(byKind.turn?.count),
      turn_ms: n(byKind.turn?.value),
    };
    t.tokens = t.input + t.output + t.cache_read + t.cache_write;
    return t;
  };

  const now = totals(since, until);
  let previous: StatsReport["previous"] = null;
  if (q.since) {
    const span = new Date(until).getTime() - new Date(since).getTime();
    if (span > 0) {
      const p = totals(new Date(new Date(since).getTime() - span).toISOString(), since);
      previous = { cost_usd: p.cost_usd, tokens: p.tokens, prompts: p.prompts };
    }
  }

  // The series: every bucket in the span, empty ones too, split by model.
  const key = q.bucket === "month" ? "substr(day, 1, 7)" : "day";
  const series = new Map<string, Bucket>();
  for (const b of bucketsBetween(since, until, q.bucket)) series.set(b, { bucket: b, cost_usd: 0, tokens: 0, output: 0, prompts: 0, models: {} });
  const perModel = db
    .prepare(
      `SELECT ${key} AS bucket, model, coalesce(sum(cost_usd), 0) AS cost_usd, sum(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens, sum(output) AS output
       FROM usage u WHERE ${where("u")} GROUP BY bucket, model ORDER BY bucket`,
    )
    .all(...args(since, until)) as { bucket: string; model: string; cost_usd: number; tokens: number; output: number }[];
  for (const r of perModel) {
    const b = series.get(r.bucket) ?? { bucket: r.bucket, cost_usd: 0, tokens: 0, output: 0, prompts: 0, models: {} };
    series.set(r.bucket, b);
    b.cost_usd += r.cost_usd;
    b.tokens += r.tokens;
    b.output += r.output;
    b.models[r.model] = { cost_usd: r.cost_usd, tokens: r.tokens, output: r.output };
  }
  const prompts = db
    .prepare(`SELECT ${key} AS bucket, count(*) AS prompts FROM activity a WHERE kind = 'prompt' AND ${where("a")} GROUP BY bucket`)
    .all(...args(since, until)) as { bucket: string; prompts: number }[];
  for (const r of prompts) {
    const b = series.get(r.bucket) ?? { bucket: r.bucket, cost_usd: 0, tokens: 0, output: 0, prompts: 0, models: {} };
    series.set(r.bucket, b);
    b.prompts = r.prompts;
  }

  const models = db
    .prepare(
      `SELECT model, coalesce(sum(cost_usd), 0) AS cost_usd, count(*) AS requests, sum(input) AS input, sum(output) AS output, sum(cache_read) AS cache_read,
              sum(cache_write_5m + cache_write_1h) AS cache_write, sum(thinking) AS thinking
       FROM usage u WHERE ${where("u")} GROUP BY model ORDER BY cost_usd DESC, requests DESC`,
    )
    .all(...args(since, until)) as StatsReport["models"];

  // By project: the calls, then the prompts and pipeline commands folded in.
  const projectRows = db
    .prepare(
      `SELECT cwd, coalesce(sum(cost_usd), 0) AS cost_usd, sum(input + output + cache_read + cache_write_5m + cache_write_1h) AS tokens, count(DISTINCT session_id) AS sessions
       FROM usage u WHERE ${where("u")} GROUP BY cwd`,
    )
    .all(...args(since, until)) as { cwd: string; cost_usd: number; tokens: number; sessions: number }[];
  const projects = new Map(projectRows.map((r) => [r.cwd, { cwd: r.cwd, name: projectName(r.cwd), cost_usd: r.cost_usd, tokens: r.tokens, sessions: r.sessions, prompts: 0, tools: 0, commits: 0, builds: 0, builds_failed: 0, tests: 0 }]));
  const projectActivity = db
    .prepare(
      `SELECT cwd, kind, stage, ok, count(*) AS count FROM activity a WHERE ${where("a")} AND kind IN ('prompt', 'tool') GROUP BY cwd, kind, stage, ok`,
    )
    .all(...args(since, until)) as { cwd: string; kind: string; stage: string | null; ok: number | null; count: number }[];
  for (const r of projectActivity) {
    let p = projects.get(r.cwd);
    if (!p) {
      p = { cwd: r.cwd, name: projectName(r.cwd), cost_usd: 0, tokens: 0, sessions: 0, prompts: 0, tools: 0, commits: 0, builds: 0, builds_failed: 0, tests: 0 };
      projects.set(r.cwd, p);
    }
    if (r.kind === "prompt") p.prompts += r.count;
    else {
      p.tools += r.count;
      if (r.stage === "commit" && r.ok === 1) p.commits += r.count;
      if (r.stage === "build" || r.stage === "archive") {
        if (r.ok === 1) p.builds += r.count;
        if (r.ok === 0) p.builds_failed += r.count;
      }
      if (r.stage === "test" && r.ok === 1) p.tests += r.count;
    }
  }

  // A commit made anywhere counts, as on the ticker: git's count for the span where it can read the project.
  for (const p of projects.values()) {
    const counted = git(p.cwd, ["rev-list", "--count", `--since=${since}`, `--until=${until}`, "HEAD"]);
    if (counted !== null) p.commits = Number(counted) || 0;
  }

  const sourceRows = db
    .prepare(`SELECT source, coalesce(sum(cost_usd), 0) AS cost_usd, count(DISTINCT session_id) AS sessions FROM usage u WHERE ${where("u")} GROUP BY source`)
    .all(...args(since, until)) as { source: string; cost_usd: number; sessions: number }[];
  const sourcePrompts = db
    .prepare(`SELECT source, count(*) AS prompts FROM activity a WHERE kind = 'prompt' AND ${where("a")} GROUP BY source`)
    .all(...args(since, until)) as { source: string; prompts: number }[];
  const sources = sourceRows.map((r) => ({ ...r, prompts: sourcePrompts.find((p) => p.source === r.source)?.prompts ?? 0 })).sort((a, b) => b.cost_usd - a.cost_usd);

  const tools = db
    .prepare(`SELECT tool, count(*) AS count, sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors FROM activity a WHERE kind = 'tool' AND ${where("a")} GROUP BY tool ORDER BY count DESC LIMIT 12`)
    .all(...args(since, until)) as StatsReport["tools"];

  const stageRows = db
    .prepare(
      `SELECT stage, sum(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS done, sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, sum(CASE WHEN ok IS NULL THEN 1 ELSE 0 END) AS open
       FROM activity a WHERE kind = 'tool' AND stage IS NOT NULL AND ${where("a")} GROUP BY stage`,
    )
    .all(...args(since, until)) as { stage: string; done: number; failed: number; open: number }[];
  const stages = Object.fromEntries(stageRows.map((r) => [r.stage, { done: r.done, failed: r.failed, open: r.open }]));

  const punch = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of db.prepare(`SELECT ts FROM activity a WHERE kind = 'prompt' AND ${where("a")}`).all(...args(since, until)) as { ts: string }[]) {
    const d = new Date(r.ts);
    punch[d.getDay()]![d.getHours()]!++;
  }

  const latest = db.prepare(`SELECT json, ts FROM events WHERE type = 'rate_limit_event' ORDER BY seq DESC LIMIT 1`).get() as { json: string; ts: string } | undefined;
  // A window whose reset has passed is empty until the next prompt opens a new one.
  const settled = (w: Window | null): Window | null => {
    if (!w) return null;
    const resetsAt = w.resets_at ? Date.parse(w.resets_at) / 1000 : undefined;
    return { ...w, utilization: windowNow({ utilization: w.utilization, ...(resetsAt !== undefined ? { resetsAt } : {}) }, clockMs).utilization };
  };
  let windows: StatsReport["windows"] = { five_hour: null, seven_day: null, models: [], at: null };
  if (plan) {
    windows = { five_hour: settled(plan.five_hour), seven_day: settled(plan.seven_day), models: plan.models.map((m) => ({ ...m, ...settled(m)! })), at: plan.at };
  } else if (latest) {
    try {
      const info = (JSON.parse(latest.json) as { rate_limit_info?: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } }).rate_limit_info?.unifiedWindows;
      const w = (k: string) => {
        const v = info?.[k];
        if (!v || typeof v.utilization !== "number") return null;
        return settled({ utilization: v.utilization, resets_at: typeof v.resetsAt === "number" ? new Date(v.resetsAt * 1000).toISOString() : null });
      };
      windows = { five_hour: w("five_hour"), seven_day: w("seven_day"), models: [], at: latest.ts };
    } catch {
      /* an odd line; no windows */
    }
  }

  return {
    range: { since, until, bucket: q.bucket, cwd: q.cwd },
    totals: now,
    previous,
    series: [...series.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    models,
    projects: [...projects.values()].sort((a, b) => b.cost_usd - a.cost_usd || b.prompts - a.prompts),
    sources,
    tools,
    stages,
    scores: scores(store, q, since, until, [...series.values()]),
    punch,
    windows,
    shipped: shipped(store, since, until, q.cwd),
    repos: repoCommits(store, q.cwd),
  };
}

/**
 * Every project the ledger has seen that is a git repository's top folder (not a scratch folder
 * inside one, nor anything in the folders macOS guards), with its commits ever and how many Claude co-wrote, most commits first. Only that
 * project, when the page is looking at one.
 */
export function repoCommits(store: Store, cwd: string | null): RepoCommits[] {
  const dirs = cwd
    ? [cwd]
    : (store.db.prepare(`SELECT cwd FROM usage GROUP BY cwd UNION SELECT cwd FROM activity GROUP BY cwd`).all() as { cwd: string }[]).map((r) => r.cwd);
  const repos = new Map<string, RepoCommits>();
  for (const dir of dirs) {
    const top = realpath(dir);
    if (repos.has(top)) continue;
    const commits = Number(git(dir, ["rev-list", "--count", "HEAD"]));
    if (!commits) continue;
    const claude = Number(git(dir, ["rev-list", "--count", "-i", "--grep=^co-authored-by: claude", "HEAD"])) || 0;
    const first = git(dir, ["log", "--max-parents=0", "--format=%cI", "HEAD"])?.split("\n").sort()[0] ?? null;
    repos.set(top, { cwd: dir, name: projectName(dir), commits, claude, first: first ? new Date(first).toISOString() : null });
  }
  return [...repos.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

/**
 * The folders macOS guards (Documents, Desktop, Downloads, Library): a git run in one from the daemon
 * waits on a privacy prompt until it times out, so the stats never look in them.
 */
const GUARDED = ["Documents", "Desktop", "Downloads", "Library"].map((d) => path.join(os.homedir(), d));

/** A folder git may be asked about: a repository's own top folder that still exists, outside the guarded ones. */
function isRepo(cwd: string): boolean {
  if (GUARDED.some((g) => cwd === g || cwd.startsWith(g + path.sep))) return false;
  return fs.existsSync(path.join(cwd, ".git"));
}

/** A git command's output in a project, trimmed; null when git can't run there (not a repository, no commits). */
function git(cwd: string, args: string[]): string | null {
  if (!isRepo(cwd)) return null;
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const TICKER_MAX = 40;
const TICKER_STAGES = ["commit", "build", "testflight", "deploy"] as const;

/**
 * What the span shipped, newest first: commits with their hash and subject from each project's own
 * git log (a commit made anywhere counts, not only one Claude ran), and the builds, TestFlight
 * uploads and deploys the ledger saw go through. A project git can't read keeps the ledger's
 * commits, untitled.
 */
function shipped(store: Store, since: string, until: string, cwd: string | null): ShippedItem[] {
  const where = `a.ts >= ? AND a.ts < ?` + (cwd ? ` AND a.cwd = ?` : "");
  const args = cwd ? [since, until, cwd] : [since, until];
  const rows = store.db
    .prepare(`SELECT cwd, ts, stage FROM activity a WHERE kind = 'tool' AND ok = 1 AND stage IN (${TICKER_STAGES.map(() => "?").join(", ")}) AND ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...TICKER_STAGES, ...args, TICKER_MAX * 3) as { cwd: string; ts: string; stage: ShippedItem["kind"] }[];
  const items: ShippedItem[] = [];
  const logged = new Set<string>();
  for (const dir of new Set(rows.filter((r) => r.stage === "commit").map((r) => r.cwd))) {
    const commits = gitCommits(dir, since, until);
    if (commits) {
      logged.add(dir);
      items.push(...commits);
    }
  }
  for (const r of rows) {
    if (r.stage === "commit" && logged.has(r.cwd)) continue;
    items.push({ ts: r.ts, kind: r.stage, project: projectName(r.cwd), title: null, count: 1 });
  }
  const runs: ShippedItem[] = [];
  for (const item of items.sort((a, b) => b.ts.localeCompare(a.ts))) {
    const last = runs[runs.length - 1];
    if (last && item.title === null && last.title === null && last.kind === item.kind && last.project === item.project) last.count += 1;
    else runs.push(item);
  }
  return runs.slice(0, TICKER_MAX);
}

/** A project's commits in the span, from git; null when the folder isn't a repository git can read. */
function gitCommits(cwd: string, since: string, until: string): ShippedItem[] | null {
  if (!isRepo(cwd)) return null;
  try {
    const out = execFileSync("git", ["-C", cwd, "log", `--since=${since}`, `--until=${until}`, "-n", String(TICKER_MAX), "--format=%h%x09%cI%x09%s"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...subject] = line.split("\t");
        return { ts: new Date(date ?? "").toISOString(), kind: "commit" as const, project: projectName(cwd), title: `${hash} ${subject.join("\t")}`, count: 1 };
      });
  } catch {
    return null;
  }
}

/** The shipping stages: a TestFlight (or ad hoc) upload, or a deploy. */
const SHIP_STAGES = ["testflight", "deploy"] as const;
/** An archive and upload takes minutes; a command that came back sooner only mentioned the script (a cat, a grep, a detached launch). */
const MIN_SHIP_MS = 20_000;

/** One prompt that ended in a ship: the project, the session, when it was asked, and how long until it was up. */
export interface Ship {
  session_id: string;
  cwd: string;
  prompt_ts: string;
  ms: number;
}

/**
 * Every turn in the span that shipped: from the prompt to the moment its first successful upload or
 * deploy came back. Only tools whose finish the ledger saw count, and only ones that ran long enough
 * to have done the work.
 */
export function ships(store: Store, q: { since: string | null; until: string | null; cwd: string | null }): Ship[] {
  const db = store.db;
  const since = q.since ?? "0000";
  const until = q.until ?? "9999";
  const where = (alias: string) => `${alias}.ts >= ? AND ${alias}.ts < ?` + (q.cwd ? ` AND ${alias}.cwd = ?` : "");
  const args = q.cwd ? [since, until, q.cwd] : [since, until];
  const prompts = db.prepare(`SELECT session_id, cwd, ts FROM activity a WHERE kind = 'prompt' AND ${where("a")} ORDER BY session_id, ts`).all(...args) as { session_id: string; cwd: string; ts: string }[];
  const uploads = (
    db
      .prepare(`SELECT session_id, ts, done_ts FROM activity a WHERE kind = 'tool' AND ok = 1 AND done_ts IS NOT NULL AND stage IN (${SHIP_STAGES.map(() => "?").join(", ")}) AND ${where("a")} ORDER BY session_id, ts`)
      .all(...SHIP_STAGES, ...args) as { session_id: string; ts: string; done_ts: string }[]
  ).filter((u) => new Date(u.done_ts).getTime() - new Date(u.ts).getTime() >= MIN_SHIP_MS);
  const turns = turnsOf(prompts);
  const out = new Map<string, Ship>();
  for (const u of uploads) {
    const list = turns.get(u.session_id);
    if (!list) continue;
    const i = turnIndex(list.map((t) => t.ts), u.ts);
    const prompt = list[i];
    if (!prompt || prompt.ts > u.ts) continue; // a ship before the first prompt the span knows of
    const key = `${u.session_id}:${i}`;
    if (out.has(key)) continue; // the turn's first ship is the one that counts
    const ms = new Date(u.done_ts).getTime() - new Date(prompt.ts).getTime();
    if (ms > 0) out.set(key, { session_id: u.session_id, cwd: prompt.cwd, prompt_ts: prompt.ts, ms });
  }
  return [...out.values()];
}

/** The fastest ship on record before `before` (a prompt instant), over every project; null when nothing has shipped. */
export function fastestShipBefore(store: Store, before: string): Ship | null {
  let best: Ship | null = null;
  for (const s of ships(store, { since: null, until: null, cwd: null })) {
    if (s.prompt_ts >= before) continue;
    if (!best || s.ms < best.ms) best = s;
  }
  return best;
}

/** Each session's prompts in order. */
function turnsOf<T extends { session_id: string; ts: string }>(prompts: T[]): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const p of prompts) {
    const list = by.get(p.session_id) ?? [];
    list.push(p);
    by.set(p.session_id, list);
  }
  return by;
}

/** Which turn an instant falls in: the index of the last prompt at or before it (0 before the first). */
function turnIndex(promptTimes: string[], ts: string): number {
  let i = 0;
  while (i + 1 < promptTimes.length && promptTimes[i + 1]! <= ts) i++;
  return i;
}

/**
 * The arcade's high-score table for the span: the dearest turn, the dearest and longest sessions,
 * the busiest day, the streak, the best combo, the fastest ship, the cheapest turn that still
 * shipped a commit, the commit spree, the longest think, the tool frenzy, the marathon turn, the most
 * interrupted session, the latest night and the earliest morning.
 */
function scores(store: Store, q: StatsQuery, since: string, until: string, series: Bucket[]): Score[] {
  const db = store.db;
  const where = (alias: string) => `${alias}.ts >= ? AND ${alias}.ts < ?` + (q.cwd ? ` AND ${alias}.cwd = ?` : "");
  const args = q.cwd ? [since, until, q.cwd] : [since, until];
  const calls = db.prepare(`SELECT session_id, cwd, ts, coalesce(cost_usd, 0) AS cost, thinking FROM usage u WHERE ${where("u")} ORDER BY session_id, ts`).all(...args) as { session_id: string; cwd: string; ts: string; cost: number; thinking: number }[];
  const prompts = db.prepare(`SELECT session_id, cwd, ts FROM activity a WHERE kind = 'prompt' AND ${where("a")} ORDER BY session_id, ts`).all(...args) as { session_id: string; cwd: string; ts: string }[];
  const out: Score[] = [];
  if (calls.length === 0) return out;

  const title = (sessionId: string): string => {
    const own = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get(sessionId) as { title: string } | undefined;
    if (own?.title) return own.title;
    const t = db.prepare(`SELECT title FROM transcripts WHERE session_id = ?`).get(sessionId) as { title: string | null } | undefined;
    return t?.title ?? "untitled";
  };
  const when = (ts: string) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const story = (cwd: string, sessionId: string, ts: string) => `${projectName(cwd)} · ${title(sessionId)} · ${when(ts)}`;

  // Turns: from one prompt to the next within a session; calls before the first prompt count as the first turn.
  const promptsBySession = new Map<string, string[]>();
  for (const [id, list] of turnsOf(prompts)) promptsBySession.set(id, list.map((p) => p.ts));
  const turnKeyOf = (sessionId: string, ts: string) => `${sessionId}:${turnIndex(promptsBySession.get(sessionId) ?? [], ts)}`;
  // A turn's and a session's active time: the gaps between calls (a turn's from its prompt), each capped,
  // so one resumed days later, or woken by a background job hours on, isn't days long.
  const ACTIVE_GAP_MS = 10 * 60_000;
  const turnCost = new Map<string, { cost: number; thinking: number; cwd: string; ts: string; last: string; active: number }>();
  const sessionCost = new Map<string, { cost: number; cwd: string; first: string; last: string; active: number }>();
  for (const c of calls) {
    const list = promptsBySession.get(c.session_id) ?? [];
    const turnKey = turnKeyOf(c.session_id, c.ts);
    const start = list[Number(turnKey.slice(turnKey.lastIndexOf(":") + 1))] ?? c.ts;
    const t = turnCost.get(turnKey) ?? { cost: 0, thinking: 0, cwd: c.cwd, ts: start, last: start, active: 0 };
    t.cost += c.cost;
    t.thinking += c.thinking;
    if (c.ts > t.last) {
      t.active += Math.min(new Date(c.ts).getTime() - new Date(t.last).getTime(), ACTIVE_GAP_MS);
      t.last = c.ts;
    }
    turnCost.set(turnKey, t);
    const s = sessionCost.get(c.session_id) ?? { cost: 0, cwd: c.cwd, first: c.ts, last: c.ts, active: 0 };
    s.cost += c.cost;
    if (c.ts < s.first) s.first = c.ts;
    if (c.ts > s.last) {
      s.active += Math.min(new Date(c.ts).getTime() - new Date(s.last).getTime(), ACTIVE_GAP_MS);
      s.last = c.ts;
    }
    sessionCost.set(c.session_id, s);
  }
  const sessionOf = (turnKey: string) => turnKey.slice(0, turnKey.lastIndexOf(":"));
  let bestTurn: { key: string; cost: number; cwd: string; ts: string } | null = null;
  let deepest: { key: string; thinking: number; cwd: string; ts: string } | null = null;
  // The marathon: the turn that worked longest, from its prompt to its last call, idle stretches capped.
  let marathon: { key: string; ms: number; cwd: string; ts: string } | null = null;
  for (const [key, t] of turnCost) {
    if (!bestTurn || t.cost > bestTurn.cost) bestTurn = { key, ...t };
    if (t.thinking > 0 && (!deepest || t.thinking > deepest.thinking)) deepest = { key, ...t };
    if (!marathon || t.active > marathon.ms) marathon = { key, ms: t.active, cwd: t.cwd, ts: t.ts };
  }
  if (bestTurn) {
    out.push({ label: "dearest turn", value: money(bestTurn.cost), detail: story(bestTurn.cwd, sessionOf(bestTurn.key), bestTurn.ts), kind: "cost", project: projectName(bestTurn.cwd), n: bestTurn.cost, better: "high" });
  }
  let bestSession: { id: string; cost: number; cwd: string; first: string } | null = null;
  let longest: { id: string; ms: number; cwd: string; first: string } | null = null;
  for (const [id, s] of sessionCost) {
    if (!bestSession || s.cost > bestSession.cost) bestSession = { id, cost: s.cost, cwd: s.cwd, first: s.first };
    if (!longest || s.active > longest.ms) longest = { id, ms: s.active, cwd: s.cwd, first: s.first };
  }
  if (bestSession) out.push({ label: "dearest session", value: money(bestSession.cost), detail: story(bestSession.cwd, bestSession.id, bestSession.first), kind: "cost", project: projectName(bestSession.cwd), n: bestSession.cost, better: "high" });
  if (longest && longest.ms > 0) out.push({ label: "longest session", value: duration(longest.ms), detail: story(longest.cwd, longest.id, longest.first), kind: "time", project: projectName(longest.cwd), n: longest.ms, better: "high" });

  const busiest = series.reduce<Bucket | null>((best, b) => (b.prompts > (best?.prompts ?? 0) ? b : best), null);
  if (busiest) out.push({ label: q.bucket === "month" ? "busiest month" : "busiest day", value: `${busiest.prompts} prompts`, detail: `${money(busiest.cost_usd)} · ${busiest.bucket}`, kind: "count", project: null, n: busiest.prompts, better: "high" });

  // The streak: days in a row with a prompt, ending on the latest such day in the span.
  const days = (db.prepare(`SELECT DISTINCT day FROM activity a WHERE kind = 'prompt' AND ${where("a")} ORDER BY day DESC`).all(...args) as { day: string }[]).map((r) => r.day);
  if (days.length > 0) {
    let streak = 1;
    for (let i = 1; i < days.length; i++) {
      const prev = new Date(days[i - 1]! + "T12:00:00");
      prev.setDate(prev.getDate() - 1);
      if (localDay(prev) === days[i]) streak++;
      else break;
    }
    out.push({ label: "streak", value: `${streak} ${streak === 1 ? "day" : "days"}`, detail: `through ${days[0]}`, kind: "streak", project: null, n: streak, better: "high" });
  }

  // The best combo: turns in a row, every session's in the order they were asked, that nothing broke:
  // no failed build, test, commit, upload or deploy, and no interrupt. The phone's status line counts
  // one session's the same way.
  const breaks = db
    .prepare(`SELECT session_id, ts FROM activity a WHERE ((kind = 'tool' AND ok = 0 AND stage IN ('build', 'test', 'commit', 'testflight', 'deploy')) OR kind = 'interrupt') AND ${where("a")}`)
    .all(...args) as { session_id: string; ts: string }[];
  const broken = new Set(breaks.map((b) => turnKeyOf(b.session_id, b.ts)));
  const everyTurn = [...promptsBySession].flatMap(([id, times]) => times.map((ts, i) => ({ key: `${id}:${i}`, ts }))).sort((a, b) => a.ts.localeCompare(b.ts));
  let run = 0;
  let combo: { n: number; end: string } | null = null;
  for (const t of everyTurn) {
    if (broken.has(t.key)) {
      run = 0;
      continue;
    }
    run++;
    if (!combo || run > combo.n) combo = { n: run, end: t.ts };
  }
  if (combo && combo.n >= 2) {
    out.push({ label: "best combo", value: `${combo.n} turns`, detail: run === combo.n ? "clean turns in a row · still going" : `clean turns in a row · ended ${when(combo.end)}`, kind: "streak", project: null, n: combo.n, better: "high" });
  }

  // The fastest ship: prompt to a finished upload or deploy.
  let fastest: Ship | null = null;
  for (const s of ships(store, { since, until, cwd: q.cwd })) if (!fastest || s.ms < fastest.ms) fastest = s;
  if (fastest) out.push({ label: "fastest ship", value: clock(fastest.ms), detail: story(fastest.cwd, fastest.session_id, fastest.prompt_ts), kind: "time", project: projectName(fastest.cwd), n: fastest.ms, better: "low" });

  // The cheapest useful turn: one that got a commit in, for the least money.
  const commits = db.prepare(`SELECT session_id, ts FROM activity a WHERE kind = 'tool' AND stage = 'commit' AND ok = 1 AND ${where("a")}`).all(...args) as { session_id: string; ts: string }[];
  let cheapest: { key: string; cost: number; cwd: string; ts: string } | null = null;
  for (const c of commits) {
    const key = turnKeyOf(c.session_id, c.ts);
    const t = turnCost.get(key);
    if (t && t.cost > 0 && (!cheapest || t.cost < cheapest.cost)) cheapest = { key, ...t };
  }
  if (cheapest) out.push({ label: "cheapest useful turn", value: money(cheapest.cost), detail: story(cheapest.cwd, sessionOf(cheapest.key), cheapest.ts), kind: "cost", project: projectName(cheapest.cwd), n: cheapest.cost, better: "low" });

  // The commit spree: the most commits that went in on one day.
  const commitsByDay = new Map<string, number>();
  for (const c of commits) {
    const day = localDay(new Date(c.ts));
    commitsByDay.set(day, (commitsByDay.get(day) ?? 0) + 1);
  }
  const spree = [...commitsByDay].reduce<[string, number] | null>((best, d) => (d[1] > (best?.[1] ?? 0) ? d : best), null);
  if (spree && spree[1] >= 3) out.push({ label: "commit spree", value: `${spree[1]} commits`, detail: `in one day · ${when(spree[0] + "T12:00:00")}`, kind: "count", project: null, n: spree[1], better: "high" });

  if (deepest) out.push({ label: "longest think", value: `${tokens(deepest.thinking)} tokens`, detail: story(deepest.cwd, sessionOf(deepest.key), deepest.ts), kind: "count", project: projectName(deepest.cwd), n: deepest.thinking, better: "high" });

  // The tool frenzy: the most tool calls in one turn.
  const toolCalls = db.prepare(`SELECT session_id, cwd, ts FROM activity a WHERE kind = 'tool' AND ${where("a")}`).all(...args) as { session_id: string; cwd: string; ts: string }[];
  const toolsPerTurn = new Map<string, { n: number; cwd: string }>();
  for (const c of toolCalls) {
    const key = turnKeyOf(c.session_id, c.ts);
    const t = toolsPerTurn.get(key) ?? { n: 0, cwd: c.cwd };
    t.n++;
    toolsPerTurn.set(key, t);
  }
  const frenzy = [...toolsPerTurn].reduce<[string, { n: number; cwd: string }] | null>((best, t) => (t[1].n > (best?.[1].n ?? 0) ? t : best), null);
  if (frenzy && frenzy[1].n >= 10) {
    const [key, t] = frenzy;
    out.push({ label: "tool frenzy", value: `${t.n} tools`, detail: `in one turn · ${story(t.cwd, sessionOf(key), turnCost.get(key)?.ts ?? toolCalls[0]!.ts)}`, kind: "count", project: projectName(t.cwd), n: t.n, better: "high" });
  }

  if (marathon && marathon.ms >= 60_000) out.push({ label: "marathon turn", value: clock(marathon.ms), detail: story(marathon.cwd, sessionOf(marathon.key), marathon.ts), kind: "time", project: projectName(marathon.cwd), n: marathon.ms, better: "high" });

  const interrupted = db
    .prepare(`SELECT session_id, cwd, count(*) AS n, min(ts) AS first FROM activity a WHERE kind = 'interrupt' AND ${where("a")} GROUP BY session_id ORDER BY n DESC, first LIMIT 1`)
    .get(...args) as { session_id: string; cwd: string; n: number; first: string } | undefined;
  if (interrupted && interrupted.n > 1) {
    out.push({ label: "most interrupted", value: `${interrupted.n} interrupts`, detail: story(interrupted.cwd, interrupted.session_id, interrupted.first), kind: "count", project: projectName(interrupted.cwd), n: interrupted.n, better: "high" });
  }

  // Night owl: the latest prompt of the span by the clock, counting the small hours as later than
  // midnight; only once it's past ten. First light: the earliest after five, only before eight.
  const DAWN = 5 * 60;
  let latest: { p: { session_id: string; cwd: string; ts: string }; lateness: number } | null = null;
  let earliest: { p: { session_id: string; cwd: string; ts: string }; minute: number } | null = null;
  for (const p of prompts) {
    const d = new Date(p.ts);
    const minute = d.getHours() * 60 + d.getMinutes();
    const lateness = minute < DAWN ? minute + 24 * 60 : minute;
    if (!latest || lateness > latest.lateness) latest = { p, lateness };
    if (minute >= DAWN && (!earliest || minute < earliest.minute)) earliest = { p, minute };
  }
  if (latest && latest.lateness >= 22 * 60) out.push({ label: "night owl", value: timeOfDay(latest.p.ts), detail: story(latest.p.cwd, latest.p.session_id, latest.p.ts), kind: "time", project: projectName(latest.p.cwd), n: latest.lateness, better: "high" });
  if (earliest && earliest.minute < 8 * 60) out.push({ label: "first light", value: timeOfDay(earliest.p.ts), detail: story(earliest.p.cwd, earliest.p.session_id, earliest.p.ts), kind: "time", project: projectName(earliest.p.cwd), n: earliest.minute, better: "low" });
  return out;
}

/** Every bucket from `since` up to (not including) `until`, in local time. */
export function bucketsBetween(since: string, until: string, bucket: "day" | "month"): string[] {
  const out: string[] = [];
  const end = new Date(until);
  const d = new Date(since);
  if (bucket === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    while (d < end && out.length < 1200) {
      out.push(localDay(d).slice(0, 7));
      d.setMonth(d.getMonth() + 1);
    }
  } else {
    d.setHours(0, 0, 0, 0);
    while (d < end && out.length < 3660) {
      out.push(localDay(d));
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  return `${h}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A span short enough to want seconds: "48s", "4m 12s", then hours and minutes. */
export function clock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return duration(ms);
}

/** "2:14 AM", on the Mac's clock. */
function timeOfDay(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** "84k", "1.2M". */
function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
