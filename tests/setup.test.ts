// `vm setup`'s plist and the checks that need no Mac to run.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../src/config.js";
import { installKind, installPrefix, lanAddresses, nodeCheck, pairingTarget, prefersWifi, projectsFolder, renderPlist, serverAddress, waitForIdle, wifiCheck, type TailscaleInfo, type WifiProbe } from "../src/setup.js";

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

test("setup's projects folder: taken as given, asked for when the default has no repos, left alone otherwise", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-setup-"));
  const empty = path.join(root, "dev");
  const code = path.join(root, "Code");
  fs.mkdirSync(empty);
  fs.mkdirSync(path.join(code, "app", ".git"), { recursive: true });
  const asked: string[] = [];
  const answer = (reply: string) => (q: string) => { asked.push(q); return Promise.resolve(reply); };
  try {
    // Said on the command line: no question.
    assert.equal(await projectsFolder({ projects: code }, empty, answer("unused")), code);
    assert.equal(asked.length, 0);
    // The default has no repos and someone is there: asked, and the answer taken.
    assert.equal(await projectsFolder({}, empty, answer(` ${code} `)), code);
    assert.match(asked[0]!, /No git repos directly inside .*dev\. Which folder holds your projects\?/);
    // Return alone, a dry run, nobody at the terminal, or a folder that already has repos: left as it is.
    assert.equal(await projectsFolder({}, empty, answer("")), null);
    assert.equal(await projectsFolder({ dryRun: true }, empty, answer(code)), null);
    assert.equal(await projectsFolder({}, empty, null), null);
    assert.equal(await projectsFolder({}, code, answer(empty)), null);
    assert.equal(asked.length, 2);
    // The folder already in use is no change; one that isn't there is refused.
    assert.equal(await projectsFolder({ projects: code }, code, null), null);
    await assert.rejects(projectsFolder({ projects: path.join(root, "nowhere") }, empty, null), /isn't a folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installKind: a package under node_modules is a package even inside someone's git work tree", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vm-kind-")));
  execFileSync("git", ["init", "-q", home]);
  // A home folder kept in git, with the package installed under it: never pulled.
  const installed = path.join(home, ".nvm", "versions", "node", "v24.1.0", "lib", "node_modules", "vibemachine-daemon");
  fs.mkdirSync(installed, { recursive: true });
  assert.equal(installKind(installed), "package");
  // The daemon's own repo, and the app's repo with daemon/ inside it, are clones.
  assert.equal(installKind(home), "clone");
  fs.mkdirSync(path.join(home, "daemon"));
  assert.equal(installKind(path.join(home, "daemon")), "clone");
  // Deeper inside some other repo is not this project's clone.
  fs.mkdirSync(path.join(home, "tools", "vm"), { recursive: true });
  assert.equal(installKind(path.join(home, "tools", "vm")), "package");
  assert.equal(installKind(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vm-nogit-")))), "package");
});

test("installPrefix: the npm prefix the running copy sits under, so update installs there", () => {
  assert.equal(installPrefix("/opt/homebrew/lib/node_modules/vibemachine-daemon"), "/opt/homebrew");
  assert.equal(installPrefix("/Users/x/.nvm/versions/node/v24.1.0/lib/node_modules/vibemachine-daemon"), "/Users/x/.nvm/versions/node/v24.1.0");
  assert.equal(installPrefix("/usr/local/lib/node_modules/vibemachine-daemon"), "/usr/local");
  assert.equal(installPrefix("/Users/x/dev/vibemachine/daemon"), null);
  assert.equal(installPrefix("/Users/x/project/node_modules/vibemachine-daemon"), null);
});

test("waitForIdle: restarts only after a quiet spell, and gives up in the end", async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => void slept.push(ms);
  // Busy for three checks, a prompt lands again after one quiet check, then quiet for good.
  const readings = [1, 1, 2, 0, 1, 0, 0, 0];
  let i = 0;
  assert.equal(await waitForIdle(() => readings[Math.min(i++, readings.length - 1)]!, { pollMs: 5, quietMs: 15, maxMs: 1000, sleep }), true);
  assert.equal(i, 8, "the quiet spell started over when a turn began");
  let asked = 0;
  assert.equal(await waitForIdle(() => (asked++, 1), { pollMs: 5, quietMs: 15, maxMs: 50, sleep }), false);
  assert.ok(asked >= 10);
});

