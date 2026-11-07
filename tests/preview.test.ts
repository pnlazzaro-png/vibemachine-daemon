// The parts of the preview that don't need a simulator: reading a project's
// .vibemachine.json, reading xcodebuild's verdict out of a Bash result, and
// the pixel checks on the files simctl writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { buildsPreviewApp, CAPTURE_KEEP_MS, foldedNote, isImagePath, isReleaseScript, launchedArgs, ORIGINAL_KEEP_MS, originalPath, PreviewWatcher, pruneCaptures, pruneOriginals, releaseOutcome, screensFor, xcodebuildOutcome } from "../src/preview.js";
import { parseProjectConfig } from "../src/project.js";
import { bmpHasPixels, displayKind, parseDisplays, pngSize } from "../src/simulator.js";

test("project config: screens, defaults and paths", () => {
  const c = parseProjectConfig(
    { preview: { bundle_id: "com.x.y", app: "ios/build/Y.app", screens: [{ name: "Home" }, { name: "Health", args: ["-initialTab", "health"] }] } },
    "/repo",
  );
  assert.ok(c.preview);
  assert.equal(c.preview.simulator, "iPhone Duo");
  assert.equal(c.preview.app, "/repo/ios/build/Y.app");
  assert.equal(c.preview.settleMs, 2500);
  assert.deepEqual(c.preview.screens, [
    { name: "Home", args: [] },
    { name: "Health", args: ["-initialTab", "health"] },
  ]);
  assert.equal(c.preview.web, null);
});

test("project config: an app with no screens gets one; web alone is fine; half an app is not", () => {
  assert.deepEqual(parseProjectConfig({ preview: { bundle_id: "a", app: "b" } }, "/r").preview?.screens, [{ name: "App", args: [] }]);
  const web = parseProjectConfig({ preview: { web: "https://x.test" } }, "/r").preview;
  assert.equal(web?.web, "https://x.test");
  assert.equal(web?.app, "");
  assert.throws(() => parseProjectConfig({ preview: { bundle_id: "a" } }, "/r"), /both/);
  assert.equal(parseProjectConfig({}, "/r").preview, null);
});

test("xcodebuild outcome from a Bash result", () => {
  const ok = xcodebuildOutcome("cd ios && xcodebuild -scheme X build 2>&1 | tail -3", "...\n** BUILD SUCCEEDED **\n", false);
  assert.deepEqual(ok, { stage: "build", ok: true, detail: "" });
  const warn = xcodebuildOutcome("xcodebuild build", "a.swift:1: warning: x\n** BUILD SUCCEEDED **", false);
  assert.equal(warn?.detail, "1 warning");
  const failed = xcodebuildOutcome("xcodebuild -scheme X build", "/a/b.swift:10:3: error: cannot find 'x' in scope\n** BUILD FAILED **\n", true);
  assert.equal(failed?.ok, false);
  assert.match(failed?.detail ?? "", /^1 error: .*cannot find 'x'/);
  const archive = xcodebuildOutcome("xcodebuild -archivePath p archive", "** ARCHIVE SUCCEEDED **", false);
  assert.equal(archive?.stage, "archive");
  const tested = xcodebuildOutcome("xcodebuild -scheme X -destination d test 2>&1 | grep -E 'passed|SUCCEEDED'", "✔ Test a() passed\n** TEST SUCCEEDED **", false);
  assert.deepEqual(tested, { stage: "build", ok: true, detail: "tests passed" });
  const testFailed = xcodebuildOutcome("xcodebuild test", "✘ Test a() failed\n** TEST FAILED **", true);
  assert.equal(testFailed?.ok, false);
  assert.equal(xcodebuildOutcome("xcodebuild -list", "Targets:\n  X", false), null, "no verdict, no line");
  assert.equal(xcodebuildOutcome("ls", "** BUILD SUCCEEDED **", false), null, "not xcodebuild");
  assert.equal(xcodebuildOutcome(undefined, "x", false), null);
});

