// The Wi-Fi listener's pieces: the certificate and its fingerprint, the pairing link, the guard on
// wrong codes, the env line `vm setup` writes, and which address the phone is given.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureTls, fingerprintOf, pairingLink, PairingGuard } from "../src/lan.js";
import { serverAddress, setEnvLine } from "../src/setup.js";

test("ensureTls: a P-256 certificate named for the host, made once, pinned by its SHA-256", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-tls-"));
  const a = ensureTls(dir, "test-mac.local");
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(a.fingerprint, fingerprintOf(a.cert));
  // Apple's TLS refuses a key whose curve is spelled out rather than named.
  assert.equal(new X509Certificate(a.cert).publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.equal(ensureTls(dir, "test-mac.local").fingerprint, a.fingerprint, "kept, not remade");
  assert.equal((fs.statSync(path.join(dir, "key.pem")).mode & 0o777).toString(8), "600");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pairingLink: the server, the code, and the fingerprint when there is one", () => {
  const link = new URL(pairingLink("https://mac.local:3006", "123456", "ab".repeat(32)));
  assert.equal(link.protocol, "vibemachine:");
  assert.equal(link.host, "pair");
  assert.equal(link.searchParams.get("s"), "https://mac.local:3006");
  assert.equal(link.searchParams.get("c"), "123456");
  assert.equal(link.searchParams.get("fp"), "ab".repeat(32));
  assert.equal(new URL(pairingLink("https://mac.ts.net:3005", "1")).searchParams.has("fp"), false);
});

test("PairingGuard: ten wrong codes in ten minutes, then a wait", () => {
  const g = new PairingGuard(3, 1000);
  for (let i = 0; i < 3; i++) g.failed("10.0.0.2", i);
  assert.equal(g.blocked("10.0.0.2", 10), true);
  assert.equal(g.blocked("10.0.0.3", 10), false, "another client still gets its tries");
  assert.equal(g.blocked("10.0.0.2", 1500), false);
  // Everyone together: five times the per-client limit, from any number of addresses.
  const all = new PairingGuard(2, 1000);
  for (let i = 0; i < 10; i++) all.failed(`10.0.0.${i}`, i);
  assert.equal(all.blocked("10.0.0.99", 20), true);
});

test("setEnvLine: replaces a set or commented line, else appends", () => {
  assert.equal(setEnvLine("A=1\nLAN=0\nB=2\n", "LAN", "1"), "A=1\nLAN=1\nB=2\n");
  assert.equal(setEnvLine("A=1\n# LAN=0\n", "LAN", "1"), "A=1\nLAN=1\n");
  assert.equal(setEnvLine("A=1", "LAN", "1"), "A=1\nLAN=1\n");
});

test("serverAddress: the tailnet first, then the Wi-Fi, then loopback", () => {
  const off = { installed: false, running: false, dnsName: null, serving: false };
  assert.match(serverAddress({ installed: true, running: true, dnsName: "mac.t.ts.net", serving: true }, true), /^https:\/\/mac\.t\.ts\.net:/);
  assert.match(serverAddress(off, true), /^https:\/\/.+\.local:\d+$/);
  assert.match(serverAddress(off, false), /^http:\/\/127\.0\.0\.1:/);
});
