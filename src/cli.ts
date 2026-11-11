// `vm`: drive the daemon from the Mac. It is an enrolled device like the
// phone, with its own P-256 key in the data directory, so every call takes
// the same signed path the app does.
//
//   vm setup [--dry-run] [--no-tailscale] [--lan|--no-lan] [--wifi] [--projects <folder>]
//                                 install and start the daemon, print a pairing QR code; --projects
//                                 says where your repos live (asked, if ~/dev has none); --wifi when
//                                 the Mac has Tailscale and the phone doesn't
//   vm restart [--when-idle]      restart the daemon, after a change to its .env; --when-idle waits
//                                 until no turn is running
//   vm doctor                     check Node, Claude Code's sign-in, the daemon, Tailscale, projects, pushes
//   vm update [--dry-run] [--now] the newest release (npm, or a pull in a clone), then a restart once
//                                 no turn is running (--now: at once, stopping them)
//   vm uninstall [--purge] [--dry-run]   remove the LaunchAgent and its Tailscale rule; --purge the data too
//   vibemachine daemon                     run the daemon in the foreground (what the LaunchAgent runs; bin/vibemachine)
//
// Installed from npm the command is `vibemachine`; a clone also has `bin/vm`.
//   vm pair [--wifi]              print a pairing code and QR code for the phone (--wifi: for the Wi-Fi,
//                                 when Tailscale also serves the daemon)
//   vm devices                    list enrolled devices
//   vm forget <device-id>
//   vm sessions
//   vm projects                   repos a session can start in
//   vm new <cwd> [-f file]… <prompt…>   start a session (-f attaches a file, as the phone does)
//   vm say <id> [-f file]… <prompt…>    another turn (resumes if the child is gone)
//   vm set <id> model=<m> effort=<e>    change the model or effort (an empty value resets)
//   vm pending <id>               list permission prompts waiting on you
//   vm allow <id> <request-id>    answer a permission prompt
//   vm deny <id> <request-id> [why]
//   vm interrupt <id>
//   vm archive <id>               out of the phone's list (unarchive <id> puts it back; so does a prompt)
//   vm preview <id>               screenshot the project's app in the simulator now
//   vm tail <id> [since]          follow the stream (summarised)
//   vm stats [today|week|month|year|all] [project]   the usage ledger: every session on this Mac
//                                 (with no daemon running it reads Claude Code's transcripts itself)
//   vm export-demo <id> <dir>     one session, its captures, projects and stats as the app's bundled demo
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { signingString } from "./auth.js";
import { cliName, config } from "./config.js";
import { Store } from "./db.js";
import { exportDemo } from "./demo.js";
import { doctor, pairingTarget, printChecks, printPairing, restartDaemon, restartWhenIdle, setup, uninstall, update } from "./setup.js";
import { statsReport, type StatsQuery } from "./stats.js";
import { UsageLedger } from "./usage.js";

const base = `http://${config.host}:${config.port}`;
const keyFile = path.join(config.dataDir, "cli-device.json");

interface CliKey {
  device_id: string;
  private_pem: string;
  public_x963: string;
}

function loadOrCreateKey(): CliKey {
  if (fs.existsSync(keyFile)) return JSON.parse(fs.readFileSync(keyFile, "utf8")) as CliKey;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x963 = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64");
  const key: CliKey = { device_id: `cli-${randomUUID()}`, private_pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), public_x963: x963 };
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 2), { mode: 0o600 });
  return key;
}

function ensureEnrolled(store: Store, key: CliKey): void {
  if (!store.getDevice(key.device_id)) store.insertDevice({ id: key.device_id, name: `vm on ${os.hostname()}`, public_key: key.public_x963 });
  // Sanity: the stored key must round-trip.
  createPublicKey(createPrivateKey(key.private_pem));
}

