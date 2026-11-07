// Relayed lines stay small: a tool result that carried an image loses the bytes, long texts are cut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAY_TEXT_MAX, trimForRelay, withoutImageBytes } from "../src/trim.js";

test("image bytes in a tool result are dropped, with the size noted", () => {
  const line = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(1_000_000) } }] }] } };
  const out = trimForRelay(line) as any;
  assert.ok(JSON.stringify(out).length < 1000);
  assert.deepEqual(out.message.content[0].content[0].source, { type: "omitted", media_type: "image/png", bytes: 1_000_000 });
  assert.equal(JSON.stringify(line).length > 1_000_000, true, "the stored line is untouched");
});

test("long texts are cut, short lines pass through unchanged", () => {
  const long = { type: "assistant", message: { content: [{ type: "text", text: "a".repeat(RELAY_TEXT_MAX + 10) }] } };
  const out = trimForRelay(long) as any;
  assert.match(out.message.content[0].text, /… 10 more characters$/);
  const small = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
  assert.equal(trimForRelay(small), small, "same object when nothing changed");
  assert.equal(trimForRelay({ type: "result", subtype: "success" }).constructor, Object);
});

test("an image in the top-level tool_use_result is dropped too", () => {
  const line = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }, tool_use_result: { type: "image", file: { base64: "y".repeat(600_000), type: "image/png" } } };
  const out = trimForRelay(line) as any;
  assert.ok(JSON.stringify(out).length < 1000);
  assert.deepEqual(out.tool_use_result, { type: "image", omitted: true });
});

test("stored lines lose image bytes but keep their texts, and a slimmed line stays as it is", () => {
  const line = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(500_000) } }] }, { type: "text", text: "b".repeat(RELAY_TEXT_MAX + 10) }] }, tool_use_result: { type: "image", file: { base64: "y".repeat(500_000) } } };
  const slim = withoutImageBytes(line) as any;
  assert.ok(JSON.stringify(slim).length < RELAY_TEXT_MAX + 1000);
  assert.equal(slim.message.content[1].text.length, RELAY_TEXT_MAX + 10);
  assert.equal(withoutImageBytes(slim), slim, "nothing left to drop");
});
