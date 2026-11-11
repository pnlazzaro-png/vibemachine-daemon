// The preview: after each build in a turn, screenshots of the app in the
// simulator, one per configured screen, before and after. A build is seen
// two ways: an `xcodebuild` the model ran (its Bash result says BUILD
// SUCCEEDED or FAILED, and becomes a `build` pipeline line with the log),
// and, whatever ran it, the app bundle's executable getting a newer mtime.
// A turn's "before" is each screen's newest capture in the project (the last
// build's "after", whichever session took it), so nothing is shot when a
// prompt arrives; only a screen that has never been captured is shot at the
// turn's start, while Claude is still reading the prompt.
// Captures are stored under DATA_DIR/captures and served by id; the stream
// gets one `preview` line per screen, re-sent when its state changes
// (capturing → done/failed, then again with the caption at turn end).
// Images Claude reads with its Read tool (its own screenshots, mostly) are
// kept the same way and sent as `look` lines: what Claude is looking at.
// Only the screens of the display the simulator is really showing are shot
// (a screen may say "inner" or "cover"); nothing is faked, and a folded
// simulator says so on its lines. When Claude opens the app itself during a
// turn, the screen it opened is shot too at the turn's end, as "Working on".
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { finishClip } from "./clips.js";
import { config } from "./config.js";
import type { CaptureRow, Store } from "./db.js";
import type { PipelineLine } from "./pipeline.js";
import { forgetDetected, projectConfig, type PreviewConfig, type Screen } from "./project.js";
import * as sim from "./simulator.js";
import * as lease from "./simlease.js";
import * as fold from "./fold.js";

const run = promisify(execFile);

export interface CaptureRef {
  id: string;
  width: number;
  height: number;
}

export interface PreviewLine {
  type: "preview";
  /** Stable per turn and screen, so the phone replaces the line as it progresses. */
  id: string;
  turn: number;
  screen: string;
  status: "capturing" | "done" | "failed";
  before: CaptureRef | null;
  after: CaptureRef | null;
  caption: string | null;
  error?: string;
  /** Why the picture isn't the one wanted: the simulator is folded, say. */
  note?: string;
  /** Where the screen changed from its before, in fractions of the picture, biggest first. */
  changes?: sim.ChangeBox[];
  ts: string;
  [k: string]: unknown;
}

/** The screen Claude opened itself, shot at the turn's end. */
export const WORKING_ON = "Working on";

/** A screen's args without the ones every screen carries, for telling two screens apart. */
function screenKey(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-noPushPrompt") { i++; continue; }
    out.push(args[i]!);
  }
  return out.join(" ");
}

/**
 * The launch arguments of the last time a shell command opened this app in the
 * simulator (`xcrun simctl launch … <device> <bundle id> args…`), or null. Arguments
 * built from shell variables can't be known here, so such a launch is skipped.
 */