function headersFor(key: CliKey, method: string, pathWithQuery: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = sign("sha256", Buffer.from(signingString(method, pathWithQuery, timestamp, bodyHash)), { key: createPrivateKey(key.private_pem), dsaEncoding: "ieee-p1363" });
  return { "x-vm-device": key.device_id, "x-vm-timestamp": timestamp, "x-vm-signature": sig.toString("base64") };
}

async function call(key: CliKey, method: string, pathWithQuery: string, body?: unknown): Promise<unknown> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const res = await fetch(base + pathWithQuery, {
    method,
    headers: { ...headersFor(key, method, pathWithQuery, text), ...(text ? { "content-type": "application/json" } : {}) },
    ...(text ? { body: text } : {}),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

function summarise(ev: Record<string, unknown>): string | null {
  const type = ev.type;
  if (type === "stream_event") {
    const event = ev.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string } } | undefined;
    if (event?.delta?.type === "text_delta") return event.delta.text ?? "";
    return null;
  }
  if (type === "user") {
    const msg = ev.message as { content?: unknown } | undefined;
    if (typeof msg?.content === "string") return `\n> ${msg.content}\n`;
    const blocks = Array.isArray(msg?.content) ? (msg.content as { type: string; content?: unknown; is_error?: boolean }[]) : [];
    return blocks
      .filter((b) => b.type === "tool_result")
      .map((b) => `\n  ⎿ ${b.is_error ? "error: " : ""}${typeof b.content === "string" ? b.content.split("\n")[0]?.slice(0, 120) : "(result)"}`)
      .join("");
  }
  if (type === "assistant") {
    const msg = ev.message as { content?: { type: string; name?: string; input?: unknown }[] } | undefined;
    return (msg?.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => `\n● ${b.name}(${JSON.stringify(b.input).slice(0, 100)})`)
      .join("");
  }
  if (type === "control_request") {
    const r = ev.request as { tool_name?: string; description?: string } | undefined;
    return `\n? permission ${r?.tool_name ?? ""} ${r?.description ?? ""}  [request_id ${String(ev.request_id)}]`;
  }
  if (type === "pipeline") return `\n■ ${String(ev.stage)} ${String(ev.status)}: ${String(ev.title)}`;
  if (type === "preview") {
    const after = ev.after as { id?: string } | null;
    return `\n◫ preview ${String(ev.screen)} ${String(ev.status)}${after?.id ? ` /captures/${after.id}` : ""}${ev.caption ? ` — ${String(ev.caption)}` : ""}${ev.error ? ` (${String(ev.error)})` : ""}`;
  }
  if (type === "look") return `\n◫ look ${String(ev.name)} /captures/${String((ev.capture as { id?: string } | undefined)?.id ?? "")}`;
  if (type === "result") return `\n— ${String(ev.subtype)} ${String(ev.num_turns)} steps $${Number(ev.total_cost_usd ?? 0).toFixed(3)}\n`;
  if (type === "system" && ev.subtype === "task_summary" && ev.detail) return `\n  … ${String(ev.detail)}`;
  if (type === "system" && ev.subtype === "post_turn_summary") return `\n  = ${String(ev.status_category)}: ${String(ev.status_detail)}`;
  if (type === "host") return `\n  host: ${String(ev.subtype)}`;
  return null;
}

/** What `stats` prints of a report (stats.ts writes the same names). */
interface PrintableStats {
  totals: { cost_usd: number; tokens: number; cache_read: number; prompts: number; sessions: number; tools: number; unpriced: number };
  previous: { cost_usd: number } | null;
  series: { bucket: string; cost_usd: number; prompts: number }[];
  models: { model: string; cost_usd: number; requests: number }[];
  projects: { name: string; cost_usd: number; prompts: number; commits: number; builds: number; builds_failed: number }[];
  repos?: { name: string; commits: number; claude: number }[];
  sources: { source: string; cost_usd: number; sessions: number }[];
  scores: { label: string; value: string; detail: string }[];
}

