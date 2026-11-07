// `vm setup`'s plist and the checks that need no Mac to run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeCheck, renderPlist, serverAddress } from "../src/setup.js";

test("renderPlist: the agent runs the daemon through its launcher, no Node pinned, logging under the data dir", () => {
  const plist = renderPlist("com.vibemachine.daemon", "/Users/x/vibemachine/daemon", "/Users/x/Library/Application Support/VibeMachine/logs", "/Users/x");
  assert.match(plist, /<string>com\.vibemachine\.daemon<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/bin\/sh<\/string>\s*<string>\/Users\/x\/vibemachine\/daemon\/bin\/vibemachine<\/string>\s*<string>daemon<\/string>\s*<\/array>/);
  assert.doesNotMatch(plist, /bin\/node</);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/x\/vibemachine\/daemon<\/string>/);
  assert.match(plist, /VibeMachine\/logs\/daemon\.err\.log/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  // A path with an ampersand can't break the XML.
  assert.match(renderPlist("l", "/Users/a&b/d", "/l", "/h"), /a&amp;b/);
});

test("nodeCheck: 24 and up", () => {
  assert.equal(nodeCheck("v24.1.0").ok, true);
  assert.equal(nodeCheck("v26.5.0").ok, true);
  assert.equal(nodeCheck("v22.12.0").ok, false);
});

test("serverAddress: the tailnet name only when Serve fronts the port", () => {
  assert.match(serverAddress({ installed: true, running: true, dnsName: "mac.tail1.ts.net", serving: true }), /^https:\/\/mac\.tail1\.ts\.net:\d+$/);
  assert.match(serverAddress({ installed: true, running: true, dnsName: "mac.tail1.ts.net", serving: false }), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(serverAddress({ installed: false, running: false, dnsName: null, serving: false }), /^http:\/\//);
});
