import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { KeepAwake } from "../src/keepawake.js";

/** A stand-in for caffeinate: counts how many were started and which are still running. */
function fakeSpawner() {
  const started: FakeChild[] = [];
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    killed = false;
    kill(): boolean {
      this.killed = true;
      this.signalCode = "SIGTERM";
      this.emit("exit", null, "SIGTERM");
      return true;
    }
    /** It went on its own. */
    die(): void {
      this.exitCode = 1;
      this.emit("exit", 1, null);
    }
  }
  const spawner = () => {
    const c = new FakeChild();
    started.push(c);
    return c as unknown as ChildProcess;
  };
  const running = () => started.filter((c) => c.exitCode === null && c.signalCode === null).length;
  return { spawner, started, running };
}

test("one caffeinate however many turns, gone when the last ends", () => {
  const f = fakeSpawner();
  const k = new KeepAwake(f.spawner);
  const a = {}, b = {};
  assert.equal(f.started.length, 0, "nothing until a turn starts");
  k.hold(a);
  k.hold(b);
  k.hold(a);
  assert.equal(f.started.length, 1);
  assert.equal(f.running(), 1);
  k.release(a);
  assert.equal(f.running(), 1, "b's turn still runs");
  k.release(a);
  assert.equal(f.running(), 1, "a released twice doesn't drop b");
  k.release(b);
  assert.equal(f.running(), 0);
  assert.equal(k.active, false);
  k.set(a, true);
  assert.equal(f.started.length, 2, "a new turn takes a new one");
  k.set(a, false);
  assert.equal(f.running(), 0);
});

test("releasing what was never held starts nothing", () => {
  const f = fakeSpawner();
  const k = new KeepAwake(f.spawner);
  k.release({});
  k.set({}, false);
  assert.equal(f.started.length, 0);
});

test("stop drops every holder and the assertion", () => {
  const f = fakeSpawner();
  const k = new KeepAwake(f.spawner);
  k.hold("a");
  k.hold("b");
  k.stop();
  assert.equal(k.held, false);
  assert.equal(f.running(), 0);
});

test("a caffeinate that dies mid-turn is replaced, after a pause", async () => {
  const f = fakeSpawner();
  const k = new KeepAwake(f.spawner, 10);
  k.hold("a");
  f.started[0]!.die();
  assert.equal(k.active, false);
  assert.equal(f.started.length, 1, "not at once");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.started.length, 2);
  assert.equal(f.running(), 1);
  k.release("a");
  assert.equal(f.running(), 0);
});

test("one that dies after the turn ended isn't replaced", async () => {
  const f = fakeSpawner();
  const k = new KeepAwake(f.spawner, 10);
  k.hold("a");
  k.release("a");
  f.started[0]!.die();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.started.length, 1);
});

test("no caffeinate on this system: turns go on, nothing retried", async () => {
  let calls = 0;
  const k = new KeepAwake(() => {
    calls++;
    const c = new EventEmitter() as unknown as ChildProcess;
    queueMicrotask(() => c.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    return c;
  }, 10);
  k.hold("a");
  await new Promise((r) => setTimeout(r, 30));
  k.release("a");
  k.hold("b");
  assert.equal(calls, 1);
  assert.equal(k.active, false);
  assert.equal(new KeepAwake(null).active, false);
});

test("the real caffeinate starts and stops", { skip: process.platform !== "darwin" }, async () => {
  const k = new KeepAwake();
  k.hold("a");
  assert.equal(k.active, true);
  k.release("a");
  assert.equal(k.active, false);
});