/** `stats [today|week|month|year|all] [project]` as the range's name and the ledger's query. */
function statsQuery(args: string[], now = new Date()): { range: string; q: StatsQuery } {
  const [range = "today", project] = args;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else if (range === "month") start.setDate(1);
  else if (range === "year") start.setMonth(0, 1);
  return { range, q: { since: range === "all" ? null : start.toISOString(), until: null, bucket: range === "year" || range === "all" ? "month" : "day", cwd: project ? path.resolve(project) : null } };
}

function printStats(range: string, r: PrintableStats): void {
  const t = r.totals;
  const cache = t.tokens > 0 ? Math.round((t.cache_read / t.tokens) * 100) : 0;
  console.log(`${range}: $${t.cost_usd.toFixed(2)}${r.previous ? ` (before: $${r.previous.cost_usd.toFixed(2)})` : ""}  ${(t.tokens / 1e6).toFixed(1)}M tokens, ${cache}% from cache  ${t.prompts} prompts, ${t.tools} tool calls, ${t.sessions} sessions${t.unpriced ? `  (${t.unpriced} calls on models without a price)` : ""}`);
  for (const m of r.models) console.log(`  ${m.model.padEnd(24)} $${m.cost_usd.toFixed(2).padStart(8)}  ${m.requests} calls`);
  console.log("projects:");
  for (const p of r.projects) console.log(`  ${p.name.padEnd(24)} $${p.cost_usd.toFixed(2).padStart(8)}  ${p.prompts} prompts, ${p.commits} commits, ${p.builds} builds${p.builds_failed ? ` (${p.builds_failed} failed)` : ""}`);
  if (r.repos?.length) {
    console.log("commits, all time:");
    for (const p of r.repos) console.log(`  ${p.name.padEnd(24)} ${String(p.commits).padStart(6)}  (${p.claude} with Claude)`);
  }
  console.log("sources: " + r.sources.map((s) => `${s.source} $${s.cost_usd.toFixed(2)} (${s.sessions})`).join(", "));
  for (const s of r.scores) console.log(`  ${s.label.padEnd(24)} ${s.value.padEnd(12)} ${s.detail}`);
  const active = r.series.filter((b) => b.cost_usd > 0 || b.prompts > 0);
  if (active.length > 1) for (const b of active) console.log(`  ${b.bucket}  $${b.cost_usd.toFixed(2).padStart(8)}  ${b.prompts} prompts`);
}

