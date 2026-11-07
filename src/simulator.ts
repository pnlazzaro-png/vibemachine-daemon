// The simulator, through `xcrun simctl`: find and boot the device, install
// and launch an app with launch arguments, and screenshot it.
//
// The iPhone Duo simulator has several display ports and `simctl io
// screenshot` defaults to the cover screen, which is off (all black) while
// the phone is unfolded. So the first capture on a device probes every
// Display port with a quick BMP shot and keeps the one that shows pixels;
// that port is remembered until it goes black again.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
}

export interface SimCommandOptions {
  timeoutMs?: number;
}

async function simctl(args: string[], opts: SimCommandOptions = {}): Promise<string> {
  const { stdout } = await run("xcrun", ["simctl", ...args], { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Find a device by name or UDID among the available ones; booted first. */
export async function findDevice(nameOrUdid: string): Promise<SimDevice | null> {
  const json = JSON.parse(await simctl(["list", "devices", "available", "-j"])) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
  const all = Object.values(json.devices).flat();
  const matches = all.filter((d) => d.udid === nameOrUdid || d.name === nameOrUdid);
  matches.sort((a, b) => Number(b.state === "Booted") - Number(a.state === "Booted"));
  const d = matches[0];
  return d ? { udid: d.udid, name: d.name, state: d.state } : null;
}

export async function ensureBooted(device: SimDevice): Promise<void> {
  if (device.state === "Booted") return;
  await simctl(["boot", device.udid]).catch((err: Error) => {
    if (!/current state: Booted/i.test(err.message)) throw err;
  });
  await simctl(["bootstatus", device.udid, "-b"], { timeoutMs: 180_000 });
  device.state = "Booted";
}

export async function isInstalled(udid: string, bundleId: string): Promise<boolean> {
  try {
    await simctl(["get_app_container", udid, bundleId]);
    return true;
  } catch {
    return false;
  }
}

export async function install(udid: string, appPath: string): Promise<void> {
  await simctl(["install", udid, appPath], { timeoutMs: 120_000 });
}

export async function launch(udid: string, bundleId: string, args: string[]): Promise<void> {
  await simctl(["launch", "--terminate-running-process", udid, bundleId, ...args], { timeoutMs: 60_000 });
}

export async function terminate(udid: string, bundleId: string): Promise<void> {
  await simctl(["terminate", udid, bundleId]).catch(() => undefined);
}

// Displays

export interface DisplayPort {
  port: string;
  /** 0 for the phone's own screens; others are external (TV out, CarPlay). */
  displayClass: number;
  width: number;
  height: number;
}

/** Every Display port, in the order simctl lists them. */
export function parseDisplays(text: string): DisplayPort[] {
  const out: DisplayPort[] = [];
  for (const block of text.split(/\n(?=Port:)/)) {
    if (!/^\s*Class:\s*Display\s*$/m.test(block)) continue;
    const uuid = /UUID:\s*([0-9A-Fa-f-]{36})/.exec(block)?.[1];
    if (!uuid) continue;
    const num = (re: RegExp) => Number(re.exec(block)?.[1] ?? NaN);
    out.push({ port: uuid, displayClass: num(/Display class:\s*(\d+)/), width: num(/Default width:\s*(\d+)/), height: num(/Default height:\s*(\d+)/) });
  }
  return out;
}

export async function displays(udid: string): Promise<DisplayPort[]> {
  return parseDisplays(await simctl(["io", udid, "enumerate"]));
}

/** Every Display port's UUID, in the order simctl lists them. */
export async function displayPorts(udid: string): Promise<string[]> {
  return (await displays(udid)).map((d) => d.port);
}

/**
 * Which of the phone's own screens a port is: the largest is the inner one
 * (unfolded), any other the cover (folded). A phone that doesn't fold has only
 * an inner screen.
 */
export function displayKind(port: string, all: DisplayPort[]): "inner" | "cover" {
  const own = all.filter((d) => d.displayClass === 0);
  const inner = own.reduce<DisplayPort | null>((a, d) => (!a || d.width * d.height > a.width * a.height ? d : a), null);
  return !inner || inner.port === port ? "inner" : "cover";
}

/** A 24/32-bit BMP's size, and whether any pixel in it is not black. */
export function bmpInfo(file: string): { width: number; height: number; hasPixels: boolean } {
  const buf = fs.readFileSync(file);
  if (buf.length < 54 || buf.toString("ascii", 0, 2) !== "BM") return { width: 0, height: 0, hasPixels: false };
  const offset = buf.readUInt32LE(10);
  const width = Math.abs(buf.readInt32LE(18));
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  const stride = bpp === 32 ? 4 : bpp === 24 ? 3 : 1;
  for (let i = offset; i + stride <= buf.length; i += stride) {
    // B, G, R; the alpha byte of a 32-bit pixel is skipped.
    if (buf[i] || buf[i + 1] || buf[i + 2]) return { width, height, hasPixels: true };
  }
  return { width, height, hasPixels: false };
}

export function bmpHasPixels(file: string): boolean {
  return bmpInfo(file).hasPixels;
}

const liveDisplay = new Map<string, string>();

/** Pixels of the display, or 0 when it is off, missing, or slow (an off port never answers). */
async function probeDisplay(udid: string, port: string, scratch: string): Promise<number> {
  try {
    await simctl(["io", udid, "screenshot", "--type=bmp", `--display=${port}`, scratch], { timeoutMs: 10_000 });
    const info = bmpInfo(scratch);
    return info.hasPixels ? info.width * info.height : 0;
  } catch {
    return 0;
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

/**
 * The display port to shoot: the largest one showing pixels (unfolded, the
 * inner screen; folded, the cover), probed all at once since an off port
 * only times out. Remembered until it stops answering.
 */
export async function activeDisplay(udid: string, scratchDir: string): Promise<string> {
  const known = liveDisplay.get(udid);
  if (known) return known;
  fs.mkdirSync(scratchDir, { recursive: true });
  // A simulator that is restarting (its ports change) or waking shows nothing for a few seconds.
  for (let round = 0; round < PROBE_ROUNDS; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, PROBE_PAUSE_MS));
    const ports = await displayPorts(udid);
    const sizes = await Promise.all(ports.map((p, i) => probeDisplay(udid, p, `${scratchDir}/probe-${process.pid}-${i}.bmp`)));
    let best = -1;
    for (let i = 0; i < ports.length; i++) if (sizes[i]! > (best < 0 ? 0 : sizes[best]!)) best = i;
    if (best < 0) continue;
    const port = ports[best]!;
    liveDisplay.set(udid, port);
    return port;
  }
  throw new Error("no simulator display is showing anything (is the device booted?)");
}

/**
 * Which screen the simulator is showing now, inner (unfolded) or cover (folded). The
 * remembered port is checked first: it goes black when the phone folds or unfolds.
 */
export async function activeDisplayKind(udid: string, scratchDir: string): Promise<"inner" | "cover"> {
  const known = liveDisplay.get(udid);
  if (known && (await probeDisplay(udid, known, `${scratchDir}/kind-${process.pid}.bmp`)) === 0) liveDisplay.delete(udid);
  const port = await activeDisplay(udid, scratchDir);
  return displayKind(port, await displays(udid));
}

const PROBE_ROUNDS = 3;
const PROBE_PAUSE_MS = 5_000;

/**
 * Screenshot the active display to a PNG. When the remembered port has gone
 * black (the phone was folded) or away (the port UUIDs change on every
 * boot), probe again once.
 */
export async function screenshot(udid: string, file: string, scratchDir: string): Promise<void> {
  let lastError = "the simulator display went black";
  for (let attempt = 0; attempt < 2; attempt++) {
    const port = await activeDisplay(udid, scratchDir);
    const probe = `${scratchDir}/shot-${process.pid}.bmp`;
    try {
      await simctl(["io", udid, "screenshot", "--type=bmp", `--display=${port}`, probe], { timeoutMs: 30_000 });
      if (bmpHasPixels(probe)) {
        await run("sips", ["-s", "format", "png", probe, "--out", file], { timeout: 60_000 });
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      fs.rmSync(probe, { force: true });
    }
    liveDisplay.delete(udid);
  }
  throw new Error(lastError);
}

/** Screenshot one display by its name (devicectl's, e.g. "LCD-1") to a PNG; throws if it comes back black. */
export async function screenshotDisplay(udid: string, display: string, file: string, scratchDir: string): Promise<void> {
  const probe = `${scratchDir}/named-${process.pid}.bmp`;
  try {
    await simctl(["io", udid, "screenshot", "--type=bmp", `--display=${display}`, probe], { timeoutMs: 30_000 });
    if (!bmpHasPixels(probe)) throw new Error(`the ${display} display came back black`);
    await run("sips", ["-s", "format", "png", probe, "--out", file], { timeout: 60_000 });
  } finally {
    fs.rmSync(probe, { force: true });
  }
}

/** Shrink a PNG in place so its longer side is at most `max` pixels. */
export async function shrinkPng(file: string, max: number): Promise<void> {
  await run("sips", ["--resampleHeightWidthMax", String(max), file, "--out", file], { timeout: 60_000 });
}

export function pngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Freeze the status bar (9:41, full battery and Wi-Fi), so a screen whose code didn't change shoots
 * the same twice instead of differing by the clock. Older runtimes may refuse; the comparison leaves
 * the bar out anyway.
 */
export async function freezeStatusBar(udid: string): Promise<void> {
  try {
    await simctl(["status_bar", udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100", "--wifiBars", "3", "--dataNetwork", "wifi"], { timeoutMs: 15_000 });
  } catch {
    /* not supported here */
  }
}

/**
 * Where two shots of a screen differ, as boxes in fractions of the picture (0 to 1 from the top
 * left), biggest first; none when they show the same. Both are shrunk to COMPARE_SIDE square in
 * grayscale, fine enough that a badge appearing in a status line is seen (the 96-square fingerprint
 * needed some thirty cells to differ, a badge is about twelve). The status corners are left out:
 * the clock and battery on the Duo's top right (deeper on the inner screen sideways), a plain
 * iPhone's clock top left. A difference counts when a patch of it holds MIN_CHANGE pixels; patches
 * close together are one box.
 */
export const COMPARE_SIDE = 256;
const COMPARE_CELL = 4;
const MIN_CHANGE = 6;
export const FAR = 24;
export interface ChangeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function compareShots(a: string, b: string, scratch: string): Promise<ChangeBox[]> {
  const shrink = async (file: string, out: string) => {
    await run("sips", ["-s", "format", "bmp", "--resampleHeightWidth", String(COMPARE_SIDE), String(COMPARE_SIDE), file, "--out", out], { timeout: 60_000 });
    try {
      return bmpGray(fs.readFileSync(out));
    } finally {
      fs.rmSync(out, { force: true });
    }
  };
  const [pa, pb] = await Promise.all([shrink(a, `${scratch}-a.bmp`), shrink(b, `${scratch}-b.bmp`)]);
  const { width, height } = pngSize(a);
  return changedBoxes(pa, pb, COMPARE_SIDE, width > height);
}

/** The status corners, in fractions: left out of the comparison. */
export function statusCorner(x: number, y: number, wide: boolean): boolean {
  if (wide ? x >= 0.88 && y <= 0.16 : x >= 0.78 && y <= 0.12) return true;
  return x <= 0.25 && y <= 0.06;
}

export function changedBoxes(a: Uint8Array, b: Uint8Array, side: number, wide: boolean): ChangeBox[] {
  if (a.length !== b.length || a.length !== side * side) return [{ x: 0, y: 0, w: 1, h: 1 }];
  // Far pixels counted per cell, outside the status corners.
  const cells = side / COMPARE_CELL;
  const count = new Uint16Array(cells * cells);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      if (Math.abs(a[i]! - b[i]!) <= FAR || statusCorner(x / side, y / side, wide)) continue;
      count[Math.floor(y / COMPARE_CELL) * cells + Math.floor(x / COMPARE_CELL)]!++;
    }
  }
  // Patches: cells with any far pixel, joined to others within two cells.
  const seen = new Uint8Array(cells * cells);
  const boxes: (ChangeBox & { n: number })[] = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    let n = 0, x0 = cells, y0 = cells, x1 = -1, y1 = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cells, cy = Math.floor(c / cells);
      n += count[c]!;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) continue;
          const k = ny * cells + nx;
          if (count[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
        }
      }
    }
    if (n < MIN_CHANGE) continue;
    boxes.push({ x: x0 / cells, y: y0 / cells, w: (x1 - x0 + 1) / cells, h: (y1 - y0 + 1) / cells, n });
  }
  return boxes.sort((p, q) => q.w * q.h - p.w * p.h).slice(0, 4).map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** A 24/32-bit BMP as grayscale bytes, top row first. */
export function bmpGray(buf: Buffer): Uint8Array {
  if (buf.length < 54 || buf.toString("ascii", 0, 2) !== "BM") throw new Error("not a BMP");
  const offset = buf.readUInt32LE(10);
  const width = Math.abs(buf.readInt32LE(18));
  const rawHeight = buf.readInt32LE(22);
  const height = Math.abs(rawHeight);
  const bytes = buf.readUInt16LE(28) / 8;
  const stride = Math.ceil((width * bytes) / 4) * 4;
  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    // A positive height is stored bottom row first.
    const src = offset + (rawHeight > 0 ? height - 1 - row : row) * stride;
    for (let x = 0; x < width; x++) {
      const i = src + x * bytes;
      out[row * width + x] = Math.round(0.114 * buf[i]! + 0.587 * buf[i + 1]! + 0.299 * buf[i + 2]!);
    }
  }
  return out;
}


/** A recording under way: stop it (SIGINT, as simctl asks) and wait for the file to be finished. */
export interface Recording {
  stop(): Promise<boolean>;
}

/**
 * Record a display (by devicectl's name, or the default one) to `file`. Resolves once simctl says
 * the first frame is in, so what follows is on the clip; null if it never starts.
 */
export function startRecording(udid: string, display: string | undefined, file: string, startMs = 6000): Promise<Recording | null> {
  return new Promise((resolve) => {
    const args = ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", ...(display ? [`--display=${display}`] : []), file];
    const child = spawn("xcrun", args, { stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    const done = new Promise<boolean>((r) => child.on("exit", (code, signal) => r(code === 0 || signal === "SIGINT")));
    const recording: Recording = {
      async stop() {
        child.kill("SIGINT");
        const timeout = new Promise<boolean>((r) => setTimeout(() => (child.kill("SIGKILL"), r(false)), 15_000));
        return (await Promise.race([done, timeout])) && fs.existsSync(file);
      },
    };
    const give = (r: Recording | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      if (/Recording started/i.test(text)) give(recording);
    });
    child.on("error", () => give(null));
    child.on("exit", () => give(null));
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        give(null);
      }
    }, startMs);
  });
}

/** A recorded clip made phone-sized (960×540 at most, H.264) with macOS's own avconvert. */
export async function shrinkClip(source: string, out: string): Promise<void> {
  await run("avconvert", ["--source", source, "--preset", "Preset960x540", "--output", out, "--replace"], { timeout: 120_000 });
}
