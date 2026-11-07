// `vm setup` and `vm doctor`: put the daemon on someone's Mac.
// Setup writes .env from the example, installs the LaunchAgent, waits for
// the daemon to answer, fronts it with Tailscale Serve when Tailscale is
// there, and prints a pairing code with the address to type on the phone.
// Doctor checks each thing the phone needs and says what to do about the
// ones that are missing. Both are run by hand; nothing here is automatic.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { newPairingCode } from "./auth.js";
import { ensureTls, lanAddress, pairingLink, printQr } from "./lan.js";
import { ffmpegAvailable } from "./video.js";
import { cliName, config, daemonRoot, defaultDataDir, envFile as configEnvFile, packageVersion, toolPath } from "./config.js";
import type { Store } from "./db.js";

export interface Check {
  ok: boolean;
  /** What was checked, in a few words. */
  what: string;
  /** What was found. */
  found: string;
  /** What to do when it isn't ok. */
  fix?: string;
  /** A missing optional part: a warning, not a failure. */
  optional?: boolean;
}

/**
 * A LaunchAgent plist that runs the daemon from `dir`, logging under `logDir`. It starts the
 * package's own launcher (`bin/vibemachine daemon`), which finds a new enough Node at every start,
 * so no Node path is pinned here to vanish when a version manager upgrades Node.
 */
