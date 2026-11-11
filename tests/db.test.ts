import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SCHEMA_VERSION, Store } from "../src/db.js";

test("db: the schema is versioned, a copy is kept before a migration, and the file is owner-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-db-"));
  const file = path.join(dir, "vibemachine.sqlite");
  const version = (s: Store) => (s.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;

  // A database from before versioning: marked, not copied.
  let s = new Store(file);
  s.db.exec(`PRAGMA user_version = 0`);
  s.insertSession({ id: "a", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: new Date().toISOString() });
  s.close();
  s = new Store(file);
  assert.equal(version(s), SCHEMA_VERSION);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".before-v")), []);
  s.close();

  // The next schema: a compact copy first, holding what was there.
  s = new Store(file, SCHEMA_VERSION + 1);
  assert.equal(version(s), SCHEMA_VERSION + 1);
  s.close();
  const copy = path.join(dir, `vibemachine.sqlite.before-v${SCHEMA_VERSION + 1}`);
  assert.ok(fs.existsSync(copy));
  const old = new Store(copy, SCHEMA_VERSION + 1);
  assert.equal(old.getSession("a")?.title, "t");
  old.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("db: a session archives and comes back without moving in the list", () => {
  const s = new Store(":memory:");
  s.insertSession({ id: "a", title: "older", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: "2026-10-30T10:00:00.000Z" });
  s.insertSession({ id: "b", title: "newer", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: "2026-10-31T10:00:00.000Z" });
  assert.equal(s.getSession("a")?.archived_at, null);
  const archived = s.setArchived("a", true)!;
  assert.ok(archived.archived_at && !Number.isNaN(Date.parse(archived.archived_at)));
  assert.equal(archived.updated_at, "2026-10-30T10:00:00.000Z");
  assert.deepEqual(s.listSessions().map((r) => r.id), ["b", "a"]);
  assert.equal(s.setArchived("a", false)?.archived_at, null);
  s.close();
});

test("db: a write waits for another connection instead of failing at once", () => {
  // The CLI opens the same file while the daemon is mid-turn; without this a clash was an instant
  // "database is locked", thrown inside a stream handler.
  const store = new Store(":memory:");
  assert.equal((store.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
  store.close();
});

test("db: a session's thumb is its newest picture that isn't a before, and its trail its last turns in order", () => {
  const s = new Store(":memory:");
  s.insertSession({ id: "a", title: "t", cwd: "/x", model: null, permission_mode: "default", status: "idle", created_at: new Date().toISOString() });
  assert.equal(s.sessionThumb("a"), null);
  assert.deepEqual(s.turnTrail("a"), []);

  s.insertCapture({ id: "c1", session_id: "a", turn: 1, screen: "Today", kind: "after", path: "/c1.png", width: 10, height: 20 });
  s.insertCapture({ id: "c2", session_id: "a", turn: 2, screen: "Today", kind: "before", path: "/c2.png", width: 10, height: 20 });
  assert.deepEqual(s.sessionThumb("a"), { id: "c1", width: 10, height: 20 });
  s.insertCapture({ id: "c3", session_id: "a", turn: 2, screen: "Today", kind: "look", path: "/c3.png", width: 30, height: 40 });
  assert.deepEqual(s.sessionThumb("a"), { id: "c3", width: 30, height: 40 });

  s.appendEvent("a", { type: "result", subtype: "success", duration_ms: 1200 });
  s.appendEvent("a", { type: "assistant" });
  s.appendEvent("a", { type: "result", subtype: "error_during_execution", duration_ms: 300.4 });
  s.appendEvent("a", { type: "result", subtype: "success" });
  assert.deepEqual(s.turnTrail("a"), [{ ms: 1200, ok: true }, { ms: 300, ok: false }, { ms: 0, ok: true }]);
  assert.deepEqual(s.turnTrail("a", 2), [{ ms: 300, ok: false }, { ms: 0, ok: true }]);
  s.close();
});
