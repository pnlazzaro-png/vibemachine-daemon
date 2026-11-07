import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { finishClip, isFlat, judgeFrames, SAMPLE_FPS } from "../src/clips.js";
import { COMPARE_SIDE } from "../src/simulator.js";
import { tool } from "../src/video.js";

const side = COMPARE_SIDE;
/** A busy picture, like an app on screen. */
const app = (seed: number) => new Uint8Array(side * side).map((_, i) => (i * 37 + seed * 97) % 256);
/** The launch screen: paper, with a clock in the corner. */
const paper = () => new Uint8Array(side * side).map((_, i) => (i % side > 230 && i < side * 20 ? 30 : 240));
/** `frame` with a block moved by `shift` pixels along a row. */
const moved = (frame: Uint8Array, shift: number) => {
  const out = frame.slice();
  for (let r = 120; r < 150; r++) for (let c = 40 + shift; c < 70 + shift; c++) out[r * side + c] = (out[r * side + c]! + 90) % 256;
  return out;
};
const repeat = (frame: Uint8Array, n: number) => Array.from({ length: n }, () => frame);

test("clips: the launch screen is flat, an app isn't", () => {
  assert.ok(isFlat(paper()));
  assert.ok(!isFlat(app(1)));
});

test("clips: an app that sits still after launching is dropped; one that moves is kept from where it arrives", () => {
  const before = app(1);
  const after = app(2);
  // The old app for a second, paper for a second and a half, the new app still for two seconds.
  const still = [...repeat(before, 4), ...repeat(paper(), 6), ...repeat(after, 8)];
  const v = judgeFrames(still, false);
  assert.equal(v.keep, false);
  // The clip would start a quarter second before the last paper frame (frame 9 at 2.25 s).
  assert.equal(v.from, 9 / SAMPLE_FPS - 0.25);
  // The same, but a block slides across the new app for a second after its arrival settles.
  const moving = [...repeat(before, 4), ...repeat(paper(), 6), after, after, ...[0, 10, 20, 30, 40].map((s) => moved(after, s)), moved(after, 40)];
  assert.equal(judgeFrames(moving, false).keep, true);
  // Motion only in the arrival's half second is the launch zoom, not the app.
  const zoomOnly = [...repeat(before, 4), ...repeat(paper(), 6), moved(after, 0), moved(after, 20), ...repeat(after, 6)];
  assert.equal(judgeFrames(zoomOnly, false).keep, false);
});

test("clips: with no launch screen on the recording, the app arrives at the first whole-picture change", () => {
  const before = app(1);
  const after = app(2);
  const frames = [...repeat(before, 4), after, after, after, ...[0, 10, 20, 30].map((s) => moved(after, s))];
  const v = judgeFrames(frames, true);
  assert.equal(v.keep, true);
  assert.equal(v.from, 4 / SAMPLE_FPS - 0.25);
  assert.equal(judgeFrames([...repeat(before, 4), ...repeat(after, 8)], true).keep, false);
  assert.deepEqual(judgeFrames([after], true), { keep: false, from: 0 });
});

test("clips: a recording is judged, cut and shrunk with ffmpeg", { skip: !tool("ffmpeg") || !tool("ffprobe") }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-clips-"));
  const ffmpeg = tool("ffmpeg")!;
  // The old app (a test pattern), paper, then the new app: a plain screen with a block that slides, or sits.
  const make = (file: string, motion: boolean) =>
    execFileSync(ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=s=320x568:r=10:d=1",
      "-f", "lavfi", "-i", "color=c=0xF4EDE1:s=320x568:r=10:d=1.5",
      "-f", "lavfi", "-i", "color=c=0xF4EDE1:s=320x568:r=10:d=2.5",
      "-f", "lavfi", "-i", "color=c=red:s=60x60:r=10:d=2.5",
      // The new app has a dark masthead over a third of it (a launch screen is paper all over), and a block that slides, or sits.
      "-filter_complex",
      `[2:v]drawbox=x=0:y=0:w=320:h=200:c=0x221E1A:t=fill[bg];[bg][3:v]overlay=x='${motion ? "40+80*t" : "40"}':y=300:shortest=1[app];[0:v][1:v][app]concat=n=3:v=1:a=0,format=yuv420p[v]`,
      "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", file,
    ]);
  const still = path.join(dir, "still.mp4");
  const moving = path.join(dir, "moving.mp4");
  make(still, false);
  make(moving, true);
  const stillOut = path.join(dir, "still-out.mp4");
  assert.equal((await finishClip(still, stillOut)).kept, false);
  assert.ok(!fs.existsSync(stillOut));
  const movingOut = path.join(dir, "moving-out.mp4");
  assert.equal((await finishClip(moving, movingOut)).kept, true);
  assert.ok(fs.existsSync(movingOut));
  // Cut to the app's arrival: about the last 2.75 s of the 5, not the whole recording.
  const duration = Number(execFileSync(tool("ffprobe")!, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", movingOut]).toString());
  assert.ok(duration > 2 && duration < 3.5, `cut to ${duration}s`);
  fs.rmSync(dir, { recursive: true, force: true });
});
