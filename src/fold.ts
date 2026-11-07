// Posing a foldable simulator (the iPhone Duo) for the preview's screenshots, so each screen is shot
// in the view it names: folded, unfolded, book or desk, for real, not faked with launch arguments.
//
// Xcode has no command for this (Xcode 27.1: nothing in simctl, devicectl or XCTest). Device Hub
// folds the simulator by posting a vendor HID event inside it; native/vm-hinge.m posts the same one,
// built here for the simulator on first use, and confirms the angle from CoreMotion. It's a private
// interface, so every move is checked: when one doesn't land, the round says so and falls back.
// Which screen is lit comes from Apple's own `devicectl device info displays`.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config, daemonRoot, toolPath } from "./config.js";

const run = promisify(execFile);

/** The six views of the Duo (CLAUDE.md's names), as a hinge angle and a device orientation. */
export const VIEWS = {
  unfolded: { angle: 180, orientation: "portrait" },
  "unfolded portrait": { angle: 180, orientation: "landscape-left" },
  folded: { angle: 0, orientation: "portrait" },
  "folded landscape": { angle: 0, orientation: "landscape-left" },
  book: { angle: 90, orientation: "portrait" },
  desk: { angle: 90, orientation: "landscape-left" },
} as const;
export type View = keyof typeof VIEWS;
export type Orientation = "portrait" | "landscape-left" | "landscape-right" | "pud";

export function isView(v: unknown): v is View {
  return typeof v === "string" && v in VIEWS;
}

/** A pose: where the hinge and the device are. */
export interface Pose {
  angle: number;
  orientation: Orientation;
}

export function poseOf(view: View): Pose {
  return { ...VIEWS[view] };
}

/** The order a round visits the views: open ones, then half open (reached from open), then closed. */
const ROUND_ORDER: View[] = ["unfolded", "unfolded portrait", "book", "desk", "folded", "folded landscape"];

/** Screens grouped by the pose they need, unposed ones first (shot as the simulator stands), then in ROUND_ORDER, so a round moves the hinge as little as it can. */
export function groupByPose<T extends { view?: View }>(screens: T[]): { pose: Pose | null; screens: T[] }[] {
  const groups = new Map<string, { pose: Pose | null; screens: T[] }>();
  const order = ROUND_ORDER.map((v) => `${VIEWS[v].angle}/${VIEWS[v].orientation}`);
  for (const screen of screens) {
    const pose = screen.view ? poseOf(screen.view) : null;
    const key = pose ? `${pose.angle}/${pose.orientation}` : "";
    const group = groups.get(key) ?? { pose, screens: [] };
    group.screens.push(screen);
    groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : order.indexOf(a) - order.indexOf(b))).map(([, g]) => g);
}

// ---------------------------------------------------------------- the helper

const SOURCE = path.join(daemonRoot, "native", "vm-hinge.m");

async function developerDir(): Promise<string> {
  try {
    const { stdout } = await run("xcode-select", ["-p"], { env: { ...process.env, PATH: toolPath } });
    return process.env.DEVELOPER_DIR?.trim() || stdout.trim();
  } catch {
    return process.env.DEVELOPER_DIR?.trim() || "";
  }
}

let built: Promise<string | null> | null = null;

/** The helper, built for the simulator from native/vm-hinge.m and kept per source and Xcode; null if it can't be built. */
export function helper(): Promise<string | null> {
  built ??= (async () => {
    try {
      const xcode = await developerDir();
      const source = fs.readFileSync(SOURCE);
      const hash = createHash("sha256").update(source).update(xcode).digest("hex").slice(0, 12);
      const dir = path.join(config.dataDir, "bin");
      const bin = path.join(dir, `vm-hinge-${hash}`);
      if (fs.existsSync(bin)) return bin;
      fs.mkdirSync(dir, { recursive: true });
      for (const old of fs.readdirSync(dir)) if (old.startsWith("vm-hinge-")) fs.rmSync(path.join(dir, old), { force: true });
      const env = { ...process.env, PATH: toolPath, ...(xcode ? { DEVELOPER_DIR: xcode } : {}) };
      await run("xcrun", ["-sdk", "iphonesimulator", "clang", "-arch", "arm64", "-mios-simulator-version-min=26.0", "-O2", "-fobjc-arc",
        "-o", `${bin}.tmp`, SOURCE, "-framework", "IOKit", "-framework", "CoreFoundation", "-framework", "Foundation", "-framework", "CoreMotion"], { env, timeout: 120_000 });
      await run("codesign", ["-f", "-s", "-", `${bin}.tmp`], { env, timeout: 30_000 });
      fs.renameSync(`${bin}.tmp`, bin);
      return bin;
    } catch (err) {
      console.error("fold: couldn't build the hinge helper:", err instanceof Error ? err.message : err);
      built = null;
      return null;
    }
  })();
  return built;
}

