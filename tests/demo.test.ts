import assert from "node:assert/strict";
import { test } from "node:test";
import { demoEvents, scrub, scrubRules, slimInit } from "../src/demo.js";

test("scrub: the recording leaves without the home folder, the account, the Mac's names, the author or any email", () => {
  const rules = scrubRules({ home: "/Users/sam_jones", user: "sam_jones", hosts: ["Sams-MacBook.local", "Sams-MacBook"], names: ["Sam Jones"], emails: ["sam@jones.dev"] });
  const input = {
    session: { cwd: "/Users/sam_jones/dev/thing", title: "Fix the thing" },
    events: [
      { text: "Author: Sam Jones <sam@jones.dev>\nCo-authored-by: Pat <pat@example.org>" },
      { text: "serving https://sams-macbook.tail1234ab.ts.net:3005 and https://Sams-MacBook.local:3006 for sam_jones" },
      { "/Users/sam_jones/.claude/projects": 1 },
    ],
  };
  const out = scrub(input, rules);
  const text = JSON.stringify(out);
  for (const gone of ["sam_jones", "Sam Jones", "sam@jones.dev", "pat@example.org", "tail1234ab", "Sams-MacBook"]) assert.equal(text.includes(gone), false, `${gone} is still there`);
  assert.equal(out.session.cwd, "/Users/demo/dev/thing");
  assert.equal(out.events[0]!.text, "Author: Demo User <demo@example.com>\nCo-authored-by: Pat <demo@example.com>");
  assert.equal(out.events[1]!.text, "serving https://demo-mac.tailnet.ts.net:3005 and https://demo-mac:3006 for demo");
  assert.deepEqual(Object.keys(out.events[2]!), ["/Users/demo/.claude/projects"]);
  assert.equal(scrub(42, rules), 42);
});

test("the demo's init line keeps what the phone reads and drops the recording Mac's own setup", () => {
  const init = {
    type: "system", subtype: "init", session_id: "s", uuid: "u", model: "claude-fable-5-2", claude_code_version: "2.1.321", permissionMode: "acceptEdits", cwd: "/Users/sam/dev/thing",
    tools: ["Bash", "mcp__claude_ai_Gmail__send_message"], mcp_servers: [{ name: "claude.ai Gmail", status: "connected" }], plugins: [{ name: "x" }], skills: ["y"],
    memory_paths: { auto: "/Users/sam/.claude/projects/-Users-sam-dev-thing/memory/" }, messaging_socket_path: "/tmp/cc-socks/1.sock",
  };
  const slim = slimInit(init) as Record<string, unknown>;
  assert.deepEqual(Object.keys(slim).sort(), ["claude_code_version", "cwd", "model", "permissionMode", "session_id", "subtype", "type", "uuid"]);
  assert.equal(JSON.stringify(slim).includes("Gmail"), false);
  // Any other line passes through as it is.
  const other = { type: "assistant", message: { content: [] } };
  assert.equal(slimInit(other), other);
  // And the export's own pass uses it.
  const [row] = demoEvents([{ session_id: "s", seq: 1, ts: "2026-11-09T00:00:00.000Z", type: "system", subtype: "init", json: JSON.stringify(init) }]);
  assert.equal(JSON.stringify(row!.event).includes("memory_paths"), false);
});