export function renderPlist(label: string, dir: string, logDir: string, home: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${esc(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${["/bin/sh", path.join(dir, "bin", "vibemachine"), "daemon"].map((a) => `\t\t<string>${esc(a)}</string>`).join("\n")}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${esc(dir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>HOME</key>
\t\t<string>${esc(home)}</string>
\t\t<key>PATH</key>
\t\t<string>${esc(home)}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Applications/Tailscale.app/Contents/MacOS:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<!-- Not Background: Claude, builds and tests run as this daemon's children and would be throttled with it. -->
\t<key>ProcessType</key>
\t<string>Standard</string>
\t<key>StandardOutPath</key>
\t<string>${esc(path.join(logDir, "daemon.out.log"))}</string>
\t<key>StandardErrorPath</key>
\t<string>${esc(path.join(logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
}

/** Node 24 brought node:sqlite out from behind a flag; the daemon needs it. */
export function nodeCheck(version: string = process.version): Check {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return { ok: major >= 24, what: "Node", found: version, fix: "install Node 24 or newer (brew install node)" };
}

function run(cmd: string, args: string[], timeoutMs = 15_000): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, env: { ...process.env, PATH: toolPath } });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function which(cmd: string): string | null {
  const r = run("/usr/bin/which", [cmd]);
  return r.ok && r.out ? r.out.split("\n")[0]! : null;
}

/** What `claude auth status --json` says, if the CLI is there and signed in. */
export function claudeCheck(): Check {
  const bin = config.claudeBin;
  const exists = path.isAbsolute(bin) ? fs.existsSync(bin) : which(bin) !== null;
  if (!exists) return { ok: false, what: "Claude Code", found: `not found (${bin})`, fix: "install Claude Code (https://code.claude.com), or set CLAUDE_BIN in .env" };
  const version = run(bin, ["--version"]);
  const status = run(bin, ["auth", "status", "--json"]);
  interface AuthStatus {
    loggedIn?: boolean;
    authMethod?: string;
    subscriptionType?: string;
  }
  let parsed: AuthStatus | null = null;
  try {
    parsed = JSON.parse(status.out.slice(status.out.indexOf("{"))) as AuthStatus;
  } catch {
    parsed = null;
  }
  const v = version.ok ? version.out.split("\n")[0] : "version unknown";
  if (!parsed) return { ok: false, what: "Claude Code", found: `${v}; sign-in status unknown`, fix: "run `claude` once in a terminal and sign in" };
  if (!parsed.loggedIn) return { ok: false, what: "Claude Code", found: `${v}; not signed in`, fix: "run `claude` once in a terminal and sign in with your own account" };
  const how = parsed.authMethod === "claude.ai" ? `claude.ai${parsed.subscriptionType ? ` (${parsed.subscriptionType})` : ""}` : (parsed.authMethod ?? "signed in");
  return { ok: true, what: "Claude Code", found: `${v}; signed in via ${how}` };
}

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  /** Serve already fronts the daemon's port with HTTPS. */
  serving: boolean;
}

export function tailscale(): TailscaleInfo {
  const bin = which("tailscale") ?? (fs.existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale") ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : null);
  if (!bin) return { installed: false, running: false, dnsName: null, serving: false };
  const status = run(bin, ["status", "--json"]);
  let dnsName: string | null = null;
  let running = false;
  try {
    const j = JSON.parse(status.out) as { BackendState?: string; Self?: { DNSName?: string } };
    running = j.BackendState === "Running";
    dnsName = j.Self?.DNSName?.replace(/\.$/, "") ?? null;
  } catch {
    /* not running, or an old client */
  }
  const serve = run(bin, ["serve", "status"]);
  const serving = serve.ok && new RegExp(`:${config.port}\\b[\\s\\S]*?proxy http://${config.host}:${config.port}`).test(serve.out);
  return { installed: true, running, dnsName, serving };
}

/** The address the phone uses: the tailnet HTTPS name when Serve fronts the port (it works at home
 *  and away), else the Wi-Fi listener when it's on, else loopback (this Mac only: the simulator). */
export function serverAddress(ts: TailscaleInfo, lan = config.lan): string {
  if (ts.running && ts.dnsName && ts.serving) return `https://${ts.dnsName}:${config.port}`;
  if (lan) return lanAddress();
  return `http://${config.host}:${config.port}`;
}

/** Where the phone should pair, and the certificate to pin when that's the Wi-Fi listener. */
export function pairingTarget(lan = config.lan, ts: TailscaleInfo = tailscale()): { address: string; fingerprint?: string } {
  const address = serverAddress(ts, lan);
  return address.startsWith("https://") && address === lanAddress() ? { address, fingerprint: ensureTls().fingerprint } : { address };
}

/** A fresh pairing code, printed with the address and as a QR code the phone's Camera opens in the app. */
export async function printPairing(store: Store, target: { address: string; fingerprint?: string }): Promise<void> {
  const code = newPairingCode();
  store.createPairingCode(code, new Date(Date.now() + config.pairingMinutes * 60_000));
  const link = pairingLink(target.address, code, target.fingerprint);
  console.log("");
  console.log("Scan this with the iPhone's Camera, or with Scan on Vibe Machine's pairing screen:");
  await printQr(link);
  console.log(`  Server:        ${target.address}`);
  console.log(`  Pairing code:  ${code}  (valid ${config.pairingMinutes} minutes; \`vibemachine pair\` prints another)`);
  if (target.fingerprint) console.log(`  Certificate:   ${target.fingerprint.slice(0, 16)}… (the phone pins it from the QR code)`);
  if (target.address.startsWith("http://127.")) console.log("  The phone can't reach 127.0.0.1: run `vibemachine setup --lan`, or install Tailscale on both and run `vibemachine setup` again.");
}

/** Sets KEY=value in an env file, replacing a line (commented or not) that sets it. */
export function setEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
}

/** The Wi-Fi listener answers, whatever its certificate (that's for the phone to check). */
function lanHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get({ host: "127.0.0.1", port: config.lanPort, path: "/health", rejectUnauthorized: false, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Does the push relay answer, with a key? */
async function relayHealth(relay: string): Promise<boolean> {
  if (!relay) return false;
  try {
    const res = await fetch(relay.replace(/\/+$/, "") + "/health", { signal: AbortSignal.timeout(5000) });
    const j = (await res.json()) as { ok?: boolean; apns?: boolean };
    return res.ok && j.ok === true && j.apns === true;
  } catch {
    return false;
  }
}

async function health(): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(3000) });
    const j = (await res.json()) as { ok?: boolean; version?: string };
    return { ok: res.ok && j.ok === true, ...(j.version ? { version: j.version } : {}) };
  } catch {
    return { ok: false };
  }
}

/** The LaunchAgent label: whatever vibemachine agent is already installed (an older install may carry another prefix), else the plain one. */
export function launchdLabel(): string {
  if (process.env.LAUNCHD_LABEL?.trim()) return process.env.LAUNCHD_LABEL.trim();
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  try {
    const found = fs.readdirSync(dir).find((f) => /vibemachine\.daemon\.plist$/.test(f));
    if (found) return found.replace(/\.plist$/, "");
  } catch {
    /* no LaunchAgents folder yet */
  }
  return "com.vibemachine.daemon";
}

function launchdState(label: string): string | null {
  const r = run("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${label}`]);
  if (!r.ok) return null;
  return r.out.match(/^\s*state = (\w+)/m)?.[1] ?? "loaded";
}

function gitRepos(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, ".git"))).length;
  } catch {
    return -1;
  }
}

