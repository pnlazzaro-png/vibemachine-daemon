// Daemon configuration: `.env` beside package.json, then the environment.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const daemonRoot = path.resolve(here, "..");

/** The command people type: `vibemachine setup`, `vibemachine pair`. A clone also has `bin/vm`. */
export const cliName = "vibemachine";
/** This package's version, from package.json: what /health reports and `vibemachine update` compares. */
export const packageVersion: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(daemonRoot, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Where the daemon keeps its state unless DATA_DIR says otherwise. */
export const defaultDataDir = path.join(os.homedir(), "Library", "Application Support", "VibeMachine");
/** `.env`: in the data folder (survives an update of an installed package), else beside package.json (a clone). */
export const envFile = [path.join(defaultDataDir, ".env"), path.join(daemonRoot, ".env")].find((f) => fs.existsSync(f)) ?? path.join(defaultDataDir, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function str(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== undefined ? v : fallback;
}
export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Where the tools we run (claude, tailscale, git) tend to live, ahead of whatever PATH the daemon got (launchd's is short). */
export const toolDirs = [
  path.join(os.homedir(), ".local", "bin"), // Claude Code's native installer
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/Applications/Tailscale.app/Contents/MacOS",
];
export const toolPath = [...toolDirs, ...(process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":")].filter((d, i, all) => d && all.indexOf(d) === i).join(":");

/** The `claude` binary: CLAUDE_BIN, else the native install, Homebrew, a version manager's newest Node, else PATH. */
function findClaude(): string {
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) return expandHome(configured);
  const home = os.homedir();
  const candidates = [path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(home, ".volta", "bin", "claude")];
  // `npm install -g` under nvm or fnm lands in that Node's bin; take the newest version that has it.
  for (const versions of [path.join(home, ".nvm", "versions", "node"), path.join(home, ".fnm", "node-versions"), path.join(home, "Library", "Application Support", "fnm", "node-versions")]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(versions);
    } catch {
      continue;
    }
    names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of names) candidates.push(path.join(versions, v, "bin", "claude"), path.join(versions, v, "installation", "bin", "claude"));
  }
  for (const p of candidates) if (fs.existsSync(p)) return p;
  for (const dir of toolPath.split(":")) if (dir && fs.existsSync(path.join(dir, "claude"))) return path.join(dir, "claude");
  return "claude";
}

export const config = {
  /** Loopback only; Tailscale Serve puts it on the tailnet with TLS. */
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 3005),
  dataDir: expandHome(str("DATA_DIR", "~/Library/Application Support/VibeMachine")),
  claudeBin: findClaude(),
  /** Empty means Claude Code's own default. */
  defaultModel: str("DEFAULT_MODEL", ""),
  /** Permission mode handed to the child; the host still answers prompts. */
  defaultPermissionMode: str("PERMISSION_MODE", "default"),
  /** Stop an idle child after this long; the next prompt resumes it. 0 keeps it forever. */
  idleMinutes: num("IDLE_MINUTES", 30),
  /** How far a signed request's timestamp may be from now. */
  authSkewSeconds: num("AUTH_SKEW_SECONDS", 300),
  /** Pairing codes expire after this long. */
  pairingMinutes: num("PAIRING_MINUTES", 10),
  /** Where the repos a session can start in live. */
  projectsDir: expandHome(str("PROJECTS_DIR", "~/dev")),
  /** Also serve the routes over HTTPS on the Wi-Fi (lan.ts), for a phone without Tailscale. */
  lan: ["1", "true", "yes"].includes((process.env.LAN ?? "").trim().toLowerCase()),
  lanPort: num("LAN_PORT", 3006),
  /** Where pushes go without an APNs key of our own: a push relay (pushrelay.ts) that has one. Empty: none. */
  pushRelay: str("PUSH_RELAY", ""),
  /** APNs, token-based. Empty: no pushes, no Live Activity (unless PUSH_RELAY is set). */
  apns: {
    keyId: str("APNS_KEY_ID", ""),
    teamId: str("APNS_TEAM_ID", ""),
    keyPath: expandHome(str("APNS_KEY_PATH", "")),
    topic: str("APNS_TOPIC", "com.pnlazzaro.vibemachine"),
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
export const dbPath = path.join(config.dataDir, "vibemachine.sqlite");
