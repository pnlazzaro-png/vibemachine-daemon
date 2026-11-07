// Per-project settings the daemon reads from `.vibemachine.json` at the root
// of the session's cwd (cached by mtime). Today it describes the preview:
// which simulator and app to screenshot after a build, which screens to
// open with launch arguments, and a web URL for projects that are pages.
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
//     }
//   }
import fs from "node:fs";
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
}

interface Cached {
  mtimeMs: number;
  config: ProjectConfig;
}

const cache = new Map<string, Cached>();
const EMPTY: ProjectConfig = { preview: null };

export function projectConfig(cwd: string): ProjectConfig {
  const file = path.join(cwd, PROJECT_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(cwd);
    return EMPTY;
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
  const p = (raw as { preview?: unknown }).preview;
  if (p === undefined || p === null) return { preview: null };
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

/** What the phone needs to know about a project's preview, in a session row. */
export function previewSummary(cwd: string): { web: string | null; screens: string[] } | null {
  const p = projectConfig(cwd).preview;
  if (!p) return null;
  return { web: p.web, screens: p.app ? p.screens.map((s) => s.name) : [] };
}