/** Every check the phone's first run depends on. */
export async function doctor(store: Store): Promise<Check[]> {
  const checks: Check[] = [nodeCheck(), claudeCheck()];
  checks.push({ ok: fs.existsSync(configEnvFile), what: ".env", found: fs.existsSync(configEnvFile) ? configEnvFile : "missing", fix: "run `vibemachine setup` (it copies .env.example)" });
  const h = await health();
  const label = launchdLabel();
  const state = launchdState(label);
  checks.push({
    ok: h.ok,
    what: "Daemon",
    found: h.ok ? `answering on ${config.host}:${config.port}${h.version ? ` (v${h.version})` : ""}` : `not answering on ${config.host}:${config.port}; LaunchAgent ${label} ${state ?? "not installed"}`,
    fix: state ? `see the logs under ${path.join(config.dataDir, "logs")}` : "run `vibemachine setup` to install the LaunchAgent",
  });
  const ts = tailscale();
  checks.push({
    ok: ts.installed && ts.running && ts.serving,
    optional: true,
    what: "Tailscale",
    found: !ts.installed ? "not installed" : !ts.running ? "installed, not connected" : ts.serving ? `serving ${serverAddress(ts)}` : `connected as ${ts.dnsName ?? "?"}, not serving the daemon`,
    fix: !ts.installed ? "install Tailscale on the Mac and the phone to reach the daemon away from home (https://tailscale.com)" : !ts.running ? "open Tailscale and sign in" : `run \`tailscale serve --bg --https=${config.port} http://${config.host}:${config.port}\` (or \`vibemachine setup\`)`,
  });
  if (config.lan) {
    const up = await lanHealth();
    checks.push({ ok: up, what: "Wi-Fi", found: up ? `answering at ${lanAddress()}` : `LAN=1 but nothing answers on port ${config.lanPort}`, fix: "restart the daemon (`vibemachine setup`), and allow incoming connections for node if macOS asks" });
  } else if (!(ts.installed && ts.running && ts.serving)) {
    checks.push({ ok: false, what: "Wi-Fi", found: "off, and no Tailscale: the phone has no way in", fix: "run `vibemachine setup --lan` to serve the phone on this Wi-Fi" });
  }
  const repos = gitRepos(config.projectsDir);
  checks.push({ ok: repos > 0, what: "Projects", found: repos < 0 ? `${config.projectsDir} does not exist` : `${repos} git repos under ${config.projectsDir}`, fix: "set PROJECTS_DIR in .env to the folder your repos live in" });
  const phones = store.listDevices().filter((d) => !d.id.startsWith("cli-"));
  checks.push({ ok: phones.length > 0, optional: true, what: "Paired phones", found: phones.length > 0 ? phones.map((d) => d.name).join(", ") : "none yet", fix: "run `vibemachine pair` and scan the code with the app" });
  const apns = !!(config.apns.keyId && config.apns.teamId && config.apns.keyPath);
  const relay = apns ? null : await relayHealth(config.pushRelay);
  checks.push({
    ok: apns || relay === true,
    optional: true,
    what: "Pushes",
    found: apns ? `APNs key ${config.apns.keyId}` : !config.pushRelay ? "off (no APNs key, no PUSH_RELAY)" : relay ? `through the relay at ${config.pushRelay}` : `the relay at ${config.pushRelay} isn't answering`,
    fix: "permission prompts, turn ends and the build Live Activity reach the phone only while the app is open; set PUSH_RELAY in .env (or an APNs key) to turn pushes on",
  });
  const simctl = run("/usr/bin/xcrun", ["simctl", "help"], 10_000).ok;
  checks.push({ ok: simctl, optional: true, what: "Xcode", found: simctl ? "simctl available" : "no simctl", fix: "previews of iOS apps need Xcode and a booted simulator; web previews work without it" });
  const ffmpeg = ffmpegAvailable();
  checks.push({ ok: ffmpeg, optional: true, what: "ffmpeg", found: ffmpeg ? "found" : "not found", fix: "videos sent from the phone reach Claude as sheets of their frames with ffmpeg (brew install ffmpeg); without it they go by their path only" });
  return checks;
}

