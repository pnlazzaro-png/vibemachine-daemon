// The commit watch: a line and a diff per commit, until a turn moves HEAD across too many.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COMMIT_DETAIL_MAX, commitsSince, gitHead } from "../src/pipeline.js";

function repoWith(commits: number): { dir: string; shas: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-pipeline-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  const shas: string[] = [];
  for (let i = 1; i <= commits; i++) {
    fs.writeFileSync(path.join(dir, "file.txt"), `line ${i}\n`);
    git("add", "file.txt");
    git("commit", "-q", "-m", `change ${i}`);
    shas.push(git("rev-parse", "HEAD").trim());
  }
  return { dir, shas };
}

test("a few commits: a line each, with its sha, its stat and its diff", async (t) => {
  const { dir, shas } = repoWith(4);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const found = await commitsSince(dir, shas[0]!);
  assert.deepEqual(found.shas, shas.slice(1));
  assert.deepEqual(found.lines.map((l) => l.ref), shas.slice(1));
  assert.deepEqual(found.lines.map((l) => l.title.replace(/^\w+ /, "")), ["change 2", "change 3", "change 4"]);
  assert.match(found.lines[0]!.detail ?? "", /1 file changed/);
  assert.match(found.lines[0]!.log ?? "", /^\+line 2$/m);
  assert.deepEqual(await commitsSince(dir, await gitHead(dir)), { lines: [], shas: [] });
});

test("many commits: one line for the older ones, then the newest few in full", async (t) => {
  const { dir, shas } = repoWith(COMMIT_DETAIL_MAX + 8);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // No HEAD when the turn began (a first clone): the whole history is new.
  const found = await commitsSince(dir, null);
  assert.equal(found.lines.length, COMMIT_DETAIL_MAX + 1);
  assert.deepEqual(found.shas, shas, "every commit is covered, so none comes back on the next look");
  const [rest, ...newest] = found.lines;
  assert.equal(rest!.title, "8 earlier commits");
  assert.equal(rest!.stage, "commit");
  assert.equal(rest!.status, "done");
  assert.equal(rest!.count, 8);
  assert.equal(rest!.ref, undefined, "no ref: the phone offers a diff for a commit line that has one");
  assert.equal(rest!.detail, `${shas[0]!.slice(0, 7)}..${shas[7]!.slice(0, 7)}`);
  // Its log lists them, newest first.
  assert.deepEqual(rest!.log!.trim().split("\n").map((l) => l.replace(/^\w+ /, "")), [8, 7, 6, 5, 4, 3, 2, 1].map((n) => `change ${n}`));
  assert.deepEqual(newest.map((l) => l.ref), shas.slice(8));
  assert.ok(newest.every((l) => /^diff --git/m.test(l.log ?? "")));
});

test("commits already on the stream aren't counted again", async (t) => {
  const { dir, shas } = repoWith(COMMIT_DETAIL_MAX + 3);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = new Set(shas.slice(0, 3));
  const found = await commitsSince(dir, null, seen);
  assert.deepEqual(found.lines.map((l) => l.ref), shas.slice(3), "five left: each in full, no line for the rest");
  const one = await commitsSince(dir, null, new Set(shas.slice(1)), 0);
  assert.equal(one.lines.length, 1);
  assert.equal(one.lines[0]!.title, "1 earlier commit");
  assert.equal(one.lines[0]!.detail, shas[0]!.slice(0, 7));
});