export function launchedArgs(command: string, bundleId: string): string[] | null {
  const escaped = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`simctl\\s+launch\\b[^\\n;|&]*?\\s${escaped}(?=\\s|$)([^\\n;|&>]*)`, "g");
  let found: string[] | null = null;
  for (const m of command.matchAll(re)) {
    const tokens = (m[1] ?? "").trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^(['"])(.*)\1$/, "$2"));
    if (tokens.some((t) => /[$`]/.test(t) || /^\d*>/.test(t))) continue;
    found = tokens;
  }
  return found;
}

/** The screens to shoot on the display that is lit: those meant for it, or with no display of their own. */
export function screensFor(screens: Screen[], kind: "inner" | "cover"): Screen[] {
  return screens.filter((screen) => !screen.display || screen.display === kind);
}

/** What to say on a folded simulator's lines when the project wants the inner screen. */
export function foldedNote(screens: Screen[], kind: "inner" | "cover"): string | undefined {
  return kind === "cover" && screens.some((screen) => screen.display === "inner")
    ? "The simulator is folded, so this is the cover screen. Unfold it in Device Hub for the inner screen."
    : undefined;
}

export const capturesDir = path.join(config.dataDir, "captures");
/** Captures are shrunk so their longer side is this many pixels: the PNG kept on the Mac. */
export const CAPTURE_MAX_PX = 1600;
/** What the phone is sent: a JPEG this many pixels on its longer side, at this quality, about a
 *  quarter of the PNG's bytes, so the pane's pictures arrive quickly over Tailscale. */
export const SERVED_MAX_PX = 1200;
export const SERVED_JPEG_QUALITY = 75;
/** Full-resolution originals were once kept beside captures for the inspector; none are made now,
 *  and any left over go after this long. */
export const ORIGINAL_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

/** Where a capture's full-resolution original lived, beside the shrunk copy. */
export function originalPath(file: string): string {
  return file.replace(/\.png$/, "-full.png");
}

/** Where a capture's clip lives, beside the PNG: the app arriving and moving, kept when the screen changed and the app moves (clips.ts). */
export function clipPath(file: string): string {
  return file.replace(/\.png$/, ".mp4");
}

/** Where the phone's JPEG of a capture lives, beside the PNG. */
export function servedPath(file: string): string {
  return file.replace(/\.png$/, ".jpg");
}

/** The phone's JPEG of a capture, made now if it isn't on file (captures shot before it existed). */
export async function servedCopy(file: string): Promise<string> {
  const out = servedPath(file);
  if (!fs.existsSync(out)) {
    await run("sips", ["--resampleHeightWidthMax", String(SERVED_MAX_PX), "-s", "format", "jpeg", "-s", "formatOptions", String(SERVED_JPEG_QUALITY), file, "--out", out], { timeout: 60_000 });
  }
  return out;
}

/** Shrinks a new capture in place, if it is larger than `CAPTURE_MAX_PX`, and makes the phone's JPEG. */
async function shrinkForPhone(file: string): Promise<void> {
  const size = sim.pngSize(file);
  if (Math.max(size.width, size.height) > CAPTURE_MAX_PX) await sim.shrinkPng(file, CAPTURE_MAX_PX);
  await servedCopy(file);
}

/** How long builds must stay quiet before a mid-turn round, and how long after Claude's own simctl call the simulator stays Claude's. */
const MIDTURN_QUIET_MS = 20_000;
const SIM_IN_USE_MS = 30_000;
/** Clips being made phone-sized, one at a time, apart from the rounds. */
let clipQueue: Promise<void> = Promise.resolve();

/** The longest a round waits for the simulator to come free before going ahead anyway. */
const SIM_WAIT_MAX_MS = 10 * 60_000;

/**
 * Tool calls in any session running simctl or devicectl, and when the last one ended. There is one
 * simulator: a round folds it and relaunches the app, which would land in the middle of a session's
 * own screenshots (and theirs in ours), so every round waits for it to come free.
 */
const simInUse = { tools: new Set<string>(), ended: 0 };

function simBusy(now = Date.now()): boolean {
  return simInUse.tools.size > 0 || now - simInUse.ended < SIM_IN_USE_MS;
}

async function untilSimFree(): Promise<void> {
  const deadline = Date.now() + SIM_WAIT_MAX_MS;
  while (simBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5000));
}

/** The least wait after launching into a half-open view before the shot. */
const HALF_OPEN_SETTLE_MS = 7000;

/** How long a capture (the pane's copy) is kept: a week of turns to look back over. */
export const CAPTURE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deletes captures older than `CAPTURE_KEEP_MS`, files and rows, except what is kept for good:
 * each project's newest shot of each screen (the next turn's "before"), and everything each
 * session's last turn with pictures shows (its before and after shots, which may be older
 * captures, and the images Claude looked at), so a session reopened months later still has its
 * last round. Returns how many went. An older turn's pictures are then gone from the phone too;
 * what was built and committed stays in the stream.
 */
export function pruneCaptures(store: Store, now: number = Date.now()): number {
  const cutoff = new Date(now - CAPTURE_KEEP_MS).toISOString();
  const kept = keptForGood(store);
  const old = (store.db.prepare(`SELECT id, path FROM captures WHERE created_at < ?`).all(cutoff) as { id: string; path: string }[]).filter(
    (row) => !kept.has(row.id),
  );
  const remove = store.db.prepare(`DELETE FROM captures WHERE id = ?`);
  for (const row of old) {
    fs.rmSync(row.path, { force: true });
    fs.rmSync(servedPath(row.path), { force: true });
    fs.rmSync(originalPath(row.path), { force: true });
    fs.rmSync(clipPath(row.path), { force: true });
    remove.run(row.id);
  }
  return old.length;
}

/** The captures `pruneCaptures` never deletes, by id. */
function keptForGood(store: Store): Set<string> {
  const kept = new Set<string>();
  // Each project's newest shot of each screen.
  for (const row of store.db
    .prepare(
      `SELECT id FROM (
         SELECT c.id, ROW_NUMBER() OVER (PARTITION BY s.cwd, c.screen ORDER BY c.created_at DESC) AS rn
         FROM captures c JOIN sessions s ON s.id = c.session_id
         WHERE c.kind != 'look'
       ) WHERE rn = 1`,
    )
    .all() as { id: string }[]) kept.add(row.id);
  // Each session's last turn with pictures: what its preview lines point at, and what it captured.
  const lastTurns = store.db
    .prepare(`SELECT session_id, max(turn) AS turn FROM captures GROUP BY session_id`)
    .all() as { session_id: string; turn: number }[];
  const linesOf = store.db.prepare(
    `SELECT json_extract(json, '$.before.id') AS before, json_extract(json, '$.after.id') AS after
     FROM events WHERE session_id = ? AND type = 'preview' AND json_extract(json, '$.turn') = ?`,
  );
  const capturedIn = store.db.prepare(`SELECT id FROM captures WHERE session_id = ? AND turn = ?`);
  for (const { session_id, turn } of lastTurns) {
    for (const line of linesOf.all(session_id, turn) as { before: string | null; after: string | null }[]) {
      if (line.before) kept.add(line.before);
      if (line.after) kept.add(line.after);
    }
    for (const row of capturedIn.all(session_id, turn) as { id: string }[]) kept.add(row.id);
  }
  return kept;
}

/** Deletes leftover originals older than `ORIGINAL_KEEP_MS` (the shrunk copies stay); returns how many went. */
export function pruneOriginals(dir: string = capturesDir, now: number = Date.now()): number {
  let removed = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const session of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const folder = path.join(dir, session.name);
    for (const name of fs.readdirSync(folder)) {
      if (!name.endsWith("-full.png")) continue;
      const file = path.join(folder, name);
      if (now - fs.statSync(file).mtimeMs > ORIGINAL_KEEP_MS) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    }
  }
  return removed;
}

/** An image Claude read during a turn, copied as it was when Claude saw it. */
export interface LookLine {
  type: "look";
  id: string;
  turn: number;
  /** The file's name, e.g. "after-cockpit.png". */
  name: string;
  capture: CaptureRef;
  ts: string;
  [k: string]: unknown;
}

type Emit = (line: PipelineLine | PreviewLine | LookLine) => void;

/** Files the Read tool hands Claude as images. */
export function isImagePath(file: string | undefined): file is string {
  return typeof file === "string" && /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i.test(file);
}

/**
 * Whether an xcodebuild wrote the app the preview shoots: its -derivedDataPath holds the app (a
 * build somewhere else, a scratch copy or a test run of its own, changed nothing to shoot). With
 * no -derivedDataPath it builds into Xcode's own folder, so only the app's timestamp can tell.
 */
export function buildsPreviewApp(command: string | undefined, cwd: string, app: string): boolean {
  const m = /-derivedDataPath\s+("[^"]+"|'[^']+'|\S+)/.exec(command ?? "");
  if (!m) return false;
  const given = m[1]!.replace(/^(['"])(.*)\1$/, "$2");
  // The command ran in the project or below it; a `cd dir &&` in front moves it.
  const cd = /(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command ?? "");
  const base = cd ? path.resolve(cwd, cd[1]!.replace(/^(['"])(.*)\1$/, "$2").replace(/^~(?=\/|$)/, process.env.HOME ?? "~")) : cwd;
  const dir = path.resolve(base, given.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  return path.resolve(app).startsWith(dir + path.sep);
}

/** One at a time: the simulator is shared by every session. */
let queue: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): Promise<void> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "screen";
}

function ref(c: CaptureRow): CaptureRef {
  return { id: c.id, width: c.width, height: c.height };
}

/** What xcodebuild's output says, if the command ran it. */
export interface XcodebuildOutcome {
  stage: "build" | "archive";
  ok: boolean;
  detail: string;
  /** The line's title when the default ("built …", "archive failed") won't do. */
  title?: string;
  /** The script said it uploaded a build: a ship, as against an archive, a detached launch or a read of the script. */
  shipped?: boolean;
  /** Stopped on purpose (a newer prompt was queued): not a failure, nothing to tell anyone. */
  deliberate?: boolean;
  /** The tool put the script in the background: it is still running, and its output lands in this file (if the tool said where). */
  background?: { output: string | null };
}

/** A release script still running, as `ps` shows it: the script itself, or a shell running it (`bash script`, `zsh -c "… script …"`). */
export function isReleaseProcess(command: string): boolean {
  const [first = "", ...rest] = command.trim().split(/\s+/);
  const script = /(^|\/)(testflight|adhoc)\.sh$/;
  if (script.test(first)) return true;
  if (!/(^|\/)(ba|z)?sh$/.test(first)) return false;
  return rest.some((word) => script.test(word.replace(/^["']|["']$/g, "")));
}

/** What the script's output says once it has stopped: nothing here means it is still going. */
const RELEASE_ENDED = /Uploaded build \d+|Already on TestFlight as build \d+|Tests failed|nothing uploaded|ARCHIVE FAILED|EXPORT FAILED|Upload stopped|^Ready\./m;
/** Is any release script still running on this Mac? */
async function releaseScriptRunning(): Promise<boolean> {
  try {
    const { stdout } = await run("/bin/ps", ["-Ao", "command="], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.split("\n").some(isReleaseProcess);
  } catch {
    return false;
  }
}

/** How long a background upload is waited on before the lamp is given up on. */
const UPLOAD_WATCH_MS = 45 * 60_000;
const UPLOAD_POLL_MS = 5_000;

export { isReleaseScript } from "./release.js";
import { isReleaseScript } from "./release.js";

/** How a release script ended, from what it printed. */
export function releaseOutcome(command: string | undefined, text: string, isError: boolean): XcodebuildOutcome | null {
  if (!isReleaseScript(command)) return null;
  const testflight = /\btestflight\.sh\b/.test(command!);
  const lastLine = text.trim().split("\n").filter(Boolean).pop()?.slice(0, 160) ?? "";
  if (!isError && /running in (the )?background/i.test(text)) {
    // The tool's own notice, with where the output goes; the script hasn't said anything yet.
    const output = /written to:?\s+(\/\S+?\.output)\b/.exec(text)?.[1] ?? null;
    return { stage: "archive", ok: true, title: testflight ? "uploading to TestFlight" : "archiving for ad hoc", detail: "in the background", background: { output } };
  }
  if (/Upload stopped/.test(text)) return { stage: "archive", ok: false, title: "upload stopped", detail: "a newer prompt was queued; the next turn ships both", deliberate: true };
  // Another session's upload already carried this same app: nothing was sent, and nothing failed.
  const already = text.match(/Already on TestFlight as build (\d+)/);
  if (already) return { stage: "archive", ok: true, title: "already on TestFlight", detail: `build ${already[1]} carries this app; not sent again` };
  if (isError || /\bfailed\b|nothing uploaded|ARCHIVE FAILED/i.test(text)) {
    return { stage: "archive", ok: false, title: testflight ? "TestFlight upload failed" : "ad hoc build failed", detail: lastLine };
  }
  const uploaded = text.match(/Uploaded build (\d+)/);
  if (uploaded) return { stage: "archive", ok: true, title: "uploaded to TestFlight", detail: `build ${uploaded[1]}; Apple processes it next`, shipped: true };
  if (/^Ready\./m.test(text)) return { stage: "archive", ok: true, title: "ad hoc build ready", detail: "open the install link on the phone" };
  return { stage: "archive", ok: true, title: testflight ? "uploaded to TestFlight" : "ad hoc build ready", detail: lastLine };
}

/** Does this Bash command run an xcodebuild action whose result is worth a pipeline line? */
export function isXcodebuild(command: string | undefined): boolean {
  if (!command || !/\bxcodebuild\b/.test(command)) return false;
  const words = command.split(/\s+/);
  return words.includes("build") || words.includes("archive") || words.includes("test");
}

export function xcodebuildOutcome(command: string | undefined, text: string, isError: boolean): XcodebuildOutcome | null {
  if (!command || !/\bxcodebuild\b/.test(command)) return null;
  const stage = command.split(/\s+/).includes("archive") ? "archive" : "build";
  const failed = /\*\* (BUILD|ARCHIVE|TEST|EXPORT) FAILED \*\*|BUILD FAILED|ARCHIVE FAILED/.test(text);
  const succeeded = /\*\* (BUILD|ARCHIVE|TEST|EXPORT) SUCCEEDED \*\*|BUILD SUCCEEDED|ARCHIVE SUCCEEDED|TEST SUCCEEDED/.test(text);
  const errors = text.split("\n").filter((l) => /(^|\s)error:/.test(l) && !/warning:/.test(l));
  if (failed || (isError && !succeeded)) {
    const first = errors[0]?.trim() ?? text.trim().split("\n").filter(Boolean).pop() ?? "";
    return { stage, ok: false, detail: errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"}: ${first.slice(0, 160)}` : first.slice(0, 160) };
  }
  if (succeeded) {
    const warnings = (text.match(/warning:/g) ?? []).length;
    const parts = [/TEST SUCCEEDED/.test(text) ? "tests passed" : "", warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""];
    return { stage, ok: true, detail: parts.filter(Boolean).join(", ") };
  }
  return null;
}

async function executableOf(app: string): Promise<string> {
  try {
    const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", path.join(app, "Info.plist")]);
    const name = (JSON.parse(stdout) as { CFBundleExecutable?: string }).CFBundleExecutable;
    if (name) return path.join(app, name);
  } catch {
    /* fall through */
  }
  return path.join(app, path.basename(app, ".app"));
}

async function builtAt(app: string): Promise<number | null> {
  try {
    return fs.statSync(await executableOf(app)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * One turn's shots. A capture holds on to the turn it started in, so one
 * still running when the next prompt arrives files its shots under its own
 * turn, not the new one.
 */
interface TurnShots {
  turn: number;
  /** "Before" shots: taken when the turn starts, or failing that before its first new build is installed. */
  before: Map<string, CaptureRow>;
  /** A build has been installed this turn, so the simulator no longer shows "before". */
  installed: boolean;
  /** Lines by id, so the caption can be filled in at the end. */
  lines: Map<string, PreviewLine>;
  caption: string | null;
  /** The args Claude last launched the app with this turn, if it did. */
  working: string[] | null;
  /** The preview app was rebuilt this turn: its screens are shot once, as the turn ends. */
  built: boolean;
  /** The turn has its result: a build after this (a script in the background) is shot at once. */
  ended: boolean;
  /** The build the last round shot, so the turn's end doesn't shoot it again. */
  shotBuild: number | null | undefined;
  /** Said on every line shot this turn when the picture isn't the wanted one. */
  note?: string | undefined;
}

function turnShots(turn: number): TurnShots {
  return { turn, before: new Map(), installed: false, lines: new Map(), caption: null, working: null, built: false, ended: false, shotBuild: undefined };
}

export class PreviewWatcher {
  private t = turnShots(0);
  private lastBuildMtime: number | null | undefined;
  /** A capture waiting its place in the queue: another build before it starts adds nothing. */
  private queuedCapture: Promise<void> | null = null;
  /** The mid-turn round waiting for builds to go quiet. */
  private quietTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly emit: Emit,
  ) {}

  /** Told how a build or upload ended when it ended after its tool call did (a script run in the background). */
  onOutcome?: (outcome: XcodebuildOutcome) => void;

  private get preview(): PreviewConfig | null {
    const p = projectConfig(this.cwd).preview;
    return p && p.app ? p : null;
  }

  /** A turn begins; with `shootBefore`, the app as it stands is captured now, before anything is built. */
  async startTurn(turn: number, opts: { shootBefore?: boolean } = {}): Promise<void> {
    // A prompt sent mid-turn joins the running turn: its shots and lines stay as they are.
    if (turn === this.t.turn && turn !== 0) return;
    this.t = turnShots(turn);
    // Builds older than this turn don't count.
    const p = this.preview;
    this.lastBuildMtime = p ? await builtAt(p.app) : undefined;
    if (p && opts.shootBefore) {
      // The app as the last build left it: already on file, no need to shoot it again.
      for (const screen of p.screens) {
        const last = this.store.latestCapture(this.cwd, screen.name);
        if (last && fs.existsSync(last.path)) this.t.before.set(screen.name, last);
      }
      if (p.screens.every((screen) => this.t.before.has(screen.name))) return;
      void this.shootBefore(p, this.t).catch((err: unknown) => console.error(`[${this.sessionId.slice(0, 8)}] before shots failed:`, err));
    }
  }

  /** Claude read an image: keep a copy and show it in the preview. */
  async sawImage(file: string): Promise<void> {
    if (!isImagePath(file) || !fs.existsSync(file)) return;
    const id = randomUUID();
    const dir = path.join(capturesDir, this.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${id}.png`);
    await run("sips", ["-s", "format", "png", file, "--out", out], { timeout: 60_000 });
    await shrinkForPhone(out);
    const size = sim.pngSize(out);
    const name = path.basename(file);
    const row = this.store.insertCapture({ id, session_id: this.sessionId, turn: this.t.turn, screen: name, kind: "look", path: out, ...size });
    this.emit({ type: "look", id: `look-${id}`, turn: this.t.turn, name, capture: ref(row), ts: new Date().toISOString() });
  }

  /** A tool is starting; an xcodebuild or a release script gets a `running` line the result will replace. */
  beforeTool(toolUseId: string, command: string | undefined): boolean {
    if (command && /\bsimctl\b|\bdevicectl\b/.test(command)) simInUse.tools.add(toolUseId);
    const p = this.preview;
    const launched = p && command ? launchedArgs(command, p.bundleId) : null;
    if (launched) this.t.working = launched;
    if (isReleaseScript(command)) {
      const title = /\btestflight\.sh\b/.test(command!) ? "archiving and uploading to TestFlight" : "archiving for ad hoc";
      this.emit({ type: "pipeline", stage: "archive", status: "running", title, ref: toolUseId, ts: new Date().toISOString() });
      return true;
    }
    if (!isXcodebuild(command)) return false;
    const stage = command!.split(/\s+/).includes("archive") ? "archive" : "build";
    this.emit({ type: "pipeline", stage, status: "running", title: `${stage === "archive" ? "archiving" : "building"} ${path.basename(this.cwd)}`, ref: toolUseId, ts: new Date().toISOString() });
    return true;
  }

  /** A tool finished; if it was a build, say so, and if the app changed, capture it. */
  async afterTool(toolUseId: string, command: string | undefined, text: string, isError: boolean): Promise<XcodebuildOutcome | null> {
    if (simInUse.tools.delete(toolUseId)) simInUse.ended = Date.now();
    let outcome = releaseOutcome(command, text, isError) ?? xcodebuildOutcome(command, text, isError);
    // An xcodebuild whose output said nothing either way (piped through a filter) ended somehow;
    // its `running` line mustn't be left spinning.
    if (!outcome && isXcodebuild(command)) {
      outcome = { stage: command!.split(/\s+/).includes("archive") ? "archive" : "build", ok: !isError, detail: isError ? text.trim().split("\n").pop()?.slice(0, 160) ?? "" : "" };
    }
    if (outcome?.background) {
      // The script is still running: keep its line `running` and watch for its end ourselves, so the
      // flight lamp stays lit while the turn goes on, or ends, without it.
      this.emit({ type: "pipeline", stage: "archive", status: "running", title: outcome.title ?? "uploading", detail: outcome.detail, ref: toolUseId, ts: new Date().toISOString() });
      void this.watchUpload(toolUseId, command!, outcome.background.output).catch((err: unknown) => console.error(`[${this.sessionId.slice(0, 8)}] upload watch failed:`, err));
      return null;
    }
    if (outcome) {
      this.emit({
        type: "pipeline",
        stage: outcome.stage,
        status: outcome.ok ? "done" : "failed",
        title: outcome.title ?? (outcome.ok ? `${outcome.stage === "archive" ? "archived" : "built"} ${path.basename(this.cwd)}` : `${outcome.stage} failed`),
        detail: outcome.detail,
        log: text.length > 60_000 ? text.slice(-60_000) : text,
        ref: toolUseId,
        ts: new Date().toISOString(),
      });
    }
    // A build may have made the app a repo with no .vibemachine.json is found by: look again now.
    if (outcome && isXcodebuild(command)) forgetDetected(this.cwd);
    // A successful build of the preview's own app counts even when nothing relinked.
    const p = this.preview;
    const force = outcome?.ok === true && outcome.stage === "build" && p !== null && buildsPreviewApp(command, this.cwd, p.app);
    await this.checkBuild({ announced: outcome !== null, force });
    return outcome;
  }

  /**
   * A release script running in the background: its output file is read every few seconds until it
   * says how it ended, or until no such script is running and the output has stopped changing; then
   * the `running` line is replaced the way a foreground run's would be, and `onOutcome` is told.
   */
  private async watchUpload(toolUseId: string, command: string, output: string | null): Promise<void> {
    const started = Date.now();
    let last: string | null = null;
    let quiet = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, UPLOAD_POLL_MS));
      let text = "";
      try {
        if (output) text = fs.readFileSync(output, "utf8");
      } catch {
        text = "";
      }
      let outcome: XcodebuildOutcome | null = null;
      if (RELEASE_ENDED.test(text)) outcome = releaseOutcome(command, text, false);
      else if (!(await releaseScriptRunning())) {
        // Gone without a last word: a stop from outside, or output we can't read.
        quiet = text === last ? quiet + 1 : 0;
        if (quiet >= 1) {
          if (text.trim()) outcome = releaseOutcome(command, text, true);
          else if (output) outcome = { stage: "archive", ok: false, title: "upload ended without a word", detail: "the script stopped before saying how it went" };
          else outcome = { stage: "archive", ok: true, title: "upload finished", detail: "its output wasn't captured" };
        }
      } else if (Date.now() - started > UPLOAD_WATCH_MS) {
        outcome = { stage: "archive", ok: false, title: "upload gave no word", detail: `nothing from the script in ${UPLOAD_WATCH_MS / 60_000} minutes` };
      }
      last = text;
      if (!outcome) continue;
      const final: XcodebuildOutcome = outcome.background ? { stage: "archive", ok: false, title: "upload ended without a word", detail: "" } : outcome;
      this.emit({
        type: "pipeline",
        stage: "archive",
        status: final.ok ? "done" : "failed",
        title: final.title ?? (final.ok ? "uploaded" : "upload failed"),
        detail: final.detail,
        log: text.length > 60_000 ? text.slice(-60_000) : text,
        ref: toolUseId,
        ts: new Date().toISOString(),
      });
      this.onOutcome?.(final);
      return;
    }
  }

  /** The turn ended: fill in the caption on this turn's preview lines. */
  async endTurn(caption: string | null): Promise<void> {
    await this.checkBuild({ announced: false, force: false });
    const t = this.t;
    t.caption = caption;
    t.ended = true;
    const p = this.preview;
    // The turn's last build, if no mid-turn round has shot it yet.
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    if (p && t.built) void this.shootBuild(p, t);
    if (p && t.working && !p.screens.some((screen) => screenKey(screen.args) === screenKey(t.working!))) {
      // The screen Claude opened itself: what this turn was about, unless a configured screen already shows it.
      const screen: Screen = { name: WORKING_ON, args: t.working.includes("-noPushPrompt") ? t.working : ["-noPushPrompt", "YES", ...t.working] };
      void this.captureWorking(p, t, screen).catch((err: unknown) => console.error(`[${this.sessionId.slice(0, 8)}] working-on shot failed:`, err));
    }
    if (!caption) return;
    for (const line of t.lines.values()) {
      if (line.status === "capturing") continue; // the capture will carry it when it lands
      this.send(t, { ...line, caption });
    }
  }

  /** Capture now, whatever happened (vm preview, or the phone): no "before" unless the turn already has one. */
  captureNow(): Promise<void> {
    const p = this.preview;
    if (!p) throw new Error(`no iPhone app built in ${this.cwd} yet, and no .vibemachine.json naming one`);
    return this.capture(p, this.t, false);
  }

  private async checkBuild(opts: { announced: boolean; force: boolean }): Promise<void> {
    const p = this.preview;
    if (!p) return;
    const mtime = await builtAt(p.app);
    const changed = mtime !== null && mtime !== this.lastBuildMtime;
    if (!changed && !opts.force) return;
    if (mtime !== null) this.lastBuildMtime = mtime;
    if (changed && !opts.announced) {
      this.emit({ type: "pipeline", stage: "build", status: "done", title: `built ${path.basename(p.app)}`, detail: "app bundle updated", ts: new Date().toISOString() });
    }
    // Shot once builds go quiet, mid-turn (a turn that builds five times in a row is shot once), and
    // again as the turn ends if it built since. A build landing after the turn ended is shot now.
    this.t.built = true;
    if (this.t.ended) void this.shootBuild(p, this.t);
    else this.whenQuiet(p, this.t);
  }

  /** A round for the newest build, unless one already shot it. */
  private shootBuild(p: PreviewConfig, t: TurnShots): Promise<void> {
    if (t.shotBuild !== undefined && t.shotBuild === this.lastBuildMtime) return Promise.resolve();
    t.shotBuild = this.lastBuildMtime;
    return this.capture(p, t, true).catch((err: unknown) => console.error(`[${this.sessionId.slice(0, 8)}] preview failed:`, err));
  }

  /**
   * The mid-turn round: once no build has landed for MIDTURN_QUIET_MS, and Claude isn't using the
   * simulator itself (a simctl or devicectl call running, or one just ended); a round folds it and
   * relaunches the app, which would land in the middle of Claude's own screenshots.
   */
  private whenQuiet(p: PreviewConfig, t: TurnShots, wait = MIDTURN_QUIET_MS): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (this.t !== t || t.ended) return;
      if (simBusy()) return this.whenQuiet(p, t, SIM_IN_USE_MS);
      void this.shootBuild(p, t);
    }, wait);
    this.quietTimer.unref();
  }

  private send(t: TurnShots, line: PreviewLine): void {
    t.lines.set(line.id, line);
    this.emit(line);
  }

  private lineId(t: TurnShots, screen: Screen): string {
    return `${t.turn}-${slug(screen.name)}`;
  }

  private lineFor(t: TurnShots, screen: Screen, status: PreviewLine["status"], after: CaptureRef | null, error?: string, unchanged = false, poseNote?: string, clip = false, changes: sim.ChangeBox[] = []): PreviewLine {
    const before = t.before.get(screen.name);
    const note = [t.note, poseNote, unchanged ? "No change on this screen" : undefined].filter(Boolean).join(" · ");
    return {
      type: "preview",
      id: this.lineId(t, screen),
      turn: t.turn,
      screen: screen.name,
      status,
      before: before ? ref(before) : null,
      after,
      caption: t.caption,
      ...(error ? { error } : {}),
      ...(note ? { note } : {}),
      ...(unchanged ? { unchanged: true } : {}),
      ...(changes.length > 0 ? { changes } : {}),
      ...(clip ? { clip: true } : {}),
      ts: new Date().toISOString(),
    };
  }

  /**
   * The turn's "before" shots, taken as it starts. Only if the simulator is
   * already up with the app on it: a turn that never builds shouldn't boot one.
   */
  private shootBefore(p: PreviewConfig, t: TurnShots): Promise<void> {
    return enqueue(async () => {
      if (this.t !== t || t.installed) return;
      // Only if no one else is on the simulator: a before shot is worth no wait.
      await lease.holding(this.leaseLabel(), 0, () => this.shootBeforeHeld(p, t));
    });
  }

  private async shootBeforeHeld(p: PreviewConfig, t: TurnShots): Promise<void> {
    const device = await sim.findDevice(p.simulator);
    if (!device || device.state !== "Booted" || !(await sim.isInstalled(device.udid, p.bundleId))) return;
    if (await this.canPose(device.udid, p)) {
      await sim.freezeStatusBar(device.udid);
      await this.posed(device.udid, p.screens.filter((s) => !t.before.has(s.name)), async (screen, display) => {
        if (this.t !== t || t.installed) return;
        t.before.set(screen.name, await this.shoot(device.udid, p, t, screen, "before", display));
      });
      return;
    }
    const kind = await sim.activeDisplayKind(device.udid, capturesDir);
    for (const screen of screensFor(p.screens, kind)) {
      // A new turn, or a build already landed (the capture shoots what's missing itself).
      if (this.t !== t || t.installed) return;
      if (!t.before.has(screen.name)) t.before.set(screen.name, await this.shoot(device.udid, p, t, screen, "before"));
    }
  }

  private capture(p: PreviewConfig, t: TurnShots, takeBefore: boolean): Promise<void> {
    if (this.queuedCapture) return this.queuedCapture;
    let screens = p.screens;
    const job = enqueue(async () => {
      this.queuedCapture = null;
      // Any session using the simulator itself holds the round back, for a while at most.
      await untilSimFree();
      // And any session holding the simulator (scripts/sim) finishes first.
      if (!(await lease.claim(this.leaseLabel(), SIM_WAIT_MAX_MS))) {
        for (const screen of screens) this.send(t, this.lineFor(t, screen, "failed", null, "the simulator stayed busy with another session"));
        return;
      }
      try {
        const device = await sim.findDevice(p.simulator);
        if (!device) throw new Error(`no simulator named ${p.simulator}`);
        await sim.ensureBooted(device);
        if (!fs.existsSync(p.app)) throw new Error(`no app at ${p.app}`);
        // A foldable that can be posed shoots every screen in its own view; otherwise only what the
        // simulator is really showing: unfolded, the inner screen's shots; folded, the cover's.
        const posing = await this.canPose(device.udid, p);
        if (posing) {
          screens = p.screens;
          t.note = undefined;
        } else {
          const kind = await sim.activeDisplayKind(device.udid, capturesDir);
          const fitting = screensFor(p.screens, kind);
          screens = fitting.length > 0 ? fitting : p.screens.slice(0, 1);
          t.note = foldedNote(p.screens, kind);
        }
        // While the new shots are taken, each line keeps the picture it had (the last "after", or "before").
        for (const screen of screens) this.send(t, this.lineFor(t, screen, "capturing", t.lines.get(this.lineId(t, screen))?.after ?? null));
        await sim.freezeStatusBar(device.udid);
        if (takeBefore && !t.installed && (await sim.isInstalled(device.udid, p.bundleId))) {
          // Whatever the turn's start didn't get to.
          const missing = screens.filter((s) => !t.before.has(s.name));
          if (posing) await this.posed(device.udid, missing, async (screen, display) => void t.before.set(screen.name, await this.shoot(device.udid, p, t, screen, "before", display)));
          else for (const screen of missing) t.before.set(screen.name, await this.shoot(device.udid, p, t, screen, "before"));
        }
        await sim.install(device.udid, p.app);
        t.installed = true;
        const after = async (screen: Screen, display?: string, poseNote?: string): Promise<void> => {
          try {
            const { row, unchanged, changes } = await this.shootAfter(device.udid, p, t, screen, display);
            this.send(t, this.lineFor(t, screen, "done", ref(row), undefined, unchanged, poseNote, !unchanged && fs.existsSync(clipPath(row.path)), changes));
          } catch (err) {
            this.send(t, this.lineFor(t, screen, "failed", null, err instanceof Error ? err.message : String(err), false, poseNote));
          }
        };
        if (posing) await this.posed(device.udid, screens, after);
        else for (const screen of screens) await after(screen);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const screen of screens) this.send(t, this.lineFor(t, screen, "failed", null, message));
        throw err;
      } finally {
        await lease.release();
      }
    });
    this.queuedCapture = job;
    return job;
  }

  /** The screen Claude opened itself, shot once as the turn ends, on whatever display is lit. */
  private captureWorking(p: PreviewConfig, t: TurnShots, screen: Screen): Promise<void> {
    return enqueue(async () => {
      // Another session on the simulator by now means the screen is theirs, not this turn's.
      if (!(await lease.claim(this.leaseLabel(), 0))) return;
      try {
        const device = await sim.findDevice(p.simulator);
        if (!device || device.state !== "Booted" || !(await sim.isInstalled(device.udid, p.bundleId))) return;
        this.send(t, this.lineFor(t, screen, "capturing", null));
        await sim.freezeStatusBar(device.udid);
        const after = await this.shoot(device.udid, p, t, screen, "after");
        this.send(t, this.lineFor(t, screen, "done", ref(after)));
      } catch (err) {
        this.send(t, this.lineFor(t, screen, "failed", null, err instanceof Error ? err.message : String(err)));
      } finally {
        await lease.release();
      }
    });
  }

  /** Who holds the simulator during this watcher's rounds, as `sim status` shows it. */
  private leaseLabel(): string {
    return `the daemon's preview round (session ${this.sessionId.slice(0, 8)}, ${path.basename(this.cwd)})`;
  }

  /**
   * A screen's "after": shot, then compared with what it showed before (the turn's "before", else its
   * newest capture in the project), with where it differs. The same picture isn't kept twice: the
   * new file goes and the earlier capture stands, marked unchanged.
   */
  private async shootAfter(udid: string, p: PreviewConfig, t: TurnShots, screen: Screen, display?: string): Promise<{ row: CaptureRow; unchanged: boolean; changes: sim.ChangeBox[] }> {
    const raw = path.join(capturesDir, this.sessionId, `clip-${randomUUID()}.mov`);
    const row = await this.shoot(udid, p, t, screen, "after", display, raw);
    // The clip is only kept for a screen that changed, and then only if the app moves once it is up
    // (clips.ts); it's judged, cut and shrunk on its own queue so the round shoots on, and the line
    // says so once it's ready.
    const keepClip = async (): Promise<void> => {
      if (!fs.existsSync(raw)) return;
      clipQueue = clipQueue.then(async () => {
        try {
          const { kept, why } = await finishClip(raw, clipPath(row.path));
          if (why) console.log(`[${this.sessionId.slice(0, 8)}] clip of ${screen.name} ${kept ? "kept" : "dropped"}: ${why}`);
          const id = this.lineId(t, screen);
          const line = t.lines.get(id);
          if (kept && line && line.after?.id === row.id && fs.existsSync(clipPath(row.path))) this.send(t, { ...line, clip: true, ts: new Date().toISOString() });
        } catch (err) {
          console.error(`[${this.sessionId.slice(0, 8)}] clip failed:`, err instanceof Error ? err.message : err);
        } finally {
          fs.rmSync(raw, { force: true });
        }
      });
    };
    const previous = t.before.get(screen.name) ?? this.store.latestCaptureBefore(this.cwd, screen.name, row.id);
    if (!previous || !fs.existsSync(previous.path)) {
      await keepClip();
      return { row, unchanged: false, changes: [] };
    }
    let changes: sim.ChangeBox[];
    try {
      changes = await sim.compareShots(row.path, previous.path, path.join(capturesDir, `print-${process.pid}`));
    } catch {
      changes = [{ x: 0, y: 0, w: 1, h: 1 }];
    }
    if (changes.length > 0) {
      await keepClip();
      return { row, unchanged: false, changes };
    }
    fs.rmSync(raw, { force: true });
    this.store.deleteCapture(row.id);
    for (const f of [row.path, servedPath(row.path), originalPath(row.path), clipPath(row.path)]) fs.rmSync(f, { force: true });
    return { row: previous, unchanged: true, changes: [] };
  }

  /** Does this round pose the simulator: screens name views, and the simulator has a hinge the helper can move. */
  private async canPose(udid: string, p: PreviewConfig): Promise<boolean> {
    return p.screens.some((s) => s.view) && (await fold.hingeAngle(udid)) !== null;
  }

  /**
   * Run `each` for every screen with the simulator in the screen's view: screens grouped by pose so
   * the hinge moves as little as it can, the lit display named for the shot, and the simulator put
   * back where it was afterwards. A pose that doesn't land is said on its screens, which are then
   * shot as the simulator stands.
   */
  private async posed(udid: string, screens: Screen[], each: (screen: Screen, display?: string, poseNote?: string) => Promise<void>): Promise<void> {
    if (screens.length === 0) return;
    const start = await fold.currentPose(udid);
    try {
      for (const group of fold.groupByPose(screens)) {
        let display: string | undefined;
        let poseNote: string | undefined;
        if (group.pose) {
          if (await fold.setPose(udid, group.pose)) display = (await fold.litDisplay(udid, group.pose.angle === 0)) ?? undefined;
          else poseNote = "The simulator didn't take this view, so this is how it stood";
        }
        for (const screen of group.screens) await each(screen, display, poseNote);
      }
    } finally {
      if (start) await fold.setPose(udid, start);
    }
  }

  /** `clip`: record the screen from launch to the shot into this file (the after shots). */
  private async shoot(udid: string, p: PreviewConfig, t: TurnShots, screen: Screen, kind: "before" | "after", display?: string, clip?: string): Promise<CaptureRow> {
    if (clip) fs.mkdirSync(path.dirname(clip), { recursive: true });
    const recording = clip && p.clips ? await sim.startRecording(udid, display, clip) : null;
    await sim.launch(udid, p.bundleId, screen.args);
    // A launch while half folded (book, desk) takes longer to settle into its layout: at 3 s it was
    // still the bare one-pane screen, at 8 s the real book view.
    const halfOpen = screen.view === "book" || screen.view === "desk";
    await new Promise((r) => setTimeout(r, halfOpen ? Math.max(p.settleMs * 2, HALF_OPEN_SETTLE_MS) : p.settleMs));
    const id = randomUUID();
    const dir = path.join(capturesDir, this.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.png`);
    try {
      if (display) await sim.screenshotDisplay(udid, display, file, capturesDir);
      else await sim.screenshot(udid, file, capturesDir);
    } finally {
      if (recording && !(await recording.stop()) && clip) fs.rmSync(clip, { force: true });
    }
    await shrinkForPhone(file);
    const { width, height } = sim.pngSize(file);
    return this.store.insertCapture({ id, session_id: this.sessionId, turn: t.turn, screen: screen.name, kind, path: file, width, height });
  }
}
