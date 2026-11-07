import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { LOG_MAX_BYTES, sweep } from "../src/housekeeping.js";

test("housekeeping: old deltas, attachments, crash reports, builds and big logs go; history stays", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-house-"));
  const store = new Store(":memory:");
  const now = Date.parse("2026-11-20T12:00:00Z");
  const old = new Date(now - 40 * 86_400_000).toISOString();
  const recent = new Date(now - 3_600_000).toISOString();
  store.insertSession({ id: "done", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: old });
  store.insertSession({ id: "live", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "running", created_at: old });
  const put = (session: string, ts: string, event: Record<string, unknown>) => store.db.prepare(`INSERT INTO events (session_id, ts, type, subtype, json) VALUES (?, ?, ?, ?, ?)`).run(session, ts, String(event.type), (event.subtype as string | undefined) ?? null, JSON.stringify(event));
  put("done", old, { type: "stream_event" });
  put("done", old, { type: "system", subtype: "thinking_tokens" });
  put("done", old, { type: "assistant" });
  put("done", recent, { type: "stream_event" });
  put("live", old, { type: "stream_event" });

  // An attachment from 40 days ago and one from today.
  fs.mkdirSync(path.join(dir, "attachments", "done"), { recursive: true });
  const oldFile = path.join(dir, "attachments", "done", "a.png");
  const newFile = path.join(dir, "attachments", "done", "b.png");
  fs.writeFileSync(oldFile, "x");
  fs.writeFileSync(newFile, "x");
  const insertAttachment = (id: string, file: string, at: string) => store.db.prepare(`INSERT INTO attachments (id, session_id, turn, name, media_type, path, size, created_at) VALUES (?, 'done', 1, ?, 'image/png', ?, 1, ?)`).run(id, path.basename(file), file, at);
  insertAttachment("11111111-1111-1111-1111-111111111111", oldFile, old);
  insertAttachment("22222222-2222-2222-2222-222222222222", newFile, recent);

  const age = (p: string, ms: number) => fs.utimesSync(p, new Date(now - ms), new Date(now - ms));
  fs.mkdirSync(path.join(dir, "diagnostics"));
  fs.writeFileSync(path.join(dir, "diagnostics", "old.json"), "{}");
  age(path.join(dir, "diagnostics", "old.json"), 40 * 86_400_000);
  fs.writeFileSync(path.join(dir, "diagnostics", "new.json"), "{}");
  age(path.join(dir, "diagnostics", "new.json"), 1000);
  for (const [name, days] of [["newest", 30], ["older", 31], ["oldest", 60]] as const) {
    fs.mkdirSync(path.join(dir, "install", name), { recursive: true });
    age(path.join(dir, "install", name), days * 86_400_000);
  }
  fs.mkdirSync(path.join(dir, "logs"));
  fs.writeFileSync(path.join(dir, "logs", "daemon.out.log"), Buffer.alloc(LOG_MAX_BYTES + 1));
  fs.writeFileSync(path.join(dir, "logs", "daemon.err.log"), "small");

  const s = sweep(store, dir, now);
  assert.deepEqual(s, { images: 0, deltas: 2, attachments: 1, diagnostics: 1, builds: 2, logs: 1, megabytesFreed: 0 });
  const left = (store.db.prepare(`SELECT session_id, type, ts FROM events ORDER BY seq`).all() as { session_id: string; type: string; ts: string }[]).map((r) => `${r.session_id}:${r.type}:${r.ts === old ? "old" : "new"}`);
  assert.deepEqual(left, ["done:assistant:old", "done:stream_event:new", "live:stream_event:old"], "messages stay, a running session keeps its deltas, today's stay");
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(newFile), true);
  assert.equal(store.getAttachment("11111111-1111-1111-1111-111111111111"), undefined);
  assert.deepEqual(fs.readdirSync(path.join(dir, "diagnostics")), ["new.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "install")), ["newest"], "the newest build stays however old");
  assert.equal(fs.statSync(path.join(dir, "logs", "daemon.out.log")).size, 0);
  assert.equal(fs.statSync(path.join(dir, "logs", "daemon.out.log.1")).size, LOG_MAX_BYTES + 1);
  assert.equal(fs.readFileSync(path.join(dir, "logs", "daemon.err.log"), "utf8"), "small");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("housekeeping: a screenshot's bytes leave a stored tool result, once; the file shrinks between turns", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-house-"));
  const store = new Store(path.join(dir, "db.sqlite"));
  store.insertSession({ id: "s", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "running", created_at: new Date().toISOString() });
  const shot = (n: number) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(1_000_000) } }] }] },
    tool_use_result: { type: "image", file: { base64: "x".repeat(1_000_000), type: "image/png" } },
  });
  for (let n = 0; n < 40; n++) store.db.prepare(`INSERT INTO events (session_id, ts, type, json) VALUES ('s', ?, 'user', ?)`).run(new Date().toISOString(), JSON.stringify(shot(n)));
  store.appendEvent("s", { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "plain", content: "a".repeat(300_000) }] } });

  const first = sweep(store, dir);
  assert.equal(first.images, 40);
  assert.equal(first.megabytesFreed, 0, "not while a turn runs");
  const kept = store.db.prepare(`SELECT json FROM events ORDER BY seq`).all() as { json: string }[];
  assert.ok(kept.slice(0, 40).every((r) => r.json.length < 1000));
  assert.equal(JSON.parse(kept[0].json).message.content[0].content[0].source.type, "omitted");
  assert.equal(JSON.parse(kept[40].json).message.content[0].content.length, 300_000, "texts are stored whole");

  store.db.prepare(`UPDATE sessions SET status = 'idle'`).run();
  const second = sweep(store, dir);
  assert.equal(second.images, 0, "only lines stored since are looked at");
  assert.ok(second.megabytesFreed >= 70, `freed ${second.megabytesFreed} MB`);
  store.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
