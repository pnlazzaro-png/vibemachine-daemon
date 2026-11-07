// Files the phone sends with a prompt: screenshots, photos, documents. Each
// is saved under DATA_DIR/attachments/<session>/ and handed to Claude two
// ways: images inline as image blocks, and every file by its path on the
// Mac in a trailer, so the Read tool can open it. The CLI echoes the user
// message back with the base64 intact; `rewriteEcho` swaps that for the
// saved records before the line is stored or relayed. A video goes as sheets
// of its frames, made on the Mac (video.ts), with the times in the trailer.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { AttachmentRow, Store } from "./db.js";
import { framesNote, isVideo, type VideoFrames } from "./video.js";

export interface AttachmentInput {
  name: string;
  media_type: string;
  /** base64 */
  data: string;
}

/** What the phone sees on a prompt line and fetches from GET /attachments/:id. */
export interface PublicAttachment {
  id: string;
  name: string;
  media_type: string;
  size: number;
}

/** A content block as the CLI's stream-json user message takes it. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** What the API will take as an inline image; anything else goes by path. */
export const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** Per attachment, decoded. The phone downsizes images well under this. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** A video, decoded: a minute or two of screen recording. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

/** Each video's frames, by attachment id: made before the prompt goes (null when there are none). */
export type FramesById = Map<string, VideoFrames | null>;

/** Validate the request's `attachments`; throws with a message fit for a 400. */
export function parseAttachments(raw: unknown): AttachmentInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments`);
  return raw.map((item, i) => {
    const a = item as Partial<AttachmentInput> | null;
    if (!a || typeof a !== "object") throw new Error(`attachments[${i}] must be an object`);
    if (typeof a.name !== "string" || !a.name.trim()) throw new Error(`attachments[${i}].name is required`);
    if (typeof a.media_type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(a.media_type)) throw new Error(`attachments[${i}].media_type is required`);
    if (typeof a.data !== "string" || !a.data) throw new Error(`attachments[${i}].data (base64) is required`);
    // 3/4 of the base64 length, before the padding is known.
    const media_type = a.media_type.toLowerCase();
    const limit = isVideo(media_type) ? MAX_VIDEO_BYTES : MAX_ATTACHMENT_BYTES;
    if ((a.data.length * 3) / 4 > limit) throw new Error(`attachments[${i}] is over ${limit / 1024 / 1024} MB`);
    return { name: a.name.trim(), media_type, data: a.data };
  });
}

/** Write the files and record them. The bytes stay in memory for the image blocks. */
export function saveAttachments(store: Store, sessionId: string, turn: number, inputs: AttachmentInput[]): { row: AttachmentRow; bytes: Buffer }[] {
  if (inputs.length === 0) return [];
  const dir = path.join(config.dataDir, "attachments", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return inputs.map((input) => {
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length === 0) throw new Error(`${input.name}: data is not base64`);
    const id = randomUUID();
    const file = path.join(dir, `${id.slice(0, 8)}-${safeName(input.name)}`);
    fs.writeFileSync(file, bytes);
    const row = store.insertAttachment({ id, session_id: sessionId, turn, name: input.name, media_type: input.media_type, path: file, size: bytes.length });
    return { row, bytes };
  });
}

/** The user message's content: the prompt alone, or the prompt, the images (a video's sheets among them) and the trailer. */
export function promptContent(text: string, saved: { row: AttachmentRow; bytes: Buffer }[], frames: FramesById = new Map()): string | ContentBlock[] {
  if (saved.length === 0) return text;
  const blocks: ContentBlock[] = [];
  blocks.push({ type: "text", text: text.trim() || "See the attached files." });
  for (const { row, bytes } of saved) {
    if (INLINE_IMAGE_TYPES.has(row.media_type)) blocks.push({ type: "image", source: { type: "base64", media_type: row.media_type, data: bytes.toString("base64") } });
    for (const sheet of frames.get(row.id)?.sheets ?? []) {
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(sheet.path).toString("base64") } });
    }
  }
  blocks.push({ type: "text", text: trailer(saved.map((s) => s.row), frames) });
  return blocks;
}

/** The note that tells Claude where the files are on the Mac, and when a video's frames were taken. */
export function trailer(rows: AttachmentRow[], frames: FramesById = new Map()): string {
  const lines = rows.map((r) => {
    const inline = INLINE_IMAGE_TYPES.has(r.media_type) ? ", shown above" : "";
    const line = `- ${r.name} (${r.media_type}, ${humanSize(r.size)}${inline}): ${r.path}`;
    return isVideo(r.media_type) ? `${line}\n${framesNote(frames.get(r.id) ?? null)}` : line;
  });
  return `Attached from the phone, saved on this Mac (use Read for any you need to open):\n${lines.join("\n")}`;
}

export function publicAttachment(row: AttachmentRow): PublicAttachment {
  return { id: row.id, name: row.name, media_type: row.media_type, size: row.size };
}

/**
 * The CLI replays the prompt as a `user` line with the image data in it. Given
 * what was sent, return the line as it should be kept: the prompt as a plain
 * string, the attachments as records. Returns null when the line isn't that echo.
 */
export function rewriteEcho(line: Record<string, unknown>, sent: { text: string; attachments: PublicAttachment[] }): Record<string, unknown> | null {
  if (line.type !== "user") return null;
  const message = line.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const blocks = content as { type?: unknown; text?: unknown }[];
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const hasImage = blocks.some((b) => b.type === "image");
  const firstText = blocks.find((b) => b.type === "text")?.text;
  if (!hasImage && firstText !== (sent.text.trim() || "See the attached files.")) return null;
  return { ...line, message: { ...message, content: sent.text }, attachments: sent.attachments };
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.() -]+/g, "_").slice(0, 80);
  return base || "file";
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
