// Pushes without Apple: the payloads, the provider token, and the notifier's
// choice of who gets what, with a fake transport.
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { config } from "../src/config.js";
import { Store } from "../src/db.js";
import { Notifier } from "../src/notifier.js";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { activityStartPayload, activityUpdatePayload, alertPayload, apnsTransport, providerToken, validToken, type Transport } from "../src/push.js";

test("alert payload: a permission prompt is time-sensitive with buttons; a turn end is not", () => {
  const permission = JSON.parse(alertPayload({ title: "vibemachine needs your OK", body: "Bash · build it", sessionId: "s1", requestId: "r1" })) as Record<string, any>;
  assert.equal(permission.aps.category, "vm.permission");
  assert.equal(permission.aps["interruption-level"], "time-sensitive");
  assert.equal(permission.aps["thread-id"], "s1");
  assert.equal(permission.request_id, "r1");
  const turn = JSON.parse(alertPayload({ title: "vibemachine: done", body: "x".repeat(2000), sessionId: "s1" })) as Record<string, any>;
  assert.equal(turn.aps.category, "vm.session");
  assert.equal(turn.request_id, undefined);
  assert.ok(turn.aps.alert.body.length <= 1000);
});

test("live activity payloads", () => {
  const start = JSON.parse(activityStartPayload({ attributes: { sessionId: "s1", project: "x", title: "t" }, state: { stage: "build", status: "running", detail: "" } }, 1_700_000_000_000)) as Record<string, any>;
  assert.equal(start.aps.event, "start");
  assert.equal(start.aps["attributes-type"], "TurnActivityAttributes");
  // iOS drops a push-to-start without an alert that has a title and a body; a quiet one has no sound.
  const quiet = JSON.parse(activityStartPayload({ attributes: {}, state: {}, alert: { title: "vibemachine", body: "Fix both" }, quiet: true })) as Record<string, any>;
  assert.deepEqual(quiet.aps.alert, { title: "vibemachine", body: "Fix both" });
  assert.equal(quiet.aps.sound, undefined);
  assert.equal(start.aps.timestamp, 1_700_000_000);
  assert.equal(start.aps.attributes.project, "x");
  const end = JSON.parse(activityUpdatePayload({ event: "end", state: { stage: "build", status: "done", detail: "" }, dismissAt: new Date(1_700_000_900_000) })) as Record<string, any>;
  assert.equal(end.aps.event, "end");
  assert.equal(end.aps["dismissal-date"], 1_700_000_900);
  assert.equal(end.aps.alert, undefined);
});

test("provider token is an ES256 JWT for the team", { skip: !config.apns.keyId && "no APNS_KEY_ID in .env" }, () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwt = providerToken(1_700_000_000_000, privateKey);
  const [h, p, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "ES256", kid: config.apns.keyId });
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString()) as { iss: string; iat: number };
  assert.equal(payload.iss, config.apns.teamId);
  assert.equal(payload.iat, 1_700_000_000);
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url")));
});

test("tokens are hex", () => {
  assert.ok(validToken("ab".repeat(32)));
  assert.ok(!validToken("not hex"));
  assert.ok(!validToken(42));
});

