// Which pushes are sent, and to whom (Pete, 2026-11-11: too many came). Each phone picks the kinds it
// wants; a turn stopped on purpose and an upload stopped for a newer prompt are never news.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { config } from "../src/config.js";
import { Store } from "../src/db.js";
import { Notifier, PUSH_DEFAULTS, pushKinds } from "../src/notifier.js";
import { buildPush, turnEndPush } from "../src/sessions.js";
import type { Transport } from "../src/push.js";

test("a phone's choices: its own where it said, the defaults elsewhere", () => {
  assert.deepEqual(pushKinds(null), PUSH_DEFAULTS);
  assert.equal(PUSH_DEFAULTS.build_failed, false, "a failed build is off until asked for");
  assert.equal(PUSH_DEFAULTS.permission && PUSH_DEFAULTS.stopped && PUSH_DEFAULTS.shipped && PUSH_DEFAULTS.turn_done, true);
  assert.deepEqual(pushKinds(JSON.stringify({ turn_done: false, build_failed: true, nonsense: true })), { ...PUSH_DEFAULTS, turn_done: false, build_failed: true });
  assert.deepEqual(pushKinds("not json"), PUSH_DEFAULTS);
  assert.deepEqual(pushKinds(JSON.stringify({ permission: "yes" })), PUSH_DEFAULTS, "only true or false counts");
});

test("a turn's end: done, stopped with the CLI's reason, or nothing when it was interrupted", () => {
  // Real result lines from this Mac's sessions, cut down.
  const done = turnEndPush("bloom", { type: "result", subtype: "success", is_error: false, result: "Done." }, "Added the card");
  assert.deepEqual(done, { kind: "turn_done", title: "bloom: done", body: "Added the card" });

  const limit = turnEndPush("vibemachine", { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 429, result: "You've hit your 5-hour limit · resets 6pm (America/New_York)" }, "caption");
  assert.deepEqual(limit, { kind: "stopped", title: "vibemachine: usage limit", body: "You've hit your 5-hour limit · resets 6pm (America/New_York)" });

  const credits = turnEndPush("x", { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 429, result: "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai" }, "c");
  assert.equal(credits?.title, "x: usage limit");

  const dropped = turnEndPush("x", { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "API Error: Connection dropped (ECONNRESET)" }, "c");
  assert.deepEqual(dropped, { kind: "stopped", title: "x: stopped", body: "API Error: Connection dropped (ECONNRESET)" });

  const maxTurns = turnEndPush("x", { type: "result", subtype: "error_max_turns", is_error: true }, "the caption");
  assert.deepEqual(maxTurns, { kind: "stopped", title: "x: stopped", body: "the caption" });

  assert.equal(turnEndPush("x", { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }, "c"), null, "stopped while Claude wrote");
  assert.equal(turnEndPush("x", { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" }, "c"), null, "stopped while a tool ran");
});

test("a build's end: an upload that landed, a build that failed, nothing for a stopped upload", () => {
  assert.deepEqual(buildPush("vm", { stage: "archive", ok: true, title: "uploaded to TestFlight", detail: "build 202611111010; Apple processes it next", shipped: true }),
    { kind: "shipped", title: "vm: on TestFlight", body: "build 202611111010; Apple processes it next" });
  assert.equal(buildPush("vm", { stage: "build", ok: true, detail: "" }), null, "a build that worked is no news");
  assert.equal(buildPush("vm", { stage: "archive", ok: true, title: "already on TestFlight", detail: "build 1 carries this app" }), null);
  assert.deepEqual(buildPush("vm", { stage: "build", ok: false, detail: "error: no such module 'Foo'" }), { kind: "build_failed", title: "vm: build failed", body: "error: no such module 'Foo'" });
  assert.equal(buildPush("vm", { stage: "archive", ok: false, title: "upload stopped", detail: "a newer prompt was queued", deliberate: true }), null);
});

// The send goes through the transport only with an APNs key to sign it (push.ts), as push.test.ts's notifier test.
test("the notifier sends a phone only the kinds it wants", { skip: !config.apns.keyId && "no APNS_KEY_ID in .env" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-kinds-"));
  const store = new Store(path.join(dir, "t.sqlite"));
  const session = "22222222-2222-2222-2222-222222222222";
  store.insertDevice({ id: "duo", name: "Duo", public_key: "x" });
  store.insertDevice({ id: "other", name: "Other", public_key: "x" });
  store.setPushToken("duo", "ab".repeat(32), "sandbox");
  store.setPushToken("other", "cd".repeat(32), "sandbox");
  store.setPushKinds("duo", JSON.stringify({ turn_done: false, build_failed: true }));
  const sent: string[] = [];
  const transport: Transport = async (req) => {
    sent.push(req.token.slice(0, 2));
    return { status: 200 };
  };
  const notifier = new Notifier(store, () => false, transport);
  Object.defineProperty(notifier, "enabled", { get: () => true });
  try {
    await notifier.notify({ sessionId: session, kind: "turn_done", title: "t", body: "b" });
    assert.deepEqual(sent, ["cd"], "the Duo turned turn ends off; the other phone has the defaults");
    sent.length = 0;
    await notifier.notify({ sessionId: session, kind: "build_failed", title: "t", body: "b" });
    assert.deepEqual(sent, ["ab"], "only the Duo asked for failed builds");
    sent.length = 0;
    await notifier.notify({ sessionId: session, kind: "permission", title: "t", body: "b", requestId: "r" });
    assert.deepEqual(sent.sort(), ["ab", "cd"]);
    // A Live Activity's card moves along regardless; its banner only for a phone that wants the kind.
    store.setActivityToken("duo", session, "ef".repeat(32), "sandbox");
    store.setPushKinds("duo", JSON.stringify({ shipped: false }));
    const payloads: Record<string, any>[] = [];
    const notifier2 = new Notifier(store, () => false, async (req) => {
      payloads.push(JSON.parse(req.payload));
      return { status: 200 };
    });
    Object.defineProperty(notifier2, "enabled", { get: () => true });
    await notifier2.activity({ sessionId: session, event: "update", state: { stage: "flight" }, alert: { title: "NEW RECORD", body: "shipped in 4:12" }, alertKind: "shipped" });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.aps.alert, undefined, "the card, without the banner");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
