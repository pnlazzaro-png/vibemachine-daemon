// `vm export-demo`: one recorded session as the phone's demo. The session row
// and its lines in the wire format the phone already reads, with the
// streaming deltas and other chatter left out (a line per message is enough
// to replay), the captures the lines point at as the phone-sized JPEGs,
// the projects list and a month of the project's stats. The app bundles
// the folder and plays it back when nothing is paired (Core/Demo.swift).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "./db.js";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { localHostName } from "./lan.js";
import { trimForRelay } from "./trim.js";

const run = promisify(execFile);

/** A rewrite the recording goes through before it leaves the Mac. */
export interface ScrubRule {
  from: RegExp;
  to: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the recording must not carry off this Mac: whose it is and where it lives. The home
 * folder, the account name, the Mac's names, every tailnet host, the git author and every
 * email become a demo person's. The order matters: the home folder goes before the account
 * name it contains. Anything the session read out of the repo itself is not touched; record
 * the demo in a repo that can be shown.
 */
export function scrubRules(opts: { home?: string; user?: string; hosts?: string[]; names?: string[]; emails?: string[] } = {}): ScrubRule[] {
  const home = opts.home ?? os.homedir();
  const user = opts.user ?? os.userInfo().username;
  const hosts = opts.hosts ?? [os.hostname(), localHostName()].flatMap((h) => [h, h.replace(/\.local$/i, "")]);
  const names = opts.names ?? [gitConfig("user.name")].filter((n): n is string => !!n);
  const emails = opts.emails ?? [gitConfig("user.email")].filter((n): n is string => !!n);
  const rules: ScrubRule[] = [{ from: new RegExp(escapeRe(home), "g"), to: "/Users/demo" }];
  for (const email of emails) rules.push({ from: new RegExp(escapeRe(email), "gi"), to: "demo@example.com" });
  // Any other address too: a co-author, a reply-to in a log.
  rules.push({ from: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "demo@example.com" });
  for (const name of names) if (name.trim()) rules.push({ from: new RegExp(escapeRe(name.trim()), "g"), to: "Demo User" });
  // Tailscale names anyone's Mac after its tailnet; the shape is the same for all of them.
  rules.push({ from: /\b[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net\b/g, to: "demo-mac.tailnet.ts.net" });
  for (const host of new Set(hosts.filter((h) => h.length > 3))) rules.push({ from: new RegExp(escapeRe(host), "gi"), to: "demo-mac" });
  if (user.length > 2) rules.push({ from: new RegExp(`\\b${escapeRe(user)}\\b`, "g"), to: "demo" });
  return rules;
}

function gitConfig(key: string): string | null {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** The same value with every string put through the rules. */
export function scrub<T>(value: T, rules: ScrubRule[]): T {
  if (typeof value === "string") return rules.reduce<string>((s, r) => s.replace(r.from, r.to), value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, rules)) as unknown as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [scrub(k, rules), scrub(v, rules)])) as T;
  return value;
}

/** Lines the replay doesn't need: the deltas (the full message follows each), the CLI's own bookkeeping. */
const DROPPED_TYPES = new Set(["stream_event", "tool_progress", "control_response", "control_cancel_request"]);
const DROPPED_SYSTEM = new Set(["commands_changed"]);
/** A tool result or a log longer than this is cut; the stream shows them folded anyway. */
const MAX_STRING = 6000;
/** The demo's pictures: a little smaller than the daemon serves, since eighty of them ride in the app. */
const DEMO_MAX_PX = 1000;
const DEMO_JPEG_QUALITY = 70;

/** The same value with every long string cut short. */
export function cut(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "\n… (cut for the demo)" : value;
  if (Array.isArray(value)) return value.map(cut);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cut(v)]));
  return value;
}

interface CaptureRef {
  id: string;
  width: number;
  height: number;
}

/** Every {id, width, height} a line points at under before / after / capture. */
export function captureRefs(event: unknown, out: Map<string, CaptureRef> = new Map()): Map<string, CaptureRef> {
  if (!event || typeof event !== "object") return out;
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if ((key === "before" || key === "after" || key === "capture") && value && typeof value === "object") {
      const ref = value as Partial<CaptureRef>;
      if (typeof ref.id === "string" && typeof ref.width === "number" && typeof ref.height === "number") out.set(ref.id, { id: ref.id, width: ref.width, height: ref.height });
    } else if (value && typeof value === "object") captureRefs(value, out);
  }
  return out;
}

/** The lines worth replaying, in the phone's envelope shape, the newest rate-limit line kept for the gauge. */
export function demoEvents(rows: { session_id: string; seq: number; ts: string; type: string; subtype: string | null; json: string }[]): { session_id: string; seq: number; ts: string; event: unknown }[] {
  const lastRateLimit = rows.filter((r) => r.type === "rate_limit_event").at(-1)?.seq;
  return rows
    .filter((r) => !DROPPED_TYPES.has(r.type) && !(r.type === "system" && DROPPED_SYSTEM.has(r.subtype ?? "")) && (r.type !== "rate_limit_event" || r.seq === lastRateLimit))
    .map((r) => ({ session_id: r.session_id, seq: r.seq, ts: r.ts, event: cut(trimForRelay(JSON.parse(r.json))) }));
}

export async function exportDemo(store: Store, sessionId: string, outDir: string, fetchJson: (path: string) => Promise<unknown>, rules: ScrubRule[] = scrubRules()): Promise<{ events: number; captures: number; bytes: number }> {
  const row = store.getSession(sessionId);
  if (!row) throw new Error(`no session ${sessionId}`);
  const detail = (await fetchJson(`/sessions/${sessionId}`)) as { session: Record<string, unknown> };
  const session = { ...detail.session, status: "idle" };
  const rows = store.eventsSince(sessionId, 0, 1_000_000);
  const events = demoEvents(rows);
  const refs = new Map<string, CaptureRef>();
  for (const e of events) captureRefs(e.event, refs);

  fs.mkdirSync(path.join(outDir, "captures"), { recursive: true });
  const captures: Record<string, { width: number; height: number }> = {};
  for (const ref of refs.values()) {
    const c = store.getCapture(ref.id);
    if (!c || !fs.existsSync(c.path)) continue;
    const out = path.join(outDir, "captures", `${ref.id}.jpg`);
    await run("sips", ["--resampleHeightWidthMax", String(DEMO_MAX_PX), "-s", "format", "jpeg", "-s", "formatOptions", String(DEMO_JPEG_QUALITY), c.path, "--out", out], { timeout: 60_000 });
    captures[ref.id] = { width: ref.width, height: ref.height };
  }
  // Only the demo's own project is listed: the others are whatever else lives on this Mac.
  const projects = (await fetchJson("/projects")) as { projects: { cwd?: string }[] };
  const own = projects.projects.filter((p) => typeof p.cwd === "string" && path.resolve(p.cwd) === path.resolve(row.cwd));
  const since = new Date();
  since.setMonth(since.getMonth() - 1);
  const stats = await fetchJson(`/stats?bucket=day&since=${encodeURIComponent(since.toISOString())}&project=${encodeURIComponent(row.cwd)}`);
  const fixture = scrub({ recorded_at: new Date().toISOString(), session, events, captures, projects: own, stats }, rules);
  const file = path.join(outDir, "demo.json");
  fs.writeFileSync(file, JSON.stringify(fixture));
  let bytes = fs.statSync(file).size;
  for (const f of fs.readdirSync(path.join(outDir, "captures"))) bytes += fs.statSync(path.join(outDir, "captures", f)).size;
  return { events: events.length, captures: Object.keys(captures).length, bytes };
}
