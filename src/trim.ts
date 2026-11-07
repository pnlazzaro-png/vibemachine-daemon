// Image bytes and long texts out of a stream line. The phone gets every line trimmed this way, and
// the events table keeps lines without image bytes: a screenshot Claude reads comes back as about a
// megabyte of base64, twice, which nothing reads again ("Claude looked at" copies the file itself).
// The full result stays in Claude Code's own transcript.

/** A relayed line stays small: image bytes a tool returned are dropped (the phone shows "[image]"), long texts cut. */
export const RELAY_TEXT_MAX = 200_000;
export function trimForRelay(event: unknown, textMax = RELAY_TEXT_MAX): unknown {
  if (!event || typeof event !== "object") return event;
  let e = event as Record<string, unknown>;
  // The structured copy of a tool's result rides at the top level too; an image there is as big.
  let changed = false;
  if (e.tool_use_result && typeof e.tool_use_result === "object") {
    const r = e.tool_use_result as Record<string, unknown>;
    if (r.omitted !== true && (r.type === "image" || (typeof r.file === "object" && r.file && typeof (r.file as Record<string, unknown>).base64 === "string"))) {
      e = { ...e, tool_use_result: { type: "image", omitted: true } };
      changed = true;
    }
  }
  const message = e.message as { content?: unknown } | undefined;
  if (!Array.isArray(message?.content)) return changed ? e : event;
  const content = (message!.content as unknown[]).map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;
    if (b.type === "image" && b.source && typeof b.source === "object") {
      const source = b.source as Record<string, unknown>;
      if (typeof source.data === "string") {
        changed = true;
        return { ...b, source: { type: "omitted", media_type: source.media_type, bytes: source.data.length } };
      }
    }
    if (b.type === "tool_result" && Array.isArray(b.content)) {
      const inner = trimForRelay({ message: { content: b.content } }, textMax) as { message: { content: unknown[] } } | undefined;
      if (inner && inner.message.content !== b.content) {
        changed = true;
        return { ...b, content: inner.message.content };
      }
    }
    if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > textMax) {
      changed = true;
      return { ...b, content: b.content.slice(0, textMax) + `\n… ${b.content.length - textMax} more characters` };
    }
    if (b.type === "text" && typeof b.text === "string" && b.text.length > textMax) {
      changed = true;
      return { ...b, text: b.text.slice(0, textMax) + `\n… ${b.text.length - textMax} more characters` };
    }
    return block;
  });
  return changed ? { ...e, message: { ...message, content } } : event;
}

/** The line as the events table keeps it: images without their bytes, texts whole. The same object when there are none. */
export function withoutImageBytes<T>(event: T): T {
  return trimForRelay(event, Infinity) as T;
}
