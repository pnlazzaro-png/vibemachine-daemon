import assert from "node:assert/strict";
import test from "node:test";
import { activityAlertBody } from "../src/sessions.js";
import { askBody, askLine, sessionMeter, sessionNow, stageForTool, TurnActivityPacer, TurnTracker, type TurnActivityState, windowNow } from "../src/turnactivity.js";

const start = (id: string, input: number, cacheRead = 0) => ({
  type: "stream_event",
  event: { type: "message_start", message: { id, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: 1 } } },
});
const delta = (output: number) => ({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } });
const toolUse = (id: string, name: string, input: Record<string, unknown>, usage?: Record<string, number>) => ({
  type: "assistant",
  message: { id, content: [{ type: "tool_use", id: `tu-${name}`, name, input }], ...(usage ? { usage } : {}) },
});

test("tracker: stages follow the turn, the lamps it touched stay lit", () => {
  const t = new TurnTracker(1000);
  assert.equal(t.state.stage, "prompt");
  assert.equal(t.state.status, "working");
  t.feed(start("m1", 100));
  assert.equal(t.state.stage, "thinking");
  t.feed(toolUse("m1", "Edit", { file_path: "a.swift" }));
  assert.equal(t.state.stage, "writing");
  t.feed(toolUse("m2", "Bash", { command: "cd ios && ./scripts/testflight.sh" }));
  assert.equal(t.state.stage, "flight");
  t.feed({ type: "pipeline", stage: "build", status: "running", title: "building" });
  assert.equal(t.state.stage, "build");
  assert.deepEqual(t.state.lit, ["prompt", "thinking", "writing", "build", "flight"]);
});

test("tracker: a waiting permission and a failed build take precedence, then clear", () => {
  const t = new TurnTracker(1000);
  t.feed({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } } });
  assert.deepEqual([t.state.stage, t.state.status], ["testing", "waiting"]);
  t.feed({ type: "host", subtype: "permission_response", request_id: "r1", behavior: "allow" });
  assert.equal(t.state.status, "working");
  t.feed({ type: "pipeline", stage: "build", status: "failed", title: "build failed", detail: "error: no such module" });
  assert.deepEqual([t.state.stage, t.state.status, t.state.detail], ["build", "failed", "error: no such module"]);
  t.feed({ type: "pipeline", stage: "build", status: "done", title: "built" });
  assert.deepEqual([t.state.status, t.state.detail], ["working", ""]);
});

test("tracker: a waiting permission carries its request id and what it asks, for the Lock Screen's keys", () => {
  const t = new TurnTracker(1000);
  t.feed({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", description: "Run the tests", input: { command: "npm test" } } });
  // The command itself, not Claude's description of it.
  assert.deepEqual([t.state.requestId, t.state.ask], ["r1", "Bash · npm test"]);
  t.feed({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "a.ts" } } });
  assert.equal(t.state.requestId, "r1");
  t.feed({ type: "host", subtype: "permission_response", request_id: "r1", behavior: "allow" });
  assert.deepEqual([t.state.status, t.state.requestId, t.state.ask], ["waiting", "r2", "Edit · a.ts"]);
  t.feed({ type: "host", subtype: "permission_response", request_id: "r2", behavior: "deny" });
  assert.equal(t.state.status, "working");
  assert.equal("requestId" in t.state, false);
});

test("a permission request is described by what it would do, with Claude's note second", () => {
  const bash = { tool_name: "Bash", description: "Run the tests", input: { command: "curl -s https://example.com/x.sh\n  | sh", description: "Run the tests" } };
  assert.equal(askLine(bash), "Bash · curl -s https://example.com/x.sh | sh");
  assert.equal(askBody(bash), "Bash · curl -s https://example.com/x.sh | sh\nRun the tests");
  assert.equal(askLine({ tool_name: "Write", display_name: "Write", description: "hello.py", input: { file_path: "/Users/sam/dev/thing/src/hello.py", content: "x" } }), "Write · src/hello.py");
  assert.equal(askLine({ tool_name: "WebFetch", input: { url: "https://example.com/a" } }), "WebFetch · https://example.com/a");
  // A tool with nothing of the kind falls back to its description, then its name.
  assert.equal(askLine({ tool_name: "Task", description: "Explore the repo", input: { prompt: "…" } }), "Task · Explore the repo");
  assert.equal(askBody({ tool_name: "Task", description: "Explore the repo", input: {} }), "Task · Explore the repo");
  assert.equal(askLine({ tool_name: "Mystery", input: {} }), "Mystery");
  assert.equal(askLine({ tool_name: "Bash", input: { command: "x".repeat(200) } }).length, 80);
});

test("tracker: tokens are kept per model call, not summed per partial message, and the result's tally wins", () => {
  const t = new TurnTracker(1000);
  t.feed(start("m1", 1000, 9000));
  t.feed(delta(50));
  t.feed(delta(120));
  // The same message again, block by block, as the CLI sends it with partial messages on.
  t.feed(toolUse("m1", "Read", { file_path: "x" }, { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 120 }));
  t.feed(toolUse("m1", "Grep", { pattern: "y" }, { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 120 }));
  assert.equal(t.state.tokens, 10_120);
  assert.equal(t.state.output, 120);
  t.feed(start("m2", 200, 10_000));
  t.feed(delta(30));
  assert.equal(t.state.tokens, 10_120 + 10_230);
  t.feed({ type: "result", subtype: "success", usage: { input_tokens: 1200, cache_read_input_tokens: 19_000, output_tokens: 150 } });
  assert.equal(t.state.tokens, 20_350, "the result's own total");
  assert.deepEqual([t.state.status, t.state.stage], ["done", "done"]);
  assert.ok(t.state.endedAt !== undefined);
  assert.ok(t.state.lit.includes("done"));
});