/** Whether a daemon is answering on this Mac (its health check takes no signature). */
async function daemonAnswers(): Promise<boolean> {
  try {
    return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/**
 * `stats` with no daemon running: read Claude Code's transcripts into a ledger held in memory and
 * print the same report. Nothing is set up or enrolled and nothing is kept, so it works straight
 * from `npx vibemachine-daemon stats week` on a Mac that has never seen Vibe Machine.
 */
async function statsWithoutDaemon(args: string[]): Promise<void> {
  const { range, q } = statsQuery(args);
  const memory = new Store(":memory:");
  try {
    const ledger = new UsageLedger(memory);
    if (!fs.existsSync(ledger.root)) {
      console.log(`No Claude Code transcripts on this Mac yet (${ledger.root}). Run claude once and come back.`);
      return;
    }
    await ledger.scan();
    printStats(range, statsReport(memory, q) as unknown as PrintableStats);
    console.log(`\nRead from Claude Code's transcripts on this Mac (${ledger.root}); costs are at API list prices. Nothing was sent anywhere.`);
    console.log("The same on your iPhone, with every turn as it happens: https://getvibemachine.com");
  } finally {
    memory.close();
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "stats" && !(await daemonAnswers())) return statsWithoutDaemon(rest);
  const store = new Store();
  try {
    if (cmd === "setup") {
      const at = rest.indexOf("--projects");
      const projects = at >= 0 ? rest[at + 1] : undefined;
      if (at >= 0 && (!projects || projects.startsWith("--"))) throw new Error(`usage: ${cliName} setup --projects <folder>`);
      await setup(store, { dryRun: rest.includes("--dry-run"), tailscale: !rest.includes("--no-tailscale"), ...(rest.includes("--lan") ? { lan: true } : rest.includes("--no-lan") ? { lan: false } : {}), ...(rest.includes("--wifi") ? { wifi: true } : {}), ...(projects ? { projects } : {}) });
      return;
    }
    if (cmd === "restart") {
      if (rest.includes("--when-idle")) await restartWhenIdle(() => store.liveSessions());
      else restartDaemon();
      return;
    }
    if (cmd === "update") {
      await update({ dryRun: rest.includes("--dry-run"), now: rest.includes("--now"), live: () => store.liveSessions() });
      return;
    }
    if (cmd === "uninstall") {
      uninstall({ purge: rest.includes("--purge"), dryRun: rest.includes("--dry-run") });
      return;
    }
    if (cmd === "doctor") {
      if (!printChecks(await doctor(store))) process.exitCode = 1;
      return;
    }
    if (cmd === "pair") {
      await printPairing(store, pairingTarget(undefined, undefined, rest.includes("--wifi") ? true : undefined));
      return;
    }
    if (cmd === "devices") {
      for (const d of store.listDevices()) console.log(`${d.id}\t${d.name}\tlast seen ${d.last_seen ?? "never"}`);
      return;
    }
    if (cmd === "forget") {
      console.log(store.removeDevice(rest[0] ?? "") ? "forgotten" : "no such device");
      return;
    }
    const key = loadOrCreateKey();
    ensureEnrolled(store, key);
    store.close();

    if (cmd === "sessions") {
      const { sessions } = (await call(key, "GET", "/sessions")) as { sessions: { id: string; status: string; title: string; cwd: string; cost_usd: number; updated_at: string; archived_at: string | null }[] };
      for (const s of sessions) console.log(`${s.id}  ${s.status.padEnd(8)} $${s.cost_usd.toFixed(2)}  ${s.title}  (${s.cwd})${s.archived_at ? "  [archived]" : ""}`);
      return;
    }
    if (cmd === "projects") {
      const { projects } = (await call(key, "GET", "/projects")) as { projects: { name: string; cwd: string; branch: string | null; last_commit: string | null; preview: boolean }[] };
      for (const p of projects) console.log(`${p.name.padEnd(16)} ${(p.branch ?? "-").padEnd(10)} ${p.last_commit?.slice(0, 10) ?? "-"}  ${p.preview ? "preview" : ""}  ${p.cwd}`);
      return;
    }
    if (cmd === "new") {
      const [cwd, ...args] = rest;
      const { files, words } = splitFiles(args);
      const { session } = (await call(key, "POST", "/sessions", { cwd: path.resolve(cwd ?? "."), prompt: words.join(" "), attachments: files.map(attachmentFrom) })) as { session: { id: string } };
      console.log(session.id);
      return;
    }
    if (cmd === "say") {
      const [id, ...args] = rest;
      const { files, words } = splitFiles(args);
      await call(key, "POST", `/sessions/${id}/prompt`, { prompt: words.join(" "), attachments: files.map(attachmentFrom) });
      return;
    }
    if (cmd === "set") {
      const [id, ...pairs] = rest;
      const body: Record<string, string | null> = {};
      for (const pair of pairs) {
        const eq = pair.indexOf("=");
        if (eq < 0) throw new Error(`expected key=value, got ${pair}`);
        body[pair.slice(0, eq)] = pair.slice(eq + 1) || null;
      }
      const { session } = (await call(key, "POST", `/sessions/${id}/settings`, body)) as { session: { model: string | null; effort: string | null } };
      console.log(`model ${session.model ?? "(default)"}  effort ${session.effort ?? "(default)"}`);
      return;
    }
    if (cmd === "pending") {
      const { session, pending } = (await call(key, "GET", `/sessions/${rest[0]}`)) as { session: { status: string }; pending: { request_id: string; tool_name: string; description?: string }[] };
      console.log(`[${session.status}]`);
      for (const p of pending) console.log(`${p.request_id}\t${p.tool_name}\t${p.description ?? ""}`);
      return;
    }
    if (cmd === "allow" || cmd === "deny") {
      const [id, requestId, ...why] = rest;
      await call(key, "POST", `/sessions/${id}/permission`, { request_id: requestId, behavior: cmd, ...(why.length ? { message: why.join(" ") } : {}) });
      return;
    }
    if (cmd === "interrupt") {
      await call(key, "POST", `/sessions/${rest[0]}/interrupt`);
      return;
    }
    if (cmd === "archive" || cmd === "unarchive") {
      await call(key, "POST", `/sessions/${rest[0]}/archive`, { archived: cmd === "archive" });
      return;
    }
    if (cmd === "preview") {
      await call(key, "POST", `/sessions/${rest[0]}/preview`);
      console.log(`capturing; follow with ${cliName} tail`);
      return;
    }
    if (cmd === "stats") {
      const { range, q } = statsQuery(rest);
      const query = new URLSearchParams({ bucket: q.bucket });
      if (q.since) query.set("since", q.since);
      if (q.cwd) query.set("project", q.cwd);
      printStats(range, (await call(key, "GET", `/stats?${query}`)) as PrintableStats);
      return;
    }
    if (cmd === "export-demo") {
      const [id, dir] = rest;
      if (!id || !dir) throw new Error(`usage: ${cliName} export-demo <session-id> <dir>`);
      const full = (await call(key, "GET", "/sessions")) as { sessions: { id: string }[] };
      const match = full.sessions.find((s) => s.id === id || s.id.startsWith(id));
      if (!match) throw new Error(`no session ${id}`);
      const store2 = new Store();
      const r = await exportDemo(store2, match.id, path.resolve(dir), (p) => call(key, "GET", p));
      store2.close();
      console.log(`${r.events} lines, ${r.captures} captures, ${(r.bytes / 1e6).toFixed(1)} MB → ${path.resolve(dir)}`);
      return;
    }
    if (cmd === "tail") {
      const [id, since = "0"] = rest;
      const ws = new WebSocket(`ws://${config.host}:${config.port}/ws`, { headers: headersFor(key, "GET", "/ws", "") });
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", session_id: id, since: Number(since) })));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { type: string; event?: Record<string, unknown>; session?: { status: string } };
        if (msg.type === "event" && msg.event) {
          const s = summarise(msg.event);
          if (s) process.stdout.write(s);
        } else if (msg.type === "session" && msg.session) process.stdout.write(`\n[${msg.session.status}]`);
      });
      ws.on("close", () => process.exit(0));
      ws.on("error", (e) => {
        console.error(e.message);
        process.exit(1);
      });
      return;
    }
    const usage = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//   vm ") || l.startsWith(`//   ${cliName} `));
    console.log(usage.map((l) => l.replace(/^\/\/   (vm )?/, (_m, vm: string | undefined) => (vm ? `${cliName} ` : ""))).join("\n"));
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
}

/** `-f path` options out of a prompt's words. */
function splitFiles(args: string[]): { files: string[]; words: string[] } {
  const files: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-f" && args[i + 1] !== undefined) files.push(args[++i]!);
    else words.push(args[i]!);
  }
  return { files, words };
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv",
  ".swift": "text/x-swift", ".ts": "text/typescript", ".log": "text/plain",
  ".mov": "video/quicktime", ".mp4": "video/mp4", ".m4v": "video/x-m4v",
};

function attachmentFrom(file: string): { name: string; media_type: string; data: string } {
  const data = fs.readFileSync(file);
  return { name: path.basename(file), media_type: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", data: data.toString("base64") };
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
