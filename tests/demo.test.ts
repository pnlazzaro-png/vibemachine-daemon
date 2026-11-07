import assert from "node:assert/strict";
import { test } from "node:test";
import { scrub, scrubRules } from "../src/demo.js";

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