test("notifier: skips a phone watching the session, drops a token Apple says is gone, drives the activity", { skip: !config.apns.keyId && "no APNS_KEY_ID in .env" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-push-"));
  const store = new Store(path.join(dir, "t.sqlite"));
  const session = "11111111-1111-1111-1111-111111111111";
  store.insertDevice({ id: "phone", name: "Duo", public_key: "x" });
  store.insertDevice({ id: "cli", name: "vm", public_key: "x" });
  store.setPushToken("phone", "ab".repeat(32), "sandbox");
  store.setActivityStartToken("phone", "ef".repeat(32));
  store.insertSession({ id: session, title: "t", cwd: dir, model: null, permission_mode: "default", status: "idle", created_at: new Date().toISOString() });
  const sent: { token: string; type: string; payload: Record<string, any> }[] = [];
  let answer: { status: number; reason?: string } = { status: 200 };
  const transport: Transport = async (req) => {
    sent.push({ token: req.token, type: req.headers["apns-push-type"]!, payload: JSON.parse(req.payload) });
    return answer;
  };
  let watching = true;
  const notifier = new Notifier(store, () => watching, transport);

  await notifier.notify({ sessionId: session, kind: "turn_done", title: "t", body: "b" });
  assert.equal(sent.length, 0, "watching the session: no push");
  watching = false;
  await notifier.notify({ sessionId: session, kind: "permission", title: "t", body: "b", requestId: "r" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.type, "alert");
  assert.equal(sent[0]!.payload.aps.category, "vm.permission");

  // The build starts: push-to-start; the app reports the activity's token; the build ends through it.
  await notifier.activity({ sessionId: session, event: "start", attributes: { sessionId: session, project: "x", title: "t" }, state: { stage: "build", status: "running", detail: "" } });
  assert.equal(sent[1]!.token, "ef".repeat(32));
  assert.equal(sent[1]!.payload.aps.event, "start");
  await notifier.activity({ sessionId: session, event: "end", state: { stage: "build", status: "done", detail: "" } });
  assert.equal(sent.length, 2, "no activity token yet: nothing to end");
  store.setActivityToken("phone", session, "cd".repeat(32), "sandbox");
  await notifier.activity({ sessionId: session, event: "start", attributes: {}, state: { stage: "build", status: "running", detail: "" } });
  assert.equal(sent[2]!.token, "cd".repeat(32));
  assert.equal(sent[2]!.payload.aps.event, "update", "a second build updates the activity on screen");
  await notifier.activity({ sessionId: session, event: "end", state: { stage: "build", status: "done", detail: "" }, dismissAt: new Date() });
  assert.equal(sent[3]!.payload.aps.event, "end");
  assert.equal(store.activityTokens(session).length, 0, "ended: token forgotten");

  answer = { status: 410, reason: "Unregistered" };
  await notifier.notify({ sessionId: session, kind: "turn_done", title: "t", body: "b" });
  assert.equal(store.pushDevices().length, 0, "a gone token is dropped");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("apns transport: pushes share one connection, and one Apple has closed is replaced", async () => {
  // A stand-in for Apple: counts connections, answers 200, and can hang up on everyone.
  const sessions = new Set<http2.ServerHttp2Session>();
  let opened = 0;
  const seen: string[] = [];
  const apple = http2.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200);
    res.end();
  });
  apple.on("session", (s) => {
    opened += 1;
    sessions.add(s);
    s.on("close", () => sessions.delete(s));
  });
  await new Promise<void>((resolve) => apple.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${(apple.address() as AddressInfo).port}`;
  const transport = apnsTransport({ idleMs: 150, timeoutMs: 2000 });
  const push = (token: string) => transport({ host, token, headers: {}, payload: "{}" });
  try {
    assert.deepEqual(await Promise.all([push("a1"), push("a2"), push("a3")]), [{ status: 200, reason: undefined }, { status: 200, reason: undefined }, { status: 200, reason: undefined }]);
    assert.equal((await push("a4")).status, 200);
    assert.equal(opened, 1, "four pushes, one connection");
    assert.deepEqual(seen.sort(), ["/3/device/a1", "/3/device/a2", "/3/device/a3", "/3/device/a4"]);

    // Apple hangs up (it does after an hour, or on a bad provider token): the next push still lands.
    for (const s of sessions) s.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await push("b1")).status, 200);
    assert.equal(opened, 2);

    // Left quiet, the connection is closed; the push after that opens another.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(sessions.size, 0, "closed after the idle spell");
    assert.equal((await push("c1")).status, 200);
    assert.equal(opened, 3);
  } finally {
    transport.close();
    for (const s of sessions) s.destroy();
    await new Promise<void>((resolve) => apple.close(() => resolve()));
  }
});

test("apns transport: nobody there is a failed push with a reason, not a throw", async () => {
  const transport = apnsTransport({ timeoutMs: 1000 });
  const sent = await transport({ host: "http://127.0.0.1:9", token: "a1", headers: {}, payload: "{}" });
  assert.equal(sent.status, 0);
  assert.ok(sent.reason);
  transport.close();
});
