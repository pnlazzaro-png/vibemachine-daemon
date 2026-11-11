// Per-project settings the daemon reads from `.vibemachine.json` at the root
// of the session's cwd (cached by mtime). Today it describes the preview:
// which simulator and app to screenshot after a build, which screens to
// open with launch arguments, and a web URL for projects that are pages.
// The file is optional (2026-11-10): with none, an iPhone app the repo builds
// is found by itself (`detectedPreview`) and shot as one screen; the file is
// for more screens, launch arguments, another simulator or a web page.
//
//   {
//     "preview": {
//       "simulator": "iPhone Duo",
//       "bundle_id": "com.pnlazzaro.vibemachine",
//       "app": "ios/build/DerivedData/Build/Products/Debug-iphonesimulator/VibeMachine.app",
//       "settle_ms": 2500,
//       "screens": [
//         { "name": "Unfolded", "view": "unfolded", "args": [] },
//         { "name": "Folded", "view": "folded", "args": [] },
//         { "name": "Desk", "view": "desk", "args": ["-showStats", "YES"] }
//       ],
//
// A screen's `view` is one of the Duo's six (unfolded, unfolded portrait, folded, folded landscape,
// book, desk): the simulator is folded and turned to it before the shot (fold.ts). Where it can't
// be (a simulator with no hinge), only the screens of the display that is lit are shot.
//       "web": "https://your-mac.your-tailnet.ts.net:8443"
//     },
//     "release": { "stop_on_prompt": true }
//   }
//
// `release.stop_on_prompt`: a prompt queued while the project's `testflight.sh` is still testing or
// archiving stops it, so both changes go out in one build (uploads.ts). Off unless the project says so.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isView, type View } from "./fold.js";

export const PROJECT_FILE = ".vibemachine.json";

export interface Screen {
  name: string;
  args: string[];
  /** The phone screen it shows: "inner" (unfolded) or "cover" (folded); shot only while that one is lit. Unset: either. */
  display?: "inner" | "cover";
  /** The view to pose the simulator in for the shot; implies `display`. */
  view?: View;
}

export interface PreviewConfig {
  /** Simulator device name (or UDID). Default: iPhone Duo. */
  simulator: string;
  bundleId: string;
  /** The built .app, absolute (resolved against the cwd). */
  app: string;
  /** How long after launch to wait before the screenshot. */
  settleMs: number;
  /** Record each changed screen from launch to the shot as a short clip (`"clips": false` turns it off). */
  clips: boolean;
  screens: Screen[];
  /** A page to show live in the preview pane instead of, or as well as, screenshots. */
  web: string | null;
}

export interface ProjectConfig {
  preview: PreviewConfig | null;
  /**
   * `"release": { "stop_on_prompt": true }`: a prompt queued while this project's upload script
   * (`testflight.sh`) runs stops it, so both changes ship in one build (uploads.ts). Off unless asked
   * for: the script has to be one that takes a TERM and tidies up after itself.
   */
  stopUploadsOnPrompt: boolean;
}

interface Cached {
  mtimeMs: number;
  config: ProjectConfig;
}

const cache = new Map<string, Cached>();
const EMPTY: ProjectConfig = { preview: null, stopUploadsOnPrompt: false };

