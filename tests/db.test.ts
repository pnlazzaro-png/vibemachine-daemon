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
