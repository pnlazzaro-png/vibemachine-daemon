// Attachments without a child: what the phone's request must look like, what
// Claude is sent, and how the CLI's echo is rewritten before it is kept.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parseAttachments, promptContent, rewriteEcho, saveAttachments, trailer } from "../src/attachments.js";
import { config } from "../src/config.js";
import { Store } from "../src/db.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("parseAttachments: shape and limits", () => {
  assert.deepEqual(parseAttachments(undefined), []);
  assert.throws(() => parseAttachments({}), /array/);
  assert.throws(() => parseAttachments([{ name: "a.png", data: "x" }]), /media_type/);
  assert.throws(() => parseAttachments([{ name: "a.png", media_type: "image/png" }]), /data/);
  const [a] = parseAttachments([{ name: " shot.PNG ", media_type: "IMAGE/PNG", data: png.toString("base64") }]);
  assert.equal(a!.name, "shot.PNG");
  assert.equal(a!.media_type, "image/png");
});

test("promptContent: images inline, every file by path, the prompt first", () => {
  const store = new Store(":memory:");
  const inputs = [
    { name: "shot.png", media_type: "image/png", data: png.toString("base64") },
    { name: "notes.pdf", media_type: "application/pdf", data: Buffer.from("%PDF-1.4").toString("base64") },
  ];
  const saved = saveAttachments(store, "s1", 3, inputs);
  try {
    assert.equal(saved.length, 2);
    for (const { row } of saved) {
      assert.ok(row.path.startsWith(`${config.dataDir}/attachments/s1/`));
      assert.ok(fs.existsSync(row.path));
    }
    assert.equal(store.getAttachment(saved[0]!.row.id)?.turn, 3);

    const content = promptContent("What's wrong here?", saved);
    assert.ok(Array.isArray(content));
    assert.deepEqual(content.map((b) => b.type), ["text", "image", "text"]);
    assert.equal((content[0] as { text: string }).text, "What's wrong here?");
    const image = content[1] as { source: { media_type: string; data: string } };
    assert.equal(image.source.media_type, "image/png");
    assert.equal(image.source.data, png.toString("base64"));
    const note = (content[2] as { text: string }).text;
    assert.ok(note.includes(saved[1]!.row.path), "the pdf is named by path");
    assert.ok(note.includes("shown above"), "the image is marked as inline");
    assert.equal(note, trailer(saved.map((s) => s.row)));

    // No prompt text: Claude still gets a sentence to act on.
    assert.equal(((promptContent("  ", saved) as { text: string }[])[0]).text, "See the attached files.");
    // No attachments: the plain string, as before.
    assert.equal(promptContent("hi", []), "hi");
  } finally {
    for (const { row } of saved) fs.rmSync(row.path, { force: true });
    store.close();
  }
});

test("rewriteEcho: the replayed prompt loses its bytes and gains its records", () => {
  const sent = { text: "Look", attachments: [{ id: "a1", name: "shot.png", media_type: "image/png", size: 70 }] };
  const echo = {
    type: "user",
    isReplay: true,
    message: { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "Attached…" }] },
  };
  const kept = rewriteEcho(echo, sent)!;
  assert.equal((kept.message as { content: unknown }).content, "Look");
  assert.deepEqual(kept.attachments, sent.attachments);
  assert.equal(kept.isReplay, true);
  assert.ok(!JSON.stringify(kept).includes("AAAA"));

  // Not the echo: a tool result, an assistant line, a different prompt.
  assert.equal(rewriteEcho({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t" }] } }, sent), null);
  assert.equal(rewriteEcho({ type: "assistant", message: { content: [{ type: "text", text: "Look" }] } }, sent), null);
  assert.equal(rewriteEcho({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }, sent), null);
  // Files only (no image block): matched by the prompt text.
  assert.ok(rewriteEcho({ type: "user", message: { content: [{ type: "text", text: "Look" }, { type: "text", text: "Attached…" }] } }, sent));
});
