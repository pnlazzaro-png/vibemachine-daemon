// The session manager against a stand-in for Claude Code: a child that answers the handshake, starts
// a turn and dies. The settings have to be in the environment before the daemon's modules load, so
// they are set here and the modules imported afterwards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-sessions-"));
const projects = path.join(root, "dev");
const repo = path.join(projects, "thing");
fs.mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });
const fake = path.join(root, "claude");
fs.writeFileSync(fake, `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === "control_request") { console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } })); return; }
  if (m.type === "user") {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "fake" }));
    process.stderr.write("warming up\\nerror: the model nope does not exist\\n");
    setTimeout(() => process.exit(1), 50);
  }
});
`, { mode: 0o755 });
Object.assign(process.env, { CLAUDE_BIN: fake, DATA_DIR: path.join(root, "data"), PROJECTS_DIR: projects, PORT: "3999", LAN: "0", APNS_KEY_ID: "", APNS_KEY_PATH: "", APNS_TEAM_ID: "", PUSH_RELAY: "" });

const { Store } = await import("../src/db.js");
const { KeepAwake } = await import("../src/keepawake.js");
const { SessionManager } = await import("../src/sessions.js");

test("a child that dies mid-turn ends the turn's Live Activity, says why, and leaves the others alone", async () => {
  const store = new Store(":memory:");
  const sessions = new SessionManager(store, new KeepAwake(null));
  const activity: string[] = [];
  const notes: { title: string; body: string }[] = [];
  sessions.on("activity", (a) => activity.push(a.event));
  sessions.on("notify", (n) => notes.push({ title: n.title, body: n.body }));
  const row = await sessions.create({ cwd: repo, prompt: "Do the thing" });
  const deadline = Date.now() + 8_000;
  while (store.getSession(row.id)?.status !== "failed" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  try {
    assert.equal(store.getSession(row.id)?.status, "failed");
    // The activity started with the turn and was ended with it, not left "working" on the Lock Screen.
    assert.deepEqual([activity[0], activity.at(-1)], ["start", "end"]);
    // The child's last words reach the stream and a push; the generic line is only a fallback.
    const exit = sessions.events(row.id, 0).map((e) => JSON.parse(e.json) as Record<string, unknown>).find((e) => e.type === "host" && e.subtype === "exit");
    assert.equal(exit?.code, 1);
    assert.match(String(exit?.stderr), /the model nope does not exist/);
    const stopped = notes.find((n) => n.title.endsWith("Claude Code stopped"));
    assert.equal(stopped?.body, "error: the model nope does not exist");
    // And the turn was closed on the stream for any phone replaying it.
    assert.ok(sessions.events(row.id, 0).some((e) => e.type === "host" && e.subtype === "turn_ended"));
  } finally {
    sessions.shutdown();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
