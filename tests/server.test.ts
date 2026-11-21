// The server's small helpers, and the command line's answers that must touch nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { inlineDisposition, sendFile } from "../src/server.js";

const daemonDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("an attachment's name outside Latin-1 still makes a header (audit D15)", () => {
  for (const name of ["スクリーンショット.png", "Screenshot 2026-11-09 at 3.44.10 PM.png", 'a "quoted"\r\n name.txt', "plain.pdf"]) {
    const header = inlineDisposition(name);
    assert.match(header, /^[\x20-\x7e]+$/, `only printable ASCII in: ${header}`);
    const starred = /filename\*=UTF-8''(.+)$/.exec(header)?.[1];
    assert.equal(decodeURIComponent(starred ?? ""), name);
  }
  assert.match(inlineDisposition("plain.pdf"), /^inline; filename="plain\.pdf";/);
});

test("--version, help and a typo write no key or database; a typo fails (audit S13)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-cli-"));
  const dataDir = path.join(dir, "data");
  const env = { ...process.env, DATA_DIR: dataDir };
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: daemonDir, env, encoding: "utf8" });
  const version = (JSON.parse(fs.readFileSync(path.join(daemonDir, "package.json"), "utf8")) as { version: string }).version;
  assert.equal(run("--version").stdout.trim(), version);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, new RegExp(`^Vibe Machine daemon ${version.replaceAll(".", "\\.")}`));
  assert.match(help.stdout, /vibemachine setup/);
  assert.doesNotMatch(help.stdout, /export-demo/);
  // Help asked of a command is help: `uninstall --help` must not uninstall.
  const asked = run("uninstall", "--help");
  assert.equal(asked.status, 0);
  assert.match(asked.stdout, /^Vibe Machine daemon/);
  assert.doesNotMatch(asked.stdout + asked.stderr, /removed|unloaded|bootout/i);
  const typo = run("stup");
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /no such command: stup/);
  // The settings make the folder itself as they load; nothing goes in it (no key, no database).
  assert.deepEqual(fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [], [], "asking for help wrote into the data folder");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file goes down whole, and one that can't be read ends the response, not the process (audit D18)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-send-"));
  const file = path.join(dir, "big.bin");
  fs.writeFileSync(file, Buffer.alloc(300_000, 7));
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    sendFile(req.url === "/gone" ? path.join(dir, "missing.bin") : file, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const whole = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal((await whole.arrayBuffer()).byteLength, 300_000);
  await assert.rejects(async () => { await (await fetch(`http://127.0.0.1:${port}/gone`)).arrayBuffer(); });
  // Still serving after the failed read.
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/`)).arrayBuffer()).byteLength, 300_000);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