export function printChecks(checks: Check[]): boolean {
  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.optional ? "–" : "✗";
    console.log(`${mark} ${c.what.padEnd(14)} ${c.found}`);
    if (!c.ok && c.fix) console.log(`  ${c.optional ? "note" : "fix"}: ${c.fix}`);
    if (!c.ok && !c.optional) failed = true;
  }
  return !failed;
}

export interface SetupOptions {
  /** Print what would happen; change nothing. */
  dryRun: boolean;
  /** Front the daemon with Tailscale Serve when Tailscale is connected. */
  tailscale: boolean;
  /** Serve on the Wi-Fi: true, false, or undefined to decide (on when Tailscale isn't serving). */
  lan?: boolean;
}

/** Install the daemon on this Mac and print how to pair the phone. */
export async function setup(store: Store, opts: SetupOptions): Promise<void> {
  const say = (s: string) => console.log(s);
  // A clone keeps its .env beside package.json; an installed package keeps it in the data folder,
  // which `npm install -g` doesn't replace on an update.
  const envFile = configEnvFile;
  if (!fs.existsSync(envFile)) {
    say(`${opts.dryRun ? "would copy" : "copying"} .env.example → ${envFile}`);
    if (!opts.dryRun) {
      fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(daemonRoot, ".env.example"), envFile);
      fs.chmodSync(envFile, 0o600);
    }
  }
  const nodeOk = nodeCheck();
  if (!nodeOk.ok) throw new Error(`${nodeOk.found}: ${nodeOk.fix}`);

  // The Wi-Fi listener: asked for, or needed because Tailscale isn't there to carry the phone.
  const before = tailscale();
  const lan = opts.lan ?? (config.lan || !(before.installed && before.running && (before.serving || opts.tailscale)));
  if (lan !== config.lan) {
    say(`${opts.dryRun ? "would set" : "setting"} LAN=${lan ? 1 : 0} in .env (${lan ? "the phone reaches this Mac on the Wi-Fi" : "Wi-Fi listener off"})`);
    if (!opts.dryRun) fs.writeFileSync(envFile, setEnvLine(fs.readFileSync(envFile, "utf8"), "LAN", lan ? "1" : "0"));
  }
  if (lan && !opts.dryRun) ensureTls();

  const label = launchdLabel();
  const logDir = path.join(config.dataDir, "logs");
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const plist = renderPlist(label, daemonRoot, logDir, os.homedir());
  say(`${opts.dryRun ? "would write" : "writing"} ${plistPath} (label ${label}, through ${path.join(daemonRoot, "bin", "vibemachine")})`);
  if (opts.dryRun) say(plist);
  else {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, plist, { mode: 0o644 });
    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "ignore" });
    const uid = process.getuid?.() ?? 501;
    spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
    spawnSync("/bin/launchctl", ["enable", `gui/${uid}/${label}`], { stdio: "ignore" });
    const boot = spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
    if (boot.status !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.trim()}`);
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500));
      up = (await health()).ok;
    }
    say(up ? `daemon answering on ${config.host}:${config.port}` : `daemon not answering yet; see ${path.join(logDir, "daemon.err.log")}`);
  }

  const ts = tailscale();
  if (opts.tailscale && ts.installed && ts.running && !ts.serving) {
    say(`${opts.dryRun ? "would run" : "running"} tailscale serve --bg --https=${config.port} http://${config.host}:${config.port}`);
    if (!opts.dryRun) {
      const r = run("tailscale", ["serve", "--bg", `--https=${config.port}`, `http://${config.host}:${config.port}`], 30_000);
      if (!r.ok) say(`  tailscale serve failed: ${r.out.split("\n")[0]}\n  (HTTPS certificates must be enabled for your tailnet: https://tailscale.com/kb/1153/enabling-https)`);
    }
  }

  if (opts.dryRun) say(`\nwould print a pairing QR code for ${serverAddress(ts, lan)}`);
  else await printPairing(store, pairingTarget(lan, tailscale()));
  say("");
  printChecks(await doctor(store));
}

/** How this copy was installed: a git clone (updated by pulling) or a package (updated by npm). */
export function installKind(root = daemonRoot): "clone" | "package" {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true" ? "clone" : "package";
}