test("bmp and png checks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-preview-"));
  const bmp = (pixels: number[][]): string => {
    const header = Buffer.alloc(54);
    header.write("BM", 0, "ascii");
    header.writeUInt32LE(54, 10);
    header.writeUInt16LE(32, 28);
    const file = path.join(dir, `${Math.random()}.bmp`);
    fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pixels.flat())]));
    return file;
  };
  assert.equal(bmpHasPixels(bmp([[0, 0, 0, 255], [0, 0, 0, 255]])), false, "black with opaque alpha is blank");
  assert.equal(bmpHasPixels(bmp([[0, 0, 0, 255], [0, 7, 0, 255]])), true);
  const png = path.join(dir, "x.png");
  const ihdr = Buffer.alloc(8);
  ihdr.writeUInt32BE(640, 0);
  ihdr.writeUInt32BE(480, 4);
  fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), ihdr]));
  assert.deepEqual(pngSize(png), { width: 640, height: 480 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the images Claude reads that the preview shows", () => {
  assert.ok(isImagePath("/tmp/vm-sheet.png"));
  assert.ok(isImagePath("/Users/p/Library/Application Support/VibeMachine/attachments/x/pasted.JPG"));
  assert.ok(isImagePath("shot.heic"));
  assert.ok(!isImagePath("/repo/src/preview.ts"));
  assert.ok(!isImagePath("/repo/docs/spec.pdf"));
  assert.ok(!isImagePath(undefined));
});

