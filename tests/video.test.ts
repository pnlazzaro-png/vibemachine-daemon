// A video from the phone: how its frames are chosen and laid out, the sheets ffmpeg makes (when
// it's installed), and what Claude is sent with them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_ATTACHMENT_BYTES, parseAttachments, promptContent, saveAttachments } from "../src/attachments.js";
import { Store } from "../src/db.js";
import { derivedPaths, ffmpegAvailable, frameSheets, frameTimes, framesNote, layout, MAX_FRAMES, poster, SHEET_WIDTH } from "../src/video.js";

test("frames: two a second, at most MAX_FRAMES, from the first moment", () => {
  assert.deepEqual(frameTimes(3).times, [0, 0.5, 1, 1.5, 2, 2.5]);
  const long = frameTimes(120);
  assert.equal(long.times.length, MAX_FRAMES);
  assert.equal(long.times[1], 5);
  assert.deepEqual(frameTimes(0.2).times, [0]);
});

test("sheets: an upright video four across, a wide one two by two, no wider than the model sees", () => {
  const upright = layout({ duration: 1, width: 1206, height: 2622 });
  assert.deepEqual([upright.columns, upright.rows], [4, 1]);
  const wide = layout({ duration: 1, width: 1920, height: 1080 });
  assert.deepEqual([wide.columns, wide.rows], [2, 2]);
  for (const l of [upright, wide]) assert.ok(l.columns * l.tileWidth + 8 * (l.columns + 1) <= SHEET_WIDTH);
});

test("a video may be bigger than other files, up to its own limit", () => {
  const big = "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 1024) * 4) / 3));
  assert.throws(() => parseAttachments([{ name: "a.pdf", media_type: "application/pdf", data: big }]), /over 25 MB/);
  assert.equal(parseAttachments([{ name: "a.mov", media_type: "video/quicktime", data: big }]).length, 1);
});

test("without frames the trailer says why", () => {
  assert.match(framesNote(null), /No frames/);
});

test("ffmpeg lays a recording's frames out on sheets; they go with the prompt, the times in the trailer", { skip: !ffmpegAvailable() && "ffmpeg isn't installed" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-video-"));
  const clip = path.join(dir, "rec.mp4");
  // Three seconds, upright like a phone's screen recording.
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x780:rate=30", "-t", "3", "-pix_fmt", "yuv420p", clip]);
  const frames = await frameSheets(clip);
  assert.ok(frames);
  assert.equal(Math.round(frames.info.duration), 3);
  assert.equal(frames.sheets.length, 2, "six frames, four to a sheet");
  assert.deepEqual(frames.sheets.map((s) => s.times), [[0, 0.5, 1, 1.5], [2, 2.5]]);
  for (const s of frames.sheets) assert.ok(fs.statSync(s.path).size > 0);
  assert.ok(await poster(clip));

  const store = new Store(":memory:");
  const [saved] = saveAttachments(store, "s1", 1, [{ name: "rec.mp4", media_type: "video/mp4", data: fs.readFileSync(clip).toString("base64") }]);
  const content = promptContent("What's wrong with this animation?", [saved!], new Map([[saved!.row.id, frames]])) as { type: string; text?: string; source?: { media_type: string } }[];
  assert.equal(content[0]!.text, "What's wrong with this animation?");
  assert.deepEqual(content.filter((b) => b.type === "image").map((b) => b.source!.media_type), ["image/jpeg", "image/jpeg"]);
  const note = content.at(-1)!.text!;
  assert.match(note, /rec\.mp4 \(video\/mp4/);
  assert.match(note, /2 sheets of frames/);
  assert.match(note, /sheet 2: 2\.0s, 2\.5s/);
  for (const p of [saved!.row.path, ...derivedPaths(saved!.row.path)]) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
