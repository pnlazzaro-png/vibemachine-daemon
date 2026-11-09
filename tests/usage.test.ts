// The usage ledger over a made-up transcript folder: one row per message id
// however many lines repeat it, prices from the tokens, prompts and pipeline
// commands with their outcomes, and an append read from where the last scan
// stopped. Then the report over it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { costOf, priceFor } from "../src/pricing.js";
import { bucketsBetween, clock, fastestShipBefore, statsReport } from "../src/stats.js";
import { parsePlanUsage } from "../src/planusage.js";
import { stageOf, UsageLedger } from "../src/usage.js";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

const SESSION = "11111111-1111-1111-1111-111111111111";
const CWD = "/Users/sam/dev/thing";

function assistant(id: string, ts: string, blocks: Record<string, unknown>[], usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return line({
    type: "assistant", uuid: `${id}-${blocks.length}`, timestamp: ts, sessionId: SESSION, cwd: CWD, version: "2.1.281", entrypoint: "cli", ...extra,
    message: { id, model: "claude-opus-5-5", usage, content: blocks },
  });
}

const usage1 = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2000, output_tokens_details: { thinking_tokens: 100 }, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } };

function setup(): { root: string; store: Store; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-usage-"));
  const dir = path.join(root, "-Users-sam-dev-thing");
  fs.mkdirSync(dir);
  const file = path.join(dir, `${SESSION}.jsonl`);
  let text = "";
  text += line({ type: "user", uuid: "u1", timestamp: "2026-10-20T15:00:00.000Z", sessionId: SESSION, cwd: CWD, message: { role: "user", content: "Fix the launch flash\nand more" } });
  // Three lines for one API response: thinking, text, tool_use. Same id, same usage.
  text += assistant("msg_1", "2026-10-20T15:00:05.000Z", [{ type: "thinking", thinking: "" }], usage1);
  text += assistant("msg_1", "2026-10-20T15:00:06.000Z", [{ type: "text", text: "On it." }], usage1);
  text += assistant("msg_1", "2026-10-20T15:00:07.000Z", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "xcodebuild -scheme App build" } }], usage1);
  text += line({ type: "user", uuid: "u2", timestamp: "2026-10-20T15:01:00.000Z", sessionId: SESSION, cwd: CWD, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "error: boom", is_error: true }] } });
  text += assistant("msg_2", "2026-10-20T15:01:10.000Z", [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "git commit -m 'fix'" } }], { ...usage1, output_tokens: 200 });
  text += line({ type: "user", uuid: "u3", timestamp: "2026-10-20T15:01:20.000Z", sessionId: SESSION, cwd: CWD, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "[main abc] fix" }] } });
  text += line({ type: "system", subtype: "turn_duration", uuid: "t1", timestamp: "2026-10-20T15:01:30.000Z", sessionId: SESSION, durationMs: 90_000 });
  text += line({ type: "assistant", uuid: "syn", timestamp: "2026-10-20T15:01:31.000Z", sessionId: SESSION, cwd: CWD, message: { id: "msg_synthetic", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 }, content: [] } });
  text += line({ type: "cost-state", sessionId: SESSION, totalCostUSD: 1 });
  fs.writeFileSync(file, text);
  const store = new Store(":memory:");
  return { root, store, file };
}