export function projectConfig(cwd: string): ProjectConfig {
  const file = path.join(cwd, PROJECT_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(cwd);
    const found = detectedPreview(cwd);
    return found ? { preview: found, stopUploadsOnPrompt: false } : EMPTY;
  }
  const hit = cache.get(cwd);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.config;
  let config = EMPTY;
  try {
    config = parseProjectConfig(JSON.parse(fs.readFileSync(file, "utf8")) as unknown, cwd);
  } catch (err) {
    console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  cache.set(cwd, { mtimeMs: stat.mtimeMs, config });
  return config;
}

export function parseProjectConfig(raw: unknown, cwd: string): ProjectConfig {
  if (!raw || typeof raw !== "object") throw new Error("must be a JSON object");
  const release = (raw as { release?: unknown }).release;
  const stopUploadsOnPrompt = !!release && typeof release === "object" && (release as { stop_on_prompt?: unknown }).stop_on_prompt === true;
  const p = (raw as { preview?: unknown }).preview;
  if (p === undefined || p === null) return { preview: null, stopUploadsOnPrompt };
  if (typeof p !== "object") throw new Error("preview must be an object");
  const o = p as Record<string, unknown>;
  const web = typeof o.web === "string" && o.web.trim() ? o.web.trim() : null;
  const bundleId = typeof o.bundle_id === "string" ? o.bundle_id.trim() : "";
  const app = typeof o.app === "string" ? o.app.trim() : "";
  if (!bundleId && !app && !web) throw new Error("preview needs bundle_id and app, or web");
  if ((bundleId && !app) || (app && !bundleId)) throw new Error("preview needs both bundle_id and app");
  const screensRaw = Array.isArray(o.screens) ? o.screens : [];
  const screens: Screen[] = screensRaw.map((s, i) => {
    if (!s || typeof s !== "object") throw new Error(`screens[${i}] must be an object`);
    const so = s as Record<string, unknown>;
    const name = typeof so.name === "string" && so.name.trim() ? so.name.trim() : `Screen ${i + 1}`;
    const args = Array.isArray(so.args) ? so.args.map(String) : [];
    if (so.display !== undefined && so.display !== "inner" && so.display !== "cover") throw new Error(`screens[${i}].display must be "inner" or "cover"`);
    if (so.view !== undefined && !isView(so.view)) throw new Error(`screens[${i}].view must be one of unfolded, unfolded portrait, folded, folded landscape, book, desk`);
    const view = so.view as View | undefined;
    const display = (so.display as "inner" | "cover" | undefined) ?? (view ? (view.startsWith("folded") ? "cover" : "inner") : undefined);
    return { name, args, ...(display ? { display } : {}), ...(view ? { view } : {}) };
  });
  if (app && screens.length === 0) screens.push({ name: "App", args: [] });
  const settle = Number(o.settle_ms);
  return {
    stopUploadsOnPrompt,
    preview: {
      simulator: typeof o.simulator === "string" && o.simulator.trim() ? o.simulator.trim() : "iPhone Duo",
      bundleId,
      app: app ? path.resolve(cwd, app) : "",
      settleMs: Number.isFinite(settle) && settle >= 0 ? settle : 2500,
      clips: o.clips !== false,
      screens,
      web,
    },
  };
}

/**
 * What the phone needs to know about a project's preview, in a session row. An iPhone app not yet
 * built still says its one screen, so the pane waits for the first build instead of asking for a file.
 */
export function previewSummary(cwd: string): { web: string | null; screens: string[] } | null {
  const p = projectConfig(cwd).preview;
  if (p) return { web: p.web, screens: p.app ? p.screens.map((s) => s.name) : [] };
  return scan(cwd).appProject ? { web: null, screens: [DETECTED_SCREEN.name] } : null;
}

// ---- Finding the app with no file ----

const DETECTED_SCREEN: Screen = { name: "App", args: [] };
/** How long a scan of a repo stands; a build the daemon sees (`forgetDetected`) ends it sooner. */
const DETECT_TTL_MS = 15_000;
/** Deep enough for ios/build/DerivedData/Build/Products/Debug-iphonesimulator/X.app. */
const DETECT_DEPTH = 7;
const SKIP_DIRS = new Set(["node_modules", "Pods", "Carthage", "SourcePackages", "Intermediates.noindex", "Index.noindex", "ModuleCache.noindex", "Logs", "dist", "vendor"]);
const SKIP_SUFFIX = /\.(app|appex|xcodeproj|xcworkspace|xcassets|xcresult|xcarchive|bundle|framework|lproj|dSYM|playground|swiftpm)$/;

interface Scan {
  at: number;
  /** iPhone-simulator apps built in the repo or in Xcode's own DerivedData for it. */
  apps: string[];
  /** The repo has an Xcode project (or an XcodeGen spec): an app, even before its first build. */
  appProject: boolean;
}

const scans = new Map<string, Scan>();

/** A build just ran in `cwd`: look for its app again next time rather than waiting out the scan. */
export function forgetDetected(cwd: string): void {
  scans.delete(path.resolve(cwd));
}

/**
 * The preview for a repo with no `.vibemachine.json`: the newest app built for the iPhone simulator
 * (a test runner aside), its bundle id read from the app itself, shot on the Duo as one screen.
 * Null where nothing has been built yet, or the repo isn't an app.
 */
export function detectedPreview(cwd: string, xcodeDerivedData = path.join(os.homedir(), "Library/Developer/Xcode/DerivedData")): PreviewConfig | null {
  let newest: { app: string; id: string; at: number } | null = null;
  for (const app of scan(cwd, xcodeDerivedData).apps) {
    const info = bundleInfo(app);
    if (!info || (newest && info.builtAt <= newest.at)) continue;
    newest = { app, id: info.id, at: info.builtAt };
  }
  if (!newest) return null;
  return { simulator: "iPhone Duo", bundleId: newest.id, app: newest.app, settleMs: 2500, clips: true, screens: [DETECTED_SCREEN], web: null };
}

function scan(dir: string, xcodeDerivedData = path.join(os.homedir(), "Library/Developer/Xcode/DerivedData")): Scan {
  const cwd = path.resolve(dir);
  const hit = scans.get(cwd);
  if (hit && Date.now() - hit.at < DETECT_TTL_MS) return hit;
  const apps: string[] = [];
  const projects = new Set<string>();
  let spec = false;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const products = isSimulatorProducts(dir);
    for (const e of entries) {
      if (depth <= 2 && e.isFile() && e.name === "project.yml") spec = true;
      if (!e.isDirectory()) continue;
      if (products) {
        if (isAppBundle(e.name)) apps.push(path.join(dir, e.name));
        continue;
      }
      if (depth <= 2 && /\.(xcodeproj|xcworkspace)$/.test(e.name)) projects.add(e.name.replace(/\.(xcodeproj|xcworkspace)$/, ""));
      if (depth >= DETECT_DEPTH || e.name.startsWith(".") || SKIP_DIRS.has(e.name) || SKIP_SUFFIX.test(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(cwd, 0);
  // Built from Xcode, or by an xcodebuild with no -derivedDataPath: Xcode's own folder, one directory
  // per workspace, named after it, whose info.plist says where the workspace lives.
  for (const name of projects) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(xcodeDerivedData).filter((d) => d.startsWith(`${name}-`));
    } catch {
      break;
    }
    for (const d of dirs) {
      const root = path.join(xcodeDerivedData, d);
      const workspace = plistValue(path.join(root, "info.plist"), "WorkspacePath");
      if (!workspace || !(workspace === cwd || workspace.startsWith(cwd + path.sep))) continue;
      const productsDir = path.join(root, "Build", "Products");
      let configs: string[];
      try {
        configs = fs.readdirSync(productsDir).filter((c) => c.endsWith("-iphonesimulator"));
      } catch {
        continue;
      }
      for (const c of configs) {
        try {
          for (const a of fs.readdirSync(path.join(productsDir, c))) if (isAppBundle(a)) apps.push(path.join(productsDir, c, a));
        } catch {
          /* gone since */
        }
      }
    }
  }
  const result: Scan = { at: Date.now(), apps, appProject: spec || projects.size > 0 || apps.length > 0 };
  scans.set(cwd, result);
  return result;
}

/** A `Products/<config>-iphonesimulator` folder, where a build puts its apps. */
function isSimulatorProducts(dir: string): boolean {
  return dir.endsWith("-iphonesimulator") && path.basename(path.dirname(dir)) === "Products";
}

function isAppBundle(name: string): boolean {
  return name.endsWith(".app") && !name.endsWith("-Runner.app");
}

const plists = new Map<string, { mtimeMs: number; json: Record<string, unknown> | null }>();

/** A plist read as JSON, cached by its mtime. */
function readPlist(file: string): { mtimeMs: number; json: Record<string, unknown> | null } | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = plists.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })) as Record<string, unknown>;
  } catch {
    json = null;
  }
  const entry = { mtimeMs, json };
  plists.set(file, entry);
  return entry;
}

function plistValue(file: string, key: string): string | null {
  const v = readPlist(file)?.json?.[key];
  return typeof v === "string" && v ? v : null;
}

/** An app's bundle id and when its executable was last written. */
function bundleInfo(app: string): { id: string; builtAt: number } | null {
  const plist = readPlist(path.join(app, "Info.plist"))?.json;
  const id = plist?.CFBundleIdentifier;
  if (typeof id !== "string" || !id) return null;
  const exe = typeof plist?.CFBundleExecutable === "string" ? plist.CFBundleExecutable : path.basename(app, ".app");
  try {
    return { id, builtAt: fs.statSync(path.join(app, exe)).mtimeMs };
  } catch {
    return null;
  }
}
