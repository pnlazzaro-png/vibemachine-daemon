// A repo with no .vibemachine.json: the iPhone app it builds is found by itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectedPreview, forgetDetected, previewSummary, projectConfig } from "../src/project.js";

function plist(dict: Record<string, string>): string {
  const body = Object.entries(dict).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`;
}

function app(products: string, name: string, id: string, at: Date): string {
  const dir = path.join(products, `${name}.app`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Info.plist"), plist({ CFBundleIdentifier: id, CFBundleExecutable: name }));
  fs.writeFileSync(path.join(dir, name), "");
  fs.utimesSync(path.join(dir, name), at, at);
  return dir;
}

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vm-project-")));
}

test("no file: the newest simulator app built in the repo, test runners and device builds aside", () => {
  const repo = tmp();
  const none = tmp();
  fs.mkdirSync(path.join(repo, "ios", "Foo.xcodeproj"), { recursive: true });
  const products = path.join(repo, "ios", "build", "DerivedData", "Build", "Products");
  app(path.join(products, "Debug-iphonesimulator"), "Foo", "com.example.foo", new Date(2026, 0, 1));
  const newer = app(path.join(products, "Debug-iphonesimulator"), "Bar", "com.example.bar", new Date(2026, 0, 2));
  app(path.join(products, "Debug-iphonesimulator"), "FooUITests-Runner", "com.example.runner", new Date(2026, 0, 3));
  app(path.join(products, "Debug-iphoneos"), "Foo", "com.example.device", new Date(2026, 0, 4));
  app(path.join(repo, "node_modules", "x", "Build", "Products", "Debug-iphonesimulator"), "Dep", "com.example.dep", new Date(2026, 0, 5));
  const p = detectedPreview(repo, none);
  assert.equal(p?.bundleId, "com.example.bar");
  assert.equal(p?.app, newer);
  assert.deepEqual(p?.screens, [{ name: "App", args: [] }]);
  assert.equal(p?.simulator, "iPhone Duo");
  assert.deepEqual(projectConfig(repo).preview?.bundleId, "com.example.bar");
});

test("no file: an app Xcode built into its own DerivedData for this repo counts; another repo's doesn't", () => {
  const repo = tmp();
  const dd = tmp();
  fs.mkdirSync(path.join(repo, "Foo.xcodeproj"));
  const mine = path.join(dd, "Foo-abc");
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, "info.plist"), plist({ WorkspacePath: path.join(repo, "Foo.xcodeproj") }));
  const theirs = path.join(dd, "Foo-xyz");
  fs.mkdirSync(theirs);
  fs.writeFileSync(path.join(theirs, "info.plist"), plist({ WorkspacePath: "/elsewhere/Foo.xcodeproj" }));
  app(path.join(theirs, "Build", "Products", "Debug-iphonesimulator"), "Foo", "com.example.other", new Date(2026, 0, 9));
  app(path.join(mine, "Build", "Products", "Debug-iphonesimulator"), "Foo", "com.example.mine", new Date(2026, 0, 1));
  assert.equal(detectedPreview(repo, dd)?.bundleId, "com.example.mine");
});

test("no file: an app project not yet built waits for its build; a repo with no app has no preview", () => {
  const repo = tmp();
  const none = tmp();
  fs.writeFileSync(path.join(repo, "project.yml"), "name: Foo\n");
  assert.equal(detectedPreview(repo, none), null);
  assert.deepEqual(previewSummary(repo), { web: null, screens: ["App"] });
  // Its first build, once the daemon has seen it.
  app(path.join(repo, "build", "Build", "Products", "Debug-iphonesimulator"), "Foo", "com.example.foo", new Date());
  forgetDetected(repo);
  assert.equal(detectedPreview(repo, none)?.bundleId, "com.example.foo");

  const web = tmp();
  fs.writeFileSync(path.join(web, "package.json"), "{}");
  assert.equal(previewSummary(web), null);
  assert.equal(projectConfig(web).preview, null);
});

test("a .vibemachine.json still decides, found app or not", () => {
  const repo = tmp();
  app(path.join(repo, "build", "Build", "Products", "Debug-iphonesimulator"), "Foo", "com.example.foo", new Date());
  fs.writeFileSync(path.join(repo, ".vibemachine.json"), JSON.stringify({ preview: { web: "https://x.test" } }));
  assert.deepEqual(previewSummary(repo), { web: "https://x.test", screens: [] });
});