test("pricing: the hour's cache write, matching the CLI's own figure", () => {
  // The last turn of a daemon session, as Claude Code reported it: costUSD 0.544143.
  const cost = costOf("claude-opus-5-5", { input: 26, output: 5626, cacheRead: 516_595, cacheWrite5m: 0, cacheWrite1h: 41_025 });
  assert.ok(cost !== null && Math.abs(cost - 0.544143) < 1e-6, String(cost));
  assert.equal(priceFor("claude-opus-4-5-20251101")?.input, 5);
  assert.deepEqual(priceFor("claude-fable-5-2"), { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10, cacheWrite1h: 16 });
  assert.equal(priceFor("claude-fable-5-1")?.cacheRead, 0.25);
  assert.equal(priceFor("claude-fable-5")?.cacheRead, 1);
  assert.equal(priceFor("gpt-oss"), null);
  assert.equal(costOf("mystery", { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), null);
});

test("stageOf: the pipeline's commands", () => {
  assert.equal(stageOf("git add -A && git commit -m 'x'"), "commit");
  assert.equal(stageOf("xcodebuild -scheme App -destination x test"), "test");
  assert.equal(stageOf("xcodebuild -scheme App archive -archivePath y"), "archive");
  assert.equal(stageOf("xcodebuild -scheme App build"), "build");
  assert.equal(stageOf("ios/scripts/testflight.sh"), "testflight");
  assert.equal(stageOf("npm test"), "test");
  assert.equal(stageOf("ls -la"), null);
});

test("ledger: one row per message id, prompts, tools with outcomes, turns; then an append", async () => {
  const { root, store, file } = setup();
  const ledger = new UsageLedger(store, root);
  assert.equal(await ledger.scan(), 1 + 1 + 1 + 1 + 1 + 1); // msg_1, toolu_1, msg_2, toolu_2, the prompt, the turn
  const usage = store.db.prepare(`SELECT * FROM usage ORDER BY ts`).all() as Record<string, unknown>[];
  assert.equal(usage.length, 2);
  assert.equal(usage[0]!.id, "msg_1");
  assert.equal(usage[0]!.output, 1000);
  assert.equal(usage[0]!.cache_write_1h, 2000);
  assert.equal(usage[0]!.source, "terminal");
  assert.equal(usage[0]!.cwd, CWD);
  assert.ok(Math.abs((usage[0]!.cost_usd as number) - (10 * 4 + 1000 * 20 + 50_000 * 0.2 + 2000 * 8) / 1e6) < 1e-9);
  const tools = (store.db.prepare(`SELECT id, tool, stage, ok FROM activity WHERE kind = 'tool' ORDER BY ts`).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  assert.deepEqual(tools, [
    { id: "toolu_1", tool: "Bash", stage: "build", ok: 0 },
    { id: "toolu_2", tool: "Bash", stage: "commit", ok: 1 },
  ]);
  assert.equal((store.db.prepare(`SELECT count(*) AS n FROM activity WHERE kind = 'prompt'`).get() as { n: number }).n, 1);
  assert.equal((store.db.prepare(`SELECT value FROM activity WHERE kind = 'turn'`).get() as { value: number }).value, 90_000);
  const transcript = store.db.prepare(`SELECT * FROM transcripts`).get() as Record<string, unknown>;
  assert.equal(transcript.title, "Fix the launch flash");
  assert.equal(transcript.first_ts, "2026-10-20T15:00:00.000Z");

  // Nothing new: nothing read.
  assert.equal(await ledger.scan(), 0);

  // An append, with a partial last line still being written.
  fs.appendFileSync(file, line({ type: "user", uuid: "u4", timestamp: "2026-10-21T09:00:00.000Z", sessionId: SESSION, cwd: CWD, message: { role: "user", content: "Now add a test" } }) + '{"type":"assistant","half');
  assert.equal(await ledger.scan(), 1);
  assert.equal((store.db.prepare(`SELECT count(*) AS n FROM activity WHERE kind = 'prompt'`).get() as { n: number }).n, 2);
  // The partial line is read once it is finished.
  fs.appendFileSync(file, '":1}\n' + assistant("msg_3", "2026-10-21T09:00:10.000Z", [{ type: "text", text: "ok" }], usage1));
  assert.equal(await ledger.scan(), 1);
  assert.equal((store.db.prepare(`SELECT count(*) AS n FROM usage`).get() as { n: number }).n, 3);

  // A daemon session is the phone's.
  store.insertSession({ id: SESSION, title: "Fix the launch flash", cwd: CWD, model: null, permission_mode: "default", status: "idle", created_at: "2026-10-20T15:00:00.000Z" });
  fs.appendFileSync(file, assistant("msg_4", "2026-10-21T09:01:00.000Z", [{ type: "text", text: "ok" }], usage1));
  await ledger.scan();
  assert.equal((store.db.prepare(`SELECT source FROM usage WHERE id = 'msg_4'`).get() as { source: string }).source, "phone");

  fs.rmSync(root, { recursive: true, force: true });
});

test("report: totals, the span before, buckets with empty days, projects, stages, scores", async () => {
  const { root, store } = setup();
  await new UsageLedger(store, root).scan();
  // Local midnights, since the ledger's days are the Mac's.
  const r = statsReport(store, { since: new Date(2026, 9, 19).toISOString(), until: new Date(2026, 9, 22).toISOString(), bucket: "day", cwd: null });
  assert.equal(r.totals.requests, 2);
  assert.equal(r.totals.prompts, 1);
  assert.equal(r.totals.tools, 2);
  assert.equal(r.totals.tool_errors, 1);
  assert.equal(r.totals.turns, 1);
  assert.equal(r.totals.sessions, 1);
  assert.ok(r.totals.cost_usd > 0);
  assert.deepEqual(r.previous, { cost_usd: 0, tokens: 0, prompts: 0 });
  assert.equal(r.series.length, 3);
  assert.equal(r.series.filter((b) => b.cost_usd > 0).length, 1);
  assert.equal(Object.keys(r.series.find((b) => b.cost_usd > 0)!.models)[0], "claude-opus-5-5");
  assert.equal(r.models[0]!.model, "claude-opus-5-5");
  assert.equal(r.projects[0]!.name, "thing");
  assert.equal(r.projects[0]!.commits, 1);
  assert.equal(r.projects[0]!.builds_failed, 1);
  assert.deepEqual(r.stages.build, { done: 0, failed: 1, open: 0 });
  assert.equal(r.sources[0]!.source, "terminal");
  assert.equal(r.tools[0]!.tool, "Bash");
  assert.ok(r.scores.some((s) => s.label === "dearest turn"));
  assert.ok(r.scores.some((s) => s.label === "streak" && s.value === "1 day"));
  // The punch card: the one prompt, at its local weekday and hour.
  const asked = new Date("2026-10-20T15:00:00.000Z");
  assert.equal(r.punch.length, 7);
  assert.equal(r.punch[asked.getDay()]![asked.getHours()], 1);
  assert.equal(r.punch.flat().reduce((a, b) => a + b, 0), 1);
  // The ticker: the commit that went through (untitled, the folder isn't a repository); not the failed build.
  assert.deepEqual(r.shipped.map((s) => [s.kind, s.project, s.title, s.count]), [["commit", "thing", null, 1]]);
  // Filtered to another project: nothing.
  const none = statsReport(store, { since: null, until: null, bucket: "month", cwd: "/elsewhere" });
  assert.equal(none.totals.requests, 0);
  assert.equal(none.previous, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("scores: the fastest ship, the cheapest useful turn, the longest think, interrupts, night owl and first light", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-usage-"));
  const dir = path.join(root, "-Users-sam-dev-thing");
  fs.mkdirSync(dir);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo, d, h, mi, s).toISOString();
  const user = (uuid: string, ts: string, content: unknown) => line({ type: "user", uuid, timestamp: ts, sessionId: SESSION, cwd: CWD, message: { role: "user", content } });
  let text = "";
  // Asked late on the 20th: a commit, an interrupt or two, then a TestFlight upload that took four minutes from the prompt.
  text += user("p1", at(2026, 9, 20, 23, 30), "Ship the fix");
  text += assistant("m1", at(2026, 9, 20, 23, 30, 10), [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git commit -m 'fix'" } }], usage1);
  text += user("r1", at(2026, 9, 20, 23, 30, 20), [{ type: "tool_result", tool_use_id: "t1", content: "[main abc] fix" }]);
  text += user("i1", at(2026, 9, 20, 23, 31), "[Request interrupted by user]");
  text += user("i2", at(2026, 9, 20, 23, 32), "[Request interrupted by user]");
  text += assistant("m2", at(2026, 9, 20, 23, 33), [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ios/scripts/testflight.sh" } }], { ...usage1, output_tokens_details: { thinking_tokens: 5000 } });
  text += user("r2", at(2026, 9, 20, 23, 34), [{ type: "tool_result", tool_use_id: "t2", content: "uploaded" }]);
  // Up early the next morning: a dearer turn that shipped nothing.
  text += user("p2", at(2026, 9, 21, 6, 10), "Now the tests");
  text += assistant("m3", at(2026, 9, 21, 6, 11), [{ type: "text", text: "ok" }], { ...usage1, output_tokens: 20_000 });
  fs.writeFileSync(file, text);
  const store = new Store(":memory:");
  await new UsageLedger(store, root).scan();

  const r = statsReport(store, { since: null, until: null, bucket: "day", cwd: null });
  const score = (label: string) => r.scores.find((s) => s.label === label);
  assert.equal(score("fastest ship")?.value, "4m 00s");
  assert.equal(score("fastest ship")?.project, "thing");
  assert.equal(score("fastest ship")?.n, 4 * 60_000);
  assert.equal(score("fastest ship")?.better, "low");
  assert.equal(score("cheapest useful turn")?.detail.split(" · ")[1], "Ship the fix");
  assert.ok((score("cheapest useful turn")?.n ?? 0) < (score("dearest turn")?.n ?? 0));
  assert.equal(score("longest think")?.value, "5k tokens");
  assert.equal(score("most interrupted")?.value, "2 interrupts");
  assert.equal(score("night owl")?.value, "11:30 PM");
  assert.equal(score("first light")?.value, "6:10 AM");
  assert.equal(score("dearest turn")?.project, "thing");
  assert.equal(score("streak")?.project, null);

  // The record check the Live Activity makes: nothing shipped before the first prompt; the four minutes after it.
  assert.equal(fastestShipBefore(store, at(2026, 9, 20, 23, 30)), null);
  assert.equal(fastestShipBefore(store, at(2026, 9, 21, 6, 10))?.ms, 4 * 60_000);
  assert.equal(clock(48_000), "48s");
  assert.equal(clock(252_000), "4m 12s");
  assert.equal(clock(2 * 3_600_000 + 5 * 60_000), "2h 05m");
  fs.rmSync(root, { recursive: true, force: true });
});

test("bucketsBetween: whole days and months, local time", () => {
  const days = bucketsBetween(new Date(2026, 9, 20, 15).toISOString(), new Date(2026, 9, 23, 15).toISOString(), "day");
  assert.deepEqual(days, ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
  const months = bucketsBetween(new Date(2026, 0, 15).toISOString(), new Date(2026, 3, 1, 12).toISOString(), "month");
  assert.deepEqual(months, ["2026-01", "2026-02", "2026-03", "2026-04"]);
});

test("diagnostics: a crash is summarized and kept once", async () => {
  const { saveDiagnostic } = await import("../src/diagnostics.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-diag-"));
  const payload = { crashDiagnostics: [{ diagnosticMetaData: { exceptionType: 1, signal: 11, bundleIdentifier: "com.pnlazzaro.vibemachine", appBuildVersion: "202610251636" } }] };
  const saved = saveDiagnostic(payload, "duo-1", dir);
  assert.ok(saved);
  assert.match(saved.summary, /exception 1, signal 11.*202610251636/);
  assert.equal(saveDiagnostic(payload, "duo-1", dir), null, "the same payload again is not kept twice");
  assert.equal(fs.readdirSync(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("windows: a window past its reset reads empty until the next prompt reports a new one", () => {
  const store = new Store(":memory:");
  store.insertSession({ id: "s", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: new Date().toISOString() });
  const resets = 1793068800;
  store.appendEvent("s", { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.83, resetsAt: resets }, seven_day: { utilization: 0.41, resetsAt: resets + 5 * 86400 } } } });
  const q = { since: null, until: null, bucket: "day" as const, cwd: null };
  const before = statsReport(store, q, (resets - 60) * 1000).windows;
  assert.equal(before.five_hour?.utilization, 0.83);
  const after = statsReport(store, q, resets * 1000).windows;
  assert.equal(after.five_hour?.utilization, 0, "the five-hour window has reset: the gauge is back at zero");
  assert.equal(after.five_hour?.resets_at, new Date(resets * 1000).toISOString(), "its reset time stays, so the app can say a new one starts with the next prompt");
  assert.equal(after.seven_day?.utilization, 0.41, "the week hasn't reset");
});

test("windows: the plan's own answer wins, percent made a fraction, with each per-model week (Fable)", () => {
  const store = new Store(":memory:");
  store.insertSession({ id: "s", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: new Date().toISOString() });
  store.appendEvent("s", { type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1793310600 }, seven_day: { utilization: 0.7, resetsAt: 1793408400 } } } });
  // get_usage's rate_limits, trimmed from a real answer.
  const plan = parsePlanUsage({
    five_hour: { utilization: 3, resets_at: "2026-10-29T21:49:59.549621+00:00", limit_dollars: null },
    seven_day: { utilization: 81, resets_at: "2026-10-31T00:59:59.549646+00:00" },
    seven_day_opus: null,
    iguana_necktie: { utilization: 27.8, resets_at: "2026-11-05T07:59:00+00:00" },
    model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-10-31T00:59:59.549827+00:00" }, { display_name: "Odd", utilization: null, resets_at: null }],
  }, "2026-10-29T17:02:29.000Z");
  assert.deepEqual(plan?.models, [{ name: "Fable", utilization: 1, resets_at: "2026-10-31T00:59:59.549Z" }], "a model row without a reading is left out");
  assert.equal(parsePlanUsage(null, "x"), null, "no plan limits (an API key): nothing");
  const q = { since: null, until: null, bucket: "day" as const, cwd: null };
  const now = Date.parse("2026-10-29T17:05:00Z");
  const w = statsReport(store, q, now, plan).windows;
  assert.equal(w.five_hour?.utilization, 0.03);
  assert.equal(w.seven_day?.utilization, 0.81);
  assert.equal(w.models[0]?.name, "Fable");
  assert.equal(w.models[0]?.utilization, 1);
  assert.equal(w.at, "2026-10-29T17:02:29.000Z");
  const later = statsReport(store, q, Date.parse("2026-10-31T01:00:00Z"), plan).windows;
  assert.equal(later.models[0]?.utilization, 0, "past its reset the Fable week reads empty");
  assert.deepEqual(statsReport(store, q, now).windows.models, [], "without the plan's answer, the event's two windows and no models");
  assert.equal(statsReport(store, q, now).windows.seven_day?.utilization, 0.7);
});

test("repos: every project's commits ever from git, Claude's among them; the span's from git too", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vm-repo-")));
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "p@x" } });
  g("init", "-q");
  const commit = (msg: string, date: string) => {
    fs.writeFileSync(path.join(repo, "f"), msg);
    g("add", "f");
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", msg], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Sam", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "Sam", GIT_COMMITTER_EMAIL: "p@x", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  commit("First by hand", "2026-10-01T12:00:00Z");
  commit("Second\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", "2026-10-02T12:00:00Z");
  commit("Third\n\nCo-authored-by: Claude Fable 5.1 <noreply@anthropic.com>", "2026-10-20T12:00:00Z");
  const store = new Store(":memory:");
  const row = { session_id: "s", cwd: repo, model: "claude-opus-5-5", source: "terminal", day: "2026-10-20", input: 1, output: 1, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, thinking: 0, cost_usd: 0.01 };
  const insert = store.db.prepare(`INSERT INTO usage (id, ts, session_id, cwd, model, source, day, input, output, cache_read, cache_write_5m, cache_write_1h, thinking, cost_usd)
    VALUES (@id, @ts, @session_id, @cwd, @model, @source, @day, @input, @output, @cache_read, @cache_write_5m, @cache_write_1h, @thinking, @cost_usd)`);
  insert.run({ ...row, id: "m1", ts: "2026-10-20T12:30:00.000Z" });
  // A scratch folder inside the repository isn't a project of its own.
  fs.mkdirSync(path.join(repo, "scratch"));
  insert.run({ ...row, id: "m2", ts: "2026-10-20T12:31:00.000Z", cwd: path.join(repo, "scratch") });

  const r = statsReport(store, { since: "2026-10-19T00:00:00.000Z", until: "2026-10-21T00:00:00.000Z", bucket: "day", cwd: null });
  assert.equal(r.repos.length, 1);
  assert.equal(r.repos[0]!.commits, 3);
  assert.equal(r.repos[0]!.claude, 2);
  assert.equal(r.repos[0]!.first, "2026-10-01T12:00:00.000Z");
  // The span's own commits come from git: only the third was made in it.
  assert.equal(r.projects.find((p) => p.cwd === repo)!.commits, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("scores: the best combo, the commit spree, the tool frenzy and the marathon turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-usage-"));
  const dir = path.join(root, "-Users-sam-dev-thing");
  fs.mkdirSync(dir);
  const file = path.join(dir, `${SESSION}.jsonl`);
  const at = (h: number, mi: number, s = 0) => new Date(2026, 9, 22, h, mi, s).toISOString();
  const user = (uuid: string, ts: string, content: unknown) => line({ type: "user", uuid, timestamp: ts, sessionId: SESSION, cwd: CWD, message: { role: "user", content } });
  const bash = (id: string, ts: string, command: string, failed = false) =>
    assistant(`m-${id}`, ts, [{ type: "tool_use", id, name: "Bash", input: { command } }], usage1) +
    user(`r-${id}`, ts, [{ type: "tool_result", tool_use_id: id, content: failed ? "error: build failed" : "ok", ...(failed ? { is_error: true } : {}) }]);
  let text = "";
  // Turn 1: a frenzy of twelve tool calls, three of them commits.
  text += user("p1", at(9, 0), "Clean up");
  for (let i = 0; i < 12; i++) text += bash(`a${i}`, at(9, 1, i), i < 3 ? `git commit -m 'part ${i}'` : `ls ${i}`);
  // Turns 2 and 3 clean; turn 2 works for twenty minutes, with an hour's idle gap that doesn't count beyond ten.
  text += user("p2", at(10, 0), "Keep going");
  text += bash("b1", at(10, 10), "ls");
  text += bash("b2", at(11, 10), "ls");
  text += user("p3", at(12, 0), "And this");
  text += bash("c1", at(12, 1), "ls");
  // Turn 4: the build fails, which breaks the combo; turn 5 starts a new one.
  text += user("p4", at(13, 0), "Build it");
  text += bash("d1", at(13, 1), "xcodebuild -scheme Thing build", true);
  text += user("p5", at(14, 0), "Fix it");
  text += bash("e1", at(14, 1), "ls");
  fs.writeFileSync(file, text);
  const store = new Store(":memory:");
  await new UsageLedger(store, root).scan();

  const r = statsReport(store, { since: null, until: null, bucket: "day", cwd: null });
  const score = (label: string) => r.scores.find((s) => s.label === label);
  assert.equal(score("best combo")?.value, "3 turns");
  assert.match(score("best combo")!.detail, /ended/);
  assert.equal(score("commit spree")?.value, "3 commits");
  assert.equal(score("tool frenzy")?.value, "12 tools");
  assert.equal(score("tool frenzy")?.detail.split(" · ")[2], "Clean up");
  // Ten minutes to the first call, the hour's gap capped at ten: twenty.
  assert.equal(score("marathon turn")?.value, "20m 00s");
  assert.equal(score("marathon turn")?.n, 20 * 60_000);
  fs.rmSync(root, { recursive: true, force: true });
});
