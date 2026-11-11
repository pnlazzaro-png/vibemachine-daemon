// The push relay: what it lets through, its limits, and a daemon without a
// key sending through it, end to end with Apple swapped out.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { config } from "../src/config.js";
import { relaySend, type Transport } from "../src/push.js";
import { callerKey, createRelay, parseRelayRequest, PAYLOAD_MAX, RateLimit } from "../src/pushrelay.js";

const TOKEN = "ab".repeat(32);
const PAYLOAD = JSON.stringify({ aps: { alert: { title: "t", body: "b" } } });

test("parseRelayRequest: only this app's kinds of push, hex tokens, APNs JSON under 4 KB", () => {
  const ok = parseRelayRequest({ environment: "production", type: "alert", priority: 10, token: TOKEN.toUpperCase(), payload: PAYLOAD });
  assert.deepEqual(ok, { environment: "production", type: "alert", priority: "10", token: TOKEN, payload: PAYLOAD });
  assert.equal((parseRelayRequest({ type: "alert", token: TOKEN, payload: { aps: {} } }) as { environment: string }).environment, "sandbox");
  assert.match((parseRelayRequest({ type: "background", token: TOKEN, payload: PAYLOAD }) as { error: string }).error, /type/);
  assert.match((parseRelayRequest({ type: "alert", token: "not-hex", payload: PAYLOAD }) as { error: string }).error, /token/);
  assert.match((parseRelayRequest({ type: "alert", token: TOKEN, priority: 1, payload: PAYLOAD }) as { error: string }).error, /priority/);
  assert.match((parseRelayRequest({ type: "alert", token: TOKEN, payload: { nope: 1 } }) as { error: string }).error, /aps/);
  assert.match((parseRelayRequest({ type: "alert", token: TOKEN, payload: { aps: { x: "y".repeat(PAYLOAD_MAX) } } }) as { error: string }).error, /4096/);
});

test("RateLimit: so many a window, then room again", () => {
  const r = new RateLimit(2, 1000);
  assert.equal(r.allow("a", 0), true);
  assert.equal(r.allow("a", 10), true);
  assert.equal(r.allow("a", 20), false);
  assert.equal(r.allow("b", 20), true);
  assert.equal(r.allow("a", 1001), true);
});

test("relay end to end: it signs for this app's topic, passes Apple's answer back, and limits a token", { skip: !config.apns.keyId && "no APNS_KEY_ID in .env" }, async () => {
  const sent: Parameters<Transport>[0][] = [];
  const apple: Transport = async (req) => {
    sent.push(req);
    return req.token === TOKEN ? { status: 200 } : { status: 410, reason: "Unregistered" };
  };
  const server = createRelay({ transport: apple, perToken: 2 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix`;
  try {
    const r1 = await relaySend(base, { environment: "production", type: "liveactivity", priority: "5", token: TOKEN, payload: PAYLOAD });
    assert.deepEqual(r1, { status: 200, reason: undefined });
    assert.equal(sent[0]!.host, "https://api.push.apple.com");
    assert.equal(sent[0]!.headers["apns-topic"], `${config.apns.topic}.push-type.liveactivity`);
    assert.equal(sent[0]!.headers["apns-push-type"], "liveactivity");
    assert.match(sent[0]!.headers.authorization!, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const gone = await relaySend(base, { environment: "sandbox", type: "alert", priority: "10", token: "cd".repeat(32), payload: PAYLOAD });
    assert.deepEqual(gone, { status: 410, reason: "Unregistered" });
    await relaySend(base, { environment: "production", type: "alert", priority: "10", token: TOKEN, payload: PAYLOAD });
    const limited = await relaySend(base, { environment: "production", type: "alert", priority: "10", token: TOKEN, payload: PAYLOAD });
    assert.match(limited.reason ?? "", /relay 429/);
    const bad = await relaySend(base, { environment: "production", type: "alert", priority: "10", token: TOKEN, payload: "{}" });
    assert.match(bad.reason ?? "", /relay 400: payload must have an aps object/);
    const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; apns: boolean };
    assert.deepEqual(health, { ok: true, apns: true });
  } finally {
    server.close();
  }
});

test("relaySend: a relay that isn't there is a failed push, not a throw", async () => {
  const r = await relaySend("http://127.0.0.1:9", { environment: "sandbox", type: "alert", priority: "10", token: TOKEN, payload: PAYLOAD });
  assert.equal(r.status, 0);
  assert.match(r.reason ?? "", /^relay/);
});

test("relay: the caller's address comes from the socket, or the proxy's own header, never X-Forwarded-For", { skip: !config.apns.keyId && "no APNS_KEY_ID in .env" }, async (t) => {
  const { createRelay } = await import("../src/pushrelay.js");
  const sent: string[] = [];
  const server = createRelay({ perCaller: 2, transport: async (r) => (sent.push(r.token), { status: 200 }) });
  const trusting = createRelay({ perCaller: 1, clientHeader: "fly-client-ip", transport: async () => ({ status: 200 }) });
  // Closed whatever happens: a server left listening after a failed assertion keeps the test process alive.
  t.after(() => { server.close(); trusting.close(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const body = JSON.stringify({ environment: "development", type: "alert", priority: "10", token: "ab".repeat(32), payload: JSON.stringify({ aps: { alert: "hi" } }) });
  const post = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${port}/v1/push`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }).then((r) => r.status);
  // Spoofed forwarded addresses don't buy a fresh allowance: the third call from the one socket is refused.
  assert.equal(await post({ "x-forwarded-for": "1.1.1.1" }), 200);
  assert.equal(await post({ "x-forwarded-for": "2.2.2.2" }), 200);
  assert.equal(await post({ "x-forwarded-for": "3.3.3.3" }), 429);
  await new Promise<void>((r) => trusting.listen(0, "127.0.0.1", r));
  const p2 = (trusting.address() as { port: number }).port;
  const post2 = (ip: string) => fetch(`http://127.0.0.1:${p2}/v1/push`, { method: "POST", headers: { "content-type": "application/json", "fly-client-ip": ip }, body }).then((r) => r.status);
  assert.equal(await post2("5.5.5.5"), 200);
  assert.equal(await post2("5.5.5.5"), 429, "the same caller, by the proxy's header");
  assert.equal(await post2("6.6.6.6"), 200, "another caller, by the proxy's header");
});

test("RateLimit: quiet keys are swept once a window, and a flood of new keys can't grow the map", () => {
  const r = new RateLimit(2, 1000, 3);
  assert.equal(r.allow("a", 0), true);
  assert.equal(r.allow("b", 10), true);
  assert.equal(r.allow("c", 20), true);
  assert.equal(r.size, 3);
  // Full: a key not seen before is refused, the known ones carry on.
  assert.equal(r.allow("d", 30), false);
  assert.equal(r.allow("a", 40), true);
  assert.equal(r.size, 3);
  // A window later the quiet ones are gone, without waiting for ten thousand of them.
  assert.equal(r.allow("d", 1100), true);
  assert.equal(r.size, 1);
});

test("callerKey: an IPv6 caller is its /64, an IPv4 caller itself, mapped or not", () => {
  assert.equal(callerKey("203.0.113.7"), "203.0.113.7");
  assert.equal(callerKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(callerKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(callerKey("2001:db8:1:2::1"), callerKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
  assert.notEqual(callerKey("2001:db8:1:2::1"), callerKey("2001:db8:1:3::1"));
  assert.equal(callerKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(callerKey("::1"), "0:0:0:0::/64");
  assert.equal(callerKey("fe80::1%en0"), "fe80:0:0:0::/64");
  assert.equal(callerKey(""), "?");
});
