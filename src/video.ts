// A video sent from the phone (a screen recording, mostly) can't be shown to Claude as it is: the
// model takes pictures, not motion. So the Mac lays its frames out on sheets, a few to a sheet, at
// up to two a second, and the sheets go with the prompt as images, the trailer saying when each
// frame was taken. A poster frame is the phone's thumbnail for it in the stream. Both need ffmpeg
// (Homebrew's); without it the video still goes, by its path, and the trailer says why there are
// no frames. Everything made from a video sits beside it: `<file>.frames/`, `<file>.poster.jpg`.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { toolPath } from "./config.js";

const exec = promisify(execFile);

/** At most this many frames, however long the video: two a second, or fewer for a long one. */
export const MAX_FRAMES = 24;
export const FRAMES_PER_SECOND = 2;
/** A sheet as wide as the model sees an image at all (it scales anything bigger down to this). */
export const SHEET_WIDTH = 1568;
const GAP = 8;
const FFMPEG_TIMEOUT_MS = 90_000;

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
}

export interface FrameSheet {
  path: string;
  /** When each frame on it was taken, in seconds, in reading order (left to right, then down). */
  times: number[];
}

export interface VideoFrames {
  info: VideoInfo;
  sheets: FrameSheet[];
}

export function isVideo(mediaType: string): boolean {
  return mediaType.startsWith("video/");
}

export function tool(name: string): string | null {
  for (const dir of toolPath.split(":")) {
    const file = path.join(dir, name);
    if (dir && fs.existsSync(file)) return file;
  }
  return null;
}

export function ffmpegAvailable(): boolean {
  return tool("ffmpeg") !== null && tool("ffprobe") !== null;
}

/** How long, and how big upright (a quarter turn in the file's metadata swaps the sides). */
export async function probe(file: string): Promise<VideoInfo | null> {
  const ffprobe = tool("ffprobe");
  if (!ffprobe) return null;
  try {
    const { stdout } = await exec(ffprobe, ["-v", "error", "-print_format", "json", "-show_entries", "format=duration:stream=codec_type,width,height:stream_side_data=rotation", file], { timeout: 30_000 });
    const json = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[] }[] };
    const video = json.streams?.find((s) => s.codec_type === "video");
    const duration = Number(json.format?.duration);
    if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) return null;
    const turned = Math.abs(video.side_data_list?.find((d) => typeof d.rotation === "number")?.rotation ?? 0) % 180 === 90;
    return { duration, width: turned ? video.height : video.width, height: turned ? video.width : video.height };
  } catch {
    return null;
  }
}

/** How a sheet is laid out: an upright video four across, a wide one two by two. */
export function layout(info: VideoInfo): { columns: number; rows: number; tileWidth: number } {
  const [columns, rows] = info.height > info.width ? [4, 1] : [2, 2];
  const tileWidth = Math.floor((SHEET_WIDTH - GAP * (columns + 1)) / columns / 2) * 2;
  return { columns, rows, tileWidth };
}

/** Which moments get a frame: evenly through the video, two a second at most, `MAX_FRAMES` at most. */
export function frameTimes(duration: number): { fps: number; times: number[] } {
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration * FRAMES_PER_SECOND)));
  const fps = count / duration;
  return { fps, times: Array.from({ length: count }, (_, i) => Math.round((i / fps) * 10) / 10) };
}

/** The sheets for a video, made once and kept beside it; null without ffmpeg or for a file it can't read. */
export async function frameSheets(file: string): Promise<VideoFrames | null> {
  const ffmpeg = tool("ffmpeg");
  const info = await probe(file);
  if (!ffmpeg || !info) return null;
  const dir = `${file}.frames`;
  const { fps, times } = frameTimes(info.duration);
  const { columns, rows, tileWidth } = layout(info);
  const perSheet = columns * rows;
  const done = () => fs.readdirSync(dir).filter((f) => /^sheet-\d+\.jpg$/.test(f)).sort();
  if (!fs.existsSync(dir) || done().length === 0) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      await exec(ffmpeg, ["-v", "error", "-y", "-i", file, "-an", "-vf", `fps=${fps.toFixed(4)},scale=${tileWidth}:-2,tile=${columns}x${rows}:padding=${GAP}:margin=${GAP}:color=white`, "-q:v", "4", path.join(dir, "sheet-%02d.jpg")], { timeout: FFMPEG_TIMEOUT_MS });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.error(`video: no frames for ${path.basename(file)}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  const sheets = done().map((name, i) => ({ path: path.join(dir, name), times: times.slice(i * perSheet, (i + 1) * perSheet) })).filter((s) => s.times.length > 0);
  return sheets.length > 0 ? { info, sheets } : null;
}

/** The phone's thumbnail for a video: its first moment, small. Made when first asked for. */
export async function poster(file: string): Promise<string | null> {
  const out = `${file}.poster.jpg`;
  if (fs.existsSync(out)) return out;
  const ffmpeg = tool("ffmpeg");
  if (!ffmpeg) return null;
  try {
    await exec(ffmpeg, ["-v", "error", "-y", "-i", file, "-an", "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "4", out], { timeout: 30_000 });
    return fs.existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/** What a video leaves beside it, for housekeeping to take with it. */
export function derivedPaths(file: string): string[] {
  return [`${file}.frames`, `${file}.poster.jpg`];
}

/** The trailer's words for a video's frames: the sheets as shown, and when each frame was. */
export function framesNote(frames: VideoFrames | null): string {
  if (!frames) {
    return ffmpegAvailable()
      ? "    No frames: ffmpeg couldn't read this video."
      : "    No frames: ffmpeg isn't installed on this Mac (brew install ffmpeg), so only the file is here.";
  }
  const { info, sheets } = frames;
  const seconds = (t: number) => `${t.toFixed(1)}s`;
  const lines = sheets.map((s, i) => `    sheet ${i + 1}: ${s.times.map(seconds).join(", ")}`);
  return [
    `    ${seconds(info.duration)}, ${info.width}×${info.height}. Shown above as ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} of frames, each read left to right${layout(info).rows > 1 ? " then down" : ""}, taken at:`,
    ...lines,
  ].join("\n");
}