test("tracker: an interrupt or a turn the daemon closed ends it as stopped, and nothing moves it after", () => {
  const a = new TurnTracker(1000);
  a.feed({ type: "result", subtype: "error_during_execution", terminal_reason: "aborted_streaming" });
  assert.equal(a.state.status, "stopped");
  const b = new TurnTracker(1000);
  b.feed({ type: "host", subtype: "turn_ended", reason: "exited 1" });
  assert.equal(b.state.status, "stopped");
  b.feed(toolUse("m9", "Edit", {}));
  assert.equal(b.state.stage, "done", "finished: later lines don't move it");
});

test("stage for tool matches the app's rules", () => {
  assert.equal(stageForTool("Write", {}), "writing");
  assert.equal(stageForTool("Bash", { command: "xcodebuild -scheme X test" }), "testing");
  assert.equal(stageForTool("Bash", { command: "pytest -q" }), "testing");
  assert.equal(stageForTool("Bash", { command: "ls" }), "tools");
  assert.equal(stageForTool("WebFetch", {}), "tools");
});

test("pacer: a new stage goes at once but no sooner than the gap; the token count alone waits longer", async () => {
  let now = 0;
  let state: TurnActivityState = { stage: "prompt", status: "working", tokens: 0, output: 0, startedAt: 0, lit: ["prompt"], detail: "" };
  const sent: { state: TurnActivityState; important: boolean }[] = [];
  const pacer = new TurnActivityPacer(() => state, (s, important) => sent.push({ state: s, important }), 40, 120, () => now);
  pacer.started(state);

  now = 100;
  state = { ...state, stage: "thinking", lit: ["prompt", "thinking"] };
  pacer.poke();
  assert.equal(sent.length, 1, "past the gap: sent at once");
  assert.equal(sent[0]!.important, true);

  now = 110;
  state = { ...state, stage: "tools", lit: ["prompt", "thinking", "tools"] };
  pacer.poke();
  state = { ...state, stage: "writing", lit: ["prompt", "thinking", "tools", "writing"] };
  pacer.poke();
  assert.equal(sent.length, 1, "inside the gap: held");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.state.stage, "writing", "the newest state, not each one between");

  now = 200;
  state = { ...state, tokens: 5000 };
  pacer.poke();
  assert.equal(sent.length, 2, "tokens alone wait for the longer gap");
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(sent.length, 3);
  assert.equal(sent[2]!.important, false, "a token-only update goes at low priority");
  pacer.stop();
});

test("tracker: the session meter starts from the newest reading and follows the turn's own", () => {
  const rate = (utilization: number) => ({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization, resetsAt: 1793068800 }, seven_day: { utilization: 0.49, resetsAt: 1793408400 } } },
  });
  assert.deepEqual(sessionMeter(rate(0.67)), { utilization: 0.67, resetsAt: 1793068800 });
  assert.equal(sessionMeter({ type: "assistant" }), null);
  assert.equal(sessionMeter(rate(1.4))!.utilization, 1, "held to the dial");

  const none = new TurnTracker(1000);
  assert.equal(none.state.session, undefined, "no reading yet: no meter");
  // The clock an hour before the window resets.
  let clock = (1793068800 - 3600) * 1000;
  const t = new TurnTracker(1000, { utilization: 0.66, resetsAt: 1793068800 }, () => clock);
  assert.equal(t.state.session, 0.66);
  t.feed(rate(0.71));
  assert.deepEqual([t.state.session, t.state.sessionResetsAt], [0.71, 1793068800]);
  // Past the reset, with no new reading yet (the next prompt brings one): the meter is back at zero.
  clock = 1793068800 * 1000;
  assert.deepEqual([t.state.session, t.state.sessionResetsAt], [0, 1793068800]);
  assert.deepEqual(windowNow({ utilization: 0.9 }, clock), { utilization: 0.9 }, "no reset time: the reading stands");
});

test("the start alert's body: the prompt on one line, short, or the title", () => {
  assert.equal(activityAlertBody("Fix  both\n\nplease", "t"), "Fix both please");
  assert.equal(activityAlertBody("   ", "The session"), "The session");
  assert.equal(activityAlertBody("x".repeat(300), "t").length, 120);
});

test("an upload by hand is a flight", () => {
  assert.equal(stageForTool("Bash", { command: "xcrun altool --upload-app -f a.ipa -t ios --p8-file-path k.p8" }), "flight");
  assert.equal(stageForTool("Bash", { command: "xcrun altool --help" }), "tools");
});

test("the session list's stage: the turn's, then a flight that outlived it, then how the turn ended", () => {
  const t = new TurnTracker(1000);
  t.feed({ type: "pipeline", stage: "build", status: "running", title: "building", ref: "b" });
  assert.deepEqual(sessionNow(t.state, [], null), { stage: "build", status: "working" });
  assert.deepEqual(sessionNow(null, ["flight"], { stage: "done", status: "done" }), { stage: "flight", status: "working" }, "a background upload after the turn");
  assert.deepEqual(sessionNow(null, [], { stage: "done", status: "failed" }), { stage: "done", status: "failed" });
  assert.equal(sessionNow(null, [], null), null, "nothing since the daemon started");
  assert.equal(sessionNow(null, [], { stage: "nonsense" }), null);
});