test("a turn's before is each screen's newest capture in the project, not a fresh shot", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vm-before-"));
  fs.writeFileSync(path.join(cwd, ".vibemachine.json"), JSON.stringify({
    preview: { simulator: "iPhone Duo", bundle_id: "com.example.app", app: "build/App.app", screens: [{ name: "Unfolded" }, { name: "Folded" }] },
  }));
  const store = new Store(":memory:");
  const now = new Date().toISOString();
  store.insertSession({ id: "older", title: "t", cwd, model: null, permission_mode: "default", status: "idle", created_at: now });
  store.insertSession({ id: "newer", title: "t", cwd, model: null, permission_mode: "default", status: "idle", created_at: now });
  const file = (name: string) => { const f = path.join(cwd, name); fs.writeFileSync(f, "png"); return f; };
  const add = (id: string, session: string, screen: string, kind: string) =>
    store.insertCapture({ id, session_id: session, turn: 1, screen, kind, path: file(`${id}.png`), width: 1, height: 1 });
  add("u-old", "older", "Unfolded", "after");
  await new Promise((r) => setTimeout(r, 5));
  add("u-new", "newer", "Unfolded", "after");
  add("f-before", "older", "Folded", "before");
  await new Promise((r) => setTimeout(r, 5));
  add("look", "newer", "Unfolded", "look"); // an image Claude read is not the app's screen

  const watcher = new PreviewWatcher(store, "current", cwd, () => {});
  await watcher.startTurn(2, { shootBefore: true });
  const before = (watcher as unknown as { t: { before: Map<string, { id: string }> } }).t.before;
  assert.equal(before.get("Unfolded")?.id, "u-new");
  assert.equal(before.get("Folded")?.id, "f-before");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("the release scripts count as an archive: uploaded, failed, ad hoc, in the background", () => {
  const tf = "cd ~/dev/vibemachine/ios && ./scripts/testflight.sh 2>&1 | tail -3";
  assert.ok(isReleaseScript(tf));
  assert.ok(isReleaseScript("ios/scripts/adhoc.sh"));
  assert.ok(!isReleaseScript("git status"));

  const up = releaseOutcome(tf, "** ARCHIVE SUCCEEDED **\nUploading to App Store Connect…\nUploaded build 202610251518. TestFlight offers it…", false);
  assert.deepEqual([up?.stage, up?.ok, up?.title], ["archive", true, "uploaded to TestFlight"]);
  assert.match(up!.detail, /202610251518/);

  const tests = releaseOutcome(tf, "Tests failed; nothing uploaded. Log: ios/build/TestFlight/test.log", false);
  assert.deepEqual([tests?.ok, tests?.title], [false, "TestFlight upload failed"]);

  const error = releaseOutcome(tf, "Archive failed; full log: ios/build/x.log", true);
  assert.equal(error?.ok, false);

  const already = releaseOutcome(tf, "Already on TestFlight as build 202610271711: that upload carried this same app (889a889), so it isn't sent again.", false);
  assert.equal(already?.ok, true);
  assert.equal(already?.title, "already on TestFlight");
  assert.equal(already?.shipped, undefined);
  const adhoc = releaseOutcome("./scripts/adhoc.sh", "Exporting…\n\nReady. On the phone, open:\n  https://…", false);
  assert.deepEqual([adhoc?.ok, adhoc?.title], [true, "ad hoc build ready"]);

  const bg = releaseOutcome(tf, "Command running in background with ID: b1", false);
  assert.equal(bg?.detail, "in the background");

  assert.equal(releaseOutcome("xcodebuild build", "BUILD SUCCEEDED", false), null);
});

// What `simctl io <duo> enumerate` lists, trimmed: inner 2007x2853, cover 1398x2034, two external.
const ENUMERATE = `Port:
    UUID: 7EEDFAB0-32BE-4DA5-9814-DB4803AD32EE
    Class: Unknown
Port:
    UUID: 42D56D12-9D94-4D80-B1AA-2D35902B8EE1
    Class: Display
    Display class: 0
    Default width: 2007
    Default height: 2853
Port:
    UUID: 48F91A0D-A0E4-4746-AADA-DE16D8320566
    Class: Display
    Display class: 1
    Default width: 7680
    Default height: 4320
Port:
    UUID: DB342E6B-EC24-4A01-94F9-AD07B0F5AF14
    Class: Display
    Display class: 0
    Default width: 1398
    Default height: 2034`;

test("the Duo's inner screen is its largest own display; the other is the cover", () => {
  const all = parseDisplays(ENUMERATE);
  assert.equal(all.length, 3);
  assert.equal(displayKind("42D56D12-9D94-4D80-B1AA-2D35902B8EE1", all), "inner");
  assert.equal(displayKind("DB342E6B-EC24-4A01-94F9-AD07B0F5AF14", all), "cover");
});

test("only the lit display's screens are shot, and a folded simulator says so", () => {
  const screens = [
    { name: "Unfolded", display: "inner" as const, args: ["-orientation", "landscape"] },
    { name: "Folded", display: "cover" as const, args: ["-orientation", "portrait"] },
    { name: "Any", args: [] },
  ];
  assert.deepEqual(screensFor(screens, "inner").map((s) => s.name), ["Unfolded", "Any"]);
  assert.deepEqual(screensFor(screens, "cover").map((s) => s.name), ["Folded", "Any"]);
  assert.match(foldedNote(screens, "cover") ?? "", /folded/);
  assert.equal(foldedNote(screens, "inner"), undefined);
  assert.equal(foldedNote([{ name: "Folded", display: "cover", args: [] }], "cover"), undefined, "nothing wanted the inner screen");
});

test("the screen Claude opened: the last launch of the app, its own arguments", () => {
  const id = "com.pnlazzaro.vibemachine";
  assert.deepEqual(
    launchedArgs(`xcrun simctl launch --terminate-running-process booted ${id} -noPushPrompt YES -orientation landscape -stage tools >/dev/null && sleep 18`, id),
    ["-noPushPrompt", "YES", "-orientation", "landscape", "-stage", "tools"],
  );
  assert.deepEqual(launchedArgs(`xcrun simctl launch booted ${id}; xcrun simctl launch booted ${id} -showStats YES`, id), ["-showStats", "YES"]);
  assert.deepEqual(launchedArgs(`xcrun simctl launch booted ${id}`, id), []);
  assert.equal(launchedArgs(`for o in a b; do xcrun simctl launch booted ${id} -orientation $o; done`, id), null, "a variable can't be known");
  assert.equal(launchedArgs(`xcrun simctl launch booted com.other.app -x`, id), null);
  assert.equal(launchedArgs("git status", id), null);
});

test("originals: kept beside the pane's copy, pruned once past their keep", () => {
  assert.equal(originalPath("/c/s/abc.png"), "/c/s/abc-full.png");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-captures-"));
  const session = path.join(dir, "session");
  fs.mkdirSync(session);
  const now = Date.now();
  const write = (name: string, ageMs: number) => {
    const file = path.join(session, name);
    fs.writeFileSync(file, "png");
    const t = new Date(now - ageMs);
    fs.utimesSync(file, t, t);
  };
  write("old.png", ORIGINAL_KEEP_MS * 2);
  write("old-full.png", ORIGINAL_KEEP_MS * 2);
  write("new-full.png", 1000);
  assert.equal(pruneOriginals(dir, now), 1);
  assert.deepEqual(fs.readdirSync(session).sort(), ["new-full.png", "old.png"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a build forces the preview's capture only when it built the preview's own app", () => {
  const cwd = "/Users/me/dev/app";
  const app = "/Users/me/dev/app/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/App.app";
  assert.equal(buildsPreviewApp("cd ios && xcodebuild -scheme V -derivedDataPath build/DerivedData build", cwd, app), true);
  assert.equal(buildsPreviewApp("xcodebuild -project ios/V.xcodeproj -derivedDataPath ios/build/DerivedData test", cwd, app), true);
  assert.equal(buildsPreviewApp("cd ios && xcodebuild -scheme V -derivedDataPath /tmp/vm-keys-dd build", cwd, app), false);
  assert.equal(buildsPreviewApp("xcodebuild -scheme V build", cwd, app), false);
});

test("captures: a week kept, and each project's newest shot of each screen always", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-prune-"));
  const store = new Store(":memory:");
  store.insertSession({ id: "s1", title: "t", cwd: "/p", model: null, permission_mode: "default", status: "idle", created_at: "2026-10-01T00:00:00.000Z" });
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  // Turn 1 is old; turn 2, the session's last with pictures, is kept whole (the next test).
  const add = (id: string, screen: string, kind: string, ageMs: number) => {
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, "png");
    fs.writeFileSync(originalPath(file), "png");
    store.insertCapture({ id, session_id: "s1", turn: ageMs > CAPTURE_KEEP_MS ? 1 : 2, screen, kind, path: file, width: 1, height: 1 });
    store.db.prepare(`UPDATE captures SET created_at = ? WHERE id = ?`).run(new Date(now - ageMs).toISOString(), id);
  };
  const old = CAPTURE_KEEP_MS + 60_000;
  add("unfolded-old", "Unfolded", "after", old * 2);
  add("unfolded-newest", "Unfolded", "after", old); // old, but the screen's newest: the next before
  add("folded-recent", "Folded", "after", 1000);
  add("folded-old", "Folded", "before", old);
  add("look-old", "shot.png", "look", old);
  assert.equal(pruneCaptures(store, now), 3);
  const left = (store.db.prepare(`SELECT id FROM captures ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(left, ["folded-recent", "unfolded-newest"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["folded-recent-full.png", "folded-recent.png", "unfolded-newest-full.png", "unfolded-newest.png"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("captures: a session's last turn keeps all it shows, however old", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-prune-last-"));
  const store = new Store(":memory:");
  store.insertSession({ id: "s1", title: "t", cwd: "/p", model: null, permission_mode: "default", status: "idle", created_at: "2026-09-01T00:00:00.000Z" });
  const now = Date.parse("2026-10-26T12:00:00.000Z");
  const month = 30 * 24 * 60 * 60 * 1000;
  const add = (id: string, turn: number, screen: string, kind: string) => {
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, "png");
    store.insertCapture({ id, session_id: "s1", turn, screen, kind, path: file, width: 1, height: 1 });
    store.db.prepare(`UPDATE captures SET created_at = ? WHERE id = ?`).run(new Date(now - month + turn).toISOString(), id);
  };
  add("t1-before", 1, "Unfolded", "before"); // turn 2 compares against it
  add("t1-stray", 1, "Unfolded", "after");
  add("t2-after", 2, "Unfolded", "after");
  add("t2-look", 2, "shot.png", "look");
  store.appendEvent("s1", { type: "preview", id: "2-unfolded", turn: 2, screen: "Unfolded", status: "done", before: { id: "t1-before", width: 1, height: 1 }, after: { id: "t2-after", width: 1, height: 1 }, caption: null, ts: "x" });
  assert.equal(pruneCaptures(store, now), 1);
  const left = (store.db.prepare(`SELECT id FROM captures ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(left, ["t1-before", "t2-after", "t2-look"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("releaseOutcome: a script the tool backgrounded is still running, with its output file; a stop is a failure", async () => {
  const { releaseOutcome, isReleaseProcess } = await import("../src/preview.js");
  const notice = "Command running in background with ID: bt4t74542. Output is being written to: /private/tmp/claude-501/x/tasks/bt4t74542.output. You will be notified when it completes.";
  const r = releaseOutcome("cd ios && scripts/testflight.sh > /tmp/log 2>&1", notice, false);
  assert.equal(r?.ok, true);
  assert.equal(r?.title, "uploading to TestFlight");
  assert.deepEqual(r?.background, { output: "/private/tmp/claude-501/x/tasks/bt4t74542.output" });
  assert.equal(releaseOutcome("scripts/testflight.sh", "Archiving…\nUpload stopped: a newer prompt is queued. Nothing was uploaded; the release notes are back to \"next\".", false)?.ok, false);
  assert.equal(releaseOutcome("scripts/testflight.sh", "Uploaded build 202610271116. TestFlight offers it…", false)?.shipped, true);
  assert.equal(isReleaseProcess("/bin/bash ./scripts/testflight.sh"), true);
  assert.equal(isReleaseProcess("scripts/adhoc.sh"), true);
  assert.equal(isReleaseProcess("zsh -c scripts/testflight.sh > log"), true);
  assert.equal(isReleaseProcess("vim ios/scripts/testflight.sh"), false);
  assert.equal(isReleaseProcess("node --import tsx src/main.ts"), false);
});

test("resultText: a backgrounded command's notice comes from the content, not the empty output fields", async () => {
  const { resultText } = await import("../src/sessions.js");
  const notice = "Command running in background with ID: b11sgrrzk. Output is being written to: /private/tmp/claude-501/x/tasks/b11sgrrzk.output. You will be notified when it completes.";
  const structured = { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "b11sgrrzk" };
  const text = resultText(notice, structured);
  assert.equal(text, notice);
  // As the daemon then reads it: still running, watched through its output file.
  assert.deepEqual(releaseOutcome("cd ios && scripts/testflight.sh > /tmp/log 2>&1", text, false)?.background, { output: "/private/tmp/claude-501/x/tasks/b11sgrrzk.output" });
  assert.equal(resultText("ignored", { stdout: "Uploaded build 1", stderr: "" }), "Uploaded build 1", "a foreground run: the tool's own output");
});

test("changes: none for the same shot or a breath of glow; a box where a badge appeared; the status corner left out", async () => {
  const sim = await import("../src/simulator.js");
  const side = sim.COMPARE_SIDE;
  const base = new Uint8Array(side * side).map((_, i) => (i * 37) % 256);
  // Lighter or darker by `by` over a patch, x and y in pixels.
  const patch = (from: Uint8Array, x: number, y: number, w: number, h: number, by = 80) => {
    const out = from.slice();
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) out[r * side + c] = (out[r * side + c]! + by) % 256;
    return out;
  };
  assert.deepEqual(sim.changedBoxes(base, base.slice(), side, true), []);
  assert.deepEqual(sim.changedBoxes(base, patch(base, 100, 100, 3, 1), side, true), [], "three pixels of a lamp's breath");
  assert.deepEqual(sim.changedBoxes(base, patch(base, 100, 100, 6, 6, 10), side, true), [], "a faint shade isn't a change");
  // A badge of about 16 by 6 shrunk pixels appears halfway along, low on the screen.
  const [badge] = sim.changedBoxes(base, patch(base, 120, 200, 16, 6), side, true);
  assert.ok(badge);
  assert.ok(badge.x <= 120 / side && badge.x + badge.w >= 136 / side, `across the badge: ${JSON.stringify(badge)}`);
  assert.ok(badge.y <= 200 / side && badge.y + badge.h >= 206 / side);
  assert.ok(badge.w < 0.15 && badge.h < 0.1, "a box round the badge, not the screen");
  // The clock and battery in the top right corner aren't the turn's doing.
  assert.deepEqual(sim.changedBoxes(base, patch(base, 240, 10, 12, 12), side, true), []);
  // Two changes far apart are two boxes, the bigger first.
  const two = sim.changedBoxes(base, patch(patch(base, 20, 60, 10, 10), 180, 180, 30, 20), side, true);
  assert.equal(two.length, 2);
  assert.ok(two[0]!.x > 0.6, "the bigger change first");
  // A 2×2 24-bit BMP, stored bottom row first, read top row first in gray.
  const bmp = Buffer.alloc(54 + 16);
  bmp.write("BM", 0, "ascii"); bmp.writeUInt32LE(54, 10); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22); bmp.writeUInt16LE(24, 28);
  // Bottom row: white, white. Top row: black, white (each row padded to 8 bytes).
  [255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0].forEach((v, i) => (bmp[54 + i] = v));
  assert.deepEqual([...sim.bmpGray(bmp)], [0, 255, 255, 255]);
});

test("release scripts: a command that runs one, not one that names it", async () => {
  const { isReleaseScript } = await import("../src/release.js");
  for (const ran of ["ios/scripts/testflight.sh", "cd ios && scripts/testflight.sh > /tmp/log 2>&1", "/bin/bash ./scripts/testflight.sh", "SKIP_UPLOAD=1 scripts/testflight.sh",
    "W=x; git worktree add $W HEAD && cd $W/ios && xcodegen && scripts/testflight.sh > /tmp/t.log 2>&1; echo done", "(cd ios && ./scripts/adhoc.sh)", "nohup /Users/me/dev/app/ios/scripts/testflight.sh &"]) {
    assert.equal(isReleaseScript(ran), true, ran);
  }
  for (const named of ['pgrep -f "scripts/testflight.sh"', "cat ios/scripts/testflight.sh | head", "tail -3 /tmp/vm-testflight12.log", "grep -n retag ios/scripts/testflight.sh", "ps -Ao args | grep testflight.sh", "git add ios/scripts/testflight.sh"]) {
    assert.equal(isReleaseScript(named), false, named);
  }
});