/** The LaunchAgent's plist, if `vibemachine setup` installed one. */
function installedPlist(): { label: string; plist: string } | null {
  const label = launchdLabel();
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  return fs.existsSync(plist) ? { label, plist } : null;
}

/** Restart the installed daemon so it runs the code now on disk. */
function restartDaemon(say: (s: string) => void): void {
  const agent = installedPlist();
  if (!agent) return say(`no LaunchAgent installed: run \`${cliName} setup\``);
  const uid = process.getuid?.() ?? 501;
  const r = spawnSync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${agent.label}`], { encoding: "utf8" });
  say(r.status === 0 ? `restarted ${agent.label}` : `couldn't restart ${agent.label}: ${(r.stderr ?? "").trim()}`);
}

/**
 * `vibemachine update`: the newest release, then a restart. A package updates itself through npm
 * (its .env and data live in the data folder, so nothing is lost); a clone pulls, installs and
 * builds. Sessions running on the phone are stopped by the restart and resume on their next prompt.
 */
export async function update(opts: { dryRun?: boolean } = {}): Promise<void> {
  const say = (s: string) => console.log(s);
  const kind = installKind();
  const step = (cmd: string, args: string[], cwd = daemonRoot): void => {
    say(`${opts.dryRun ? "would run" : "running"} ${cmd} ${args.join(" ")}${cwd !== daemonRoot ? ` in ${cwd}` : ""}`);
    if (opts.dryRun) return;
    const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, PATH: toolPath } });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
  };
  if (kind === "package") {
    const latest = run("npm", ["view", "vibemachine", "version"], 30_000);
    const newest = latest.ok ? latest.out.split("\n").pop()!.trim() : null;
    if (newest && newest === packageVersion) {
      say(`vibemachine ${packageVersion} is the newest`);
      return;
    }
    say(`vibemachine ${packageVersion}${newest ? ` → ${newest}` : ""}`);
    step("npm", ["install", "-g", "vibemachine@latest", "--no-fund", "--no-audit"], os.homedir());
  } else {
    step("git", ["pull", "--ff-only"]);
    step("npm", ["install", "--no-fund", "--no-audit"]);
    step("npm", ["run", "build", "--silent"]);
  }
  if (!opts.dryRun) restartDaemon(say);
}

/**
 * `vibemachine uninstall`: stop the daemon and remove what setup put outside the data folder (the
 * LaunchAgent and its Tailscale Serve rule); with `--purge`, the data folder too. Says what is left.
 */
export function uninstall(opts: { purge?: boolean; dryRun?: boolean } = {}): void {
  const say = (s: string) => console.log(s);
  const act = (what: string, fn: () => void) => {
    say(`${opts.dryRun ? "would " : ""}${what}`);
    if (!opts.dryRun) fn();
  };
  const agent = installedPlist();
  if (agent) {
    const uid = process.getuid?.() ?? 501;
    act(`stop and remove the LaunchAgent ${agent.label}`, () => {
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/${agent.label}`], { stdio: "ignore" });
      fs.rmSync(agent.plist, { force: true });
    });
  } else say("no LaunchAgent installed");
  const ts = tailscale();
  if (ts.installed && ts.serving) {
    act(`turn off tailscale serve on port ${config.port}`, () => {
      const r = run("tailscale", ["serve", `--https=${config.port}`, "off"], 30_000);
      if (!r.ok) say(`  tailscale serve off failed: ${r.out.split("\n")[0]}`);
    });
  }
  const dataDir = config.dataDir;
  if (opts.purge) {
    act(`delete ${dataDir} (sessions, captures, attachments, keys, logs)`, () => fs.rmSync(dataDir, { recursive: true, force: true }));
    if (configEnvFile !== path.join(defaultDataDir, ".env") && fs.existsSync(configEnvFile)) act(`delete ${configEnvFile}`, () => fs.rmSync(configEnvFile, { force: true }));
  } else if (fs.existsSync(dataDir)) {
    say(`\nkept ${dataDir}: the sessions and their streams, screenshots, attachments, this Mac's keys and the logs.`);
    say(`  \`${cliName} uninstall --purge\` deletes it too.`);
  }
  say(`\nThe phone's pairing ends with the daemon; in the app, Settings → Forget this Mac.`);
  if (installKind() === "package") say(`To remove the command itself: npm uninstall -g vibemachine`);
  say(`Claude Code and its own sessions (~/.claude) are untouched.`);
}