test("Tailscale on the Mac but no iPhone on the tailnet: the code is for the Wi-Fi", () => {
  const serving: TailscaleInfo = { installed: true, running: true, dnsName: "mac.tail1.ts.net", serving: true, iosPeers: 1 };
  const alone: TailscaleInfo = { ...serving, iosPeers: 0 };
  assert.equal(prefersWifi(serving, true), false);
  assert.equal(prefersWifi(alone, true), true);
  assert.equal(prefersWifi(alone, false), false, "no Wi-Fi side to point at");
  assert.equal(prefersWifi(serving, true, true), true, "--wifi");
  // Tailscale didn't say who is on the tailnet: as before.
  assert.equal(prefersWifi({ installed: true, running: true, dnsName: "mac.tail1.ts.net", serving: true }, true), false);
  assert.match(serverAddress(alone, true, true), /\.local:\d+$/);
  assert.match(serverAddress(serving, true), /^https:\/\/mac\.tail1\.ts\.net:\d+$/);
  // The tailnet code says the phone needs Tailscale; asked for Wi-Fi with the side off, it says how.
  assert.match(pairingTarget(false, serving).note ?? "", /iPhone needs Tailscale too.*setup --wifi/);
  assert.match(pairingTarget(false, serving, true).note ?? "", /setup --wifi/);
  assert.equal(pairingTarget(false, { installed: false, running: false, dnsName: null, serving: false }).note, undefined);
});

test("lanAddresses: the Mac's own addresses on a local network, not loopback, a tailnet or a tunnel", () => {
  const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });
  assert.deepEqual(
    lanAddresses({
      lo0: [v4("127.0.0.1", true)],
      en0: [v4("192.168.1.20"), { ...v4("fe80::1"), family: "IPv6" as const, scopeid: 4 }],
      en5: [v4("169.254.10.2")],
      utun4: [v4("100.101.102.103")],
      en7: [v4("100.64.0.9")],
      bridge100: [v4("192.168.64.1")],
    }),
    ["192.168.1.20", "192.168.64.1"],
  );
});

test("wifiCheck: judged on the name and address the phone uses, and plain about what it can't know", () => {
  const good: WifiProbe = { name: "Sams-Mac.local", nameAnswers: true, ownCertificate: true, addresses: [{ address: "192.168.1.20", answers: true }], firewall: "off", program: "/opt/homebrew/bin/node" };
  const ok = wifiCheck(good, 3006);
  assert.equal(ok.ok, true);
  assert.match(ok.found, /https:\/\/Sams-Mac\.local:3006 \(192\.168\.1\.20\)/);
  assert.match(ok.found, /Checked from this Mac/);
  assert.match(wifiCheck({ ...good, firewall: "unknown" }, 3006).found, /macOS may ask/);

  const offline = wifiCheck({ ...good, addresses: [] }, 3006);
  assert.equal(offline.ok, false);
  assert.match(offline.found, /no address on a local network/);

  const down = wifiCheck({ ...good, nameAnswers: false, ownCertificate: null, addresses: [{ address: "192.168.1.20", answers: false }] }, 3006);
  assert.equal(down.ok, false);
  assert.match(down.found, /nothing answers on port 3006/);

  // 127.0.0.1 answered through all of these, which is why the old check passed.
  const blocked = wifiCheck({ ...good, firewall: "blocked" }, 3006);
  assert.equal(blocked.ok, false);
  assert.match(blocked.found, /firewall blocks/);
  const renamed = wifiCheck({ ...good, nameAnswers: false, ownCertificate: null }, 3006);
  assert.equal(renamed.ok, false);
  assert.match(renamed.found, /Sams-Mac\.local .* doesn't lead to this Mac/);
  const squatter = wifiCheck({ ...good, ownCertificate: false }, 3006);
  assert.equal(squatter.ok, false);
  assert.match(squatter.found, /something else answers/);
  assert.equal(typeof config.lanPort, "number");
});