async function spawnHelper(udid: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; out: string }> {
  const bin = await helper();
  if (!bin) return { ok: false, out: "no helper" };
  try {
    const { stdout } = await run("xcrun", ["simctl", "spawn", udid, bin, ...args], { env: { ...process.env, PATH: toolPath }, timeout: timeoutMs });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

/** The hinge's angle, or null when the simulator has none (not a foldable) or the helper can't run. */
export async function hingeAngle(udid: string): Promise<number | null> {
  const r = await spawnHelper(udid, ["get"]);
  const n = Number(r.out);
  return r.ok && r.out !== "" && Number.isFinite(n) ? n : null;
}

async function devicectl(args: string[], timeoutMs = 20_000): Promise<unknown> {
  const { stdout } = await run("xcrun", ["devicectl", ...args, "-q", "-j", "-"], { env: { ...process.env, PATH: toolPath }, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return (JSON.parse(stdout) as { result: unknown }).result;
}

const DEVICECTL_NAMES: Record<Orientation, string> = { portrait: "portrait", "landscape-left": "landscapeLeft", "landscape-right": "landscapeRight", pud: "portraitUpsideDown" };

export async function orientation(udid: string): Promise<Orientation | null> {
  try {
    const r = (await devicectl(["device", "orientation", "get", "-d", udid])) as { deviceOrientationNonFlat?: string };
    const found = Object.entries(DEVICECTL_NAMES).find(([, name]) => name === r.deviceOrientationNonFlat);
    return found ? (found[0] as Orientation) : null;
  } catch {
    return null;
  }
}

/** A display as devicectl lists it: the integrated ones only. */
export interface Display {
  name: string;
  active: boolean;
  backlight: string;
  area: number;
}

export function parseDisplays(result: unknown): Display[] {
  const list = (result as { displays?: Record<string, unknown>[] } | undefined)?.displays ?? [];
  return list
    .filter((d) => d && typeof d === "object" && d.type && typeof d.type === "object" && "integrated" in (d.type as object))
    .map((d) => {
      const size = Array.isArray(d.nativeSize) ? (d.nativeSize as number[]) : [0, 0];
      const backlight = typeof d.backlightState === "string" ? d.backlightState : "unknown";
      // Some runtimes omit "active"; a lit backlight stands in for it then.
      const active = typeof d.active === "boolean" ? d.active : backlight !== "off" && backlight !== "unknown";
      return { name: String(d.name), active, backlight, area: (size[0] ?? 0) * (size[1] ?? 0) };
    });
}

export async function displays(udid: string): Promise<Display[]> {
  return parseDisplays(await devicectl(["device", "info", "displays", "-d", udid]));
}

/** The display showing the app once it has settled: the cover (the smaller panel) when closed, the inner otherwise, with its backlight on. */
export async function litDisplay(udid: string, closed: boolean, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let list: Display[] = [];
    try {
      list = await displays(udid);
    } catch {
      list = [];
    }
    const panels = [...list].sort((a, b) => a.area - b.area);
    const want = closed ? panels[0] : panels.at(-1);
    if (want && want.active && want.backlight !== "off") return want.name;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Move the simulator to `pose` and wait for the right screen to light; false if the hinge or the screen didn't follow. */
export async function setPose(udid: string, pose: Pose): Promise<boolean> {
  // Half open is reached from open, as a hand does it: straight up from closed, the simulator keeps
  // the cover screen lit at 90°.
  if (pose.angle > 0 && pose.angle < 180) {
    const now = await hingeAngle(udid);
    if (now !== null && now < pose.angle && !(await spawnHelper(udid, ["set", "180", "4"])).ok) return false;
  }
  const moved = await spawnHelper(udid, ["set", String(pose.angle), "4"]);
  if (!moved.ok) return false;
  if ((await orientation(udid)) !== pose.orientation) {
    await spawnHelper(udid, ["orient", pose.orientation]);
    for (let i = 0; i < 12 && (await orientation(udid)) !== pose.orientation; i++) await new Promise((r) => setTimeout(r, 250));
    if ((await orientation(udid)) !== pose.orientation) return false;
  }
  return (await litDisplay(udid, pose.angle === 0)) !== null;
}

/** Where the simulator is now, to put it back after a round. */
export async function currentPose(udid: string): Promise<Pose | null> {
  const angle = await hingeAngle(udid);
  if (angle === null) return null;
  return { angle, orientation: (await orientation(udid)) ?? "portrait" };
}
