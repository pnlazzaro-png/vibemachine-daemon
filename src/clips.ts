// A screen's clip. The simulator records from before the launch to the shot, so the file opens
// on whatever was on screen, then the launch screen, then the app. The phone gets it only when
// the app itself moves once it is up (an animation the turn touched), cut to start where the app
// arrives; one that just sits there is thrown away (2026-10-31: the clips kept showing the
// Home Screen and a launch, with nothing to see). The frames are read with ffmpeg; without it the
// clip is kept whole, as before.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { changedBoxes, COMPARE_SIDE, FAR, shrinkClip } from "./simulator.js";
import { probe, tool } from "./video.js";

const exec = promisify(execFile);

/** Frames read a second: enough to see a half-second animation as a few differing pairs. */
export const SAMPLE_FPS = 4;
/**
 * A launch screen: nearly every pixel within FAR of the frame's middle shade. On the Duo's
 * recordings the launch screen (paper, a clock, the camera's cutout) comes to 0.99; the app's own
 * screens, the sparsest of them, to 0.66–0.78 (measured 2026-10-31).
 */
const FLAT_SHARE = 0.97;
/** After the app arrives it zooms in for a moment; that much isn't the app's own motion. */
const ARRIVAL_SECONDS = 0.5;
/** Differing frame pairs after that, for the clip to be worth keeping. */
const MIN_MOVING_PAIRS = 2;
/** The clip starts this long before the app arrives, so it is seen to arrive. */
const LEAD_SECONDS = 0.25;
/** The phone's copy: at most this wide. */
const CLIP_MAX_WIDTH = 960;
const FFMPEG_TIMEOUT_MS = 120_000;

export interface ClipVerdict {
  /** The app moves once it is up. */
  keep: boolean;
  /** Where the app arrives, in seconds from the recording's start. */
  from: number;
}

/** Nearly one shade all over: the launch screen (or a display that is off). */
export function isFlat(frame: Uint8Array): boolean {
  const histogram = new Uint32Array(256);
  for (const v of frame) histogram[v]!++;
  let seen = 0;
  let median = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= frame.length / 2) {
      median = v;
      break;
    }
  }
  let near = 0;
  for (let v = Math.max(0, median - FAR); v <= Math.min(255, median + FAR); v++) near += histogram[v]!;
  return near >= frame.length * FLAT_SHARE;
}

/**
 * What the frames show: the app arrives after the last launch-screen frame (or, with no launch
 * screen on the recording, after the first change that remade the whole picture; else at the
 * start), and the clip is kept when frames still differ after its arrival and zoom.
 */
export function judgeFrames(frames: Uint8Array[], wide: boolean, fps = SAMPLE_FPS): ClipVerdict {
  if (frames.length < 2) return { keep: false, from: 0 };
  const pairs = frames.slice(1).map((frame, i) => changedBoxes(frames[i]!, frame, COMPARE_SIDE, wide));
  let arrival = frames.findLastIndex(isFlat);
  if (arrival < 0) {
    const whole = pairs.findIndex((boxes) => boxes.reduce((area, b) => area + b.w * b.h, 0) >= 0.5);
    arrival = whole < 0 ? 0 : whole + 1;
  }
  const settled = arrival + Math.ceil(ARRIVAL_SECONDS * fps);
  let moving = 0;
  for (let i = settled; i < pairs.length; i++) if (pairs[i]!.length > 0) moving++;
  return { keep: moving >= MIN_MOVING_PAIRS, from: Math.max(0, arrival / fps - LEAD_SECONDS) };
}

/** The recording's frames, COMPARE_SIDE square in gray, SAMPLE_FPS a second. */
async function readFrames(ffmpeg: string, file: string): Promise<Uint8Array[]> {
  const { stdout } = await exec(ffmpeg, ["-v", "error", "-i", file, "-an", "-vf", `fps=${SAMPLE_FPS},scale=${COMPARE_SIDE}:${COMPARE_SIDE},format=gray`, "-f", "rawvideo", "pipe:1"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
    timeout: FFMPEG_TIMEOUT_MS,
  });
  const size = COMPARE_SIDE * COMPARE_SIDE;
  const frames: Uint8Array[] = [];
  for (let at = 0; at + size <= stdout.length; at += size) frames.push(new Uint8Array(stdout.buffer, stdout.byteOffset + at, size));
  return frames;
}

/**
 * The raw recording judged and, if kept, cut and shrunk into `out` for the phone. Whether a clip
 * is there for the phone afterwards. Without ffmpeg the whole recording is shrunk, as before.
 */
export async function finishClip(raw: string, out: string): Promise<{ kept: boolean; why?: string }> {
  const ffmpeg = tool("ffmpeg");
  const info = ffmpeg ? await probe(raw) : null;
  if (!ffmpeg || !info) {
    await shrinkClip(raw, out);
    return { kept: true, why: ffmpeg ? "ffmpeg couldn't read it; kept whole" : "no ffmpeg; kept whole" };
  }
  const verdict = judgeFrames(await readFrames(ffmpeg, raw), info.width > info.height);
  if (!verdict.keep) {
    fs.rmSync(out, { force: true });
    return { kept: false, why: "nothing moves once the app is up" };
  }
  await exec(ffmpeg, [
    "-v", "error", "-y", "-ss", verdict.from.toFixed(2), "-i", raw, "-an",
    "-vf", `scale='min(${CLIP_MAX_WIDTH},iw)':-2`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    out,
  ], { timeout: FFMPEG_TIMEOUT_MS });
  return { kept: true };
}
