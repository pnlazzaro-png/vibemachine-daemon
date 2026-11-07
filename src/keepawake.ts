// Keep the Mac awake while a turn is in flight (audit 3.10): an idle sleep mid-turn stops the
// child, and the phone waits on a turn that never ends. One `caffeinate -i` at most, held while
// any session has a turn running and stopped when the last one ends.
//
// `-w <daemon pid>` makes caffeinate exit on its own when the daemon does, however it goes (a
// crash or a SIGKILL included), so a stray assertion can't outlive us. The holders are a set, not
// a count: releasing one twice (a turn ended by its result and then by its child's exit) can't
// let another session's turn go unheld.
import { spawn, type ChildProcess } from "node:child_process";

/** Starts the assertion; the returned child is killed to drop it. Swappable for tests. */
export type Spawner = () => ChildProcess;

const caffeinate: Spawner = () =>
  spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });

export class KeepAwake {
  private readonly holders = new Set<unknown>();
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | null = null;
  private disabled = false;

  constructor(
    private readonly spawner: Spawner | null = process.platform === "darwin" ? caffeinate : null,
    private readonly retryMs = 5_000,
  ) {}

  /** `holder` has a turn in flight. */
  hold(holder: unknown): void {
    this.holders.add(holder);
    this.sync();
  }

  /** `holder`'s turn is over (safe to call when it held nothing). */
  release(holder: unknown): void {
    this.holders.delete(holder);
    this.sync();
  }

  /** Holding or not, by `held`: the one call a turn's start and end both make. */
  set(holder: unknown, held: boolean): void {
    if (held) this.hold(holder);
    else this.release(holder);
  }

  get held(): boolean {
    return this.holders.size > 0;
  }

  /** Whether the assertion's process is running now. */
  get active(): boolean {
    return this.child !== null;
  }

  /** Drop everything: the daemon is going. */
  stop(): void {
    this.holders.clear();
    this.sync();
  }

  private sync(): void {
    if (this.held && !this.child) this.start();
    else if (!this.held) {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      const child = this.child;
      this.child = null;
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    }
  }

  private start(): void {
    if (!this.spawner || this.disabled || this.retry) return;
    let child: ChildProcess;
    try {
      child = this.spawner();
    } catch (err) {
      console.error("keep awake: couldn't start caffeinate:", err);
      this.disabled = true;
      return;
    }
    this.child = child;
    child.on("error", (err: NodeJS.ErrnoException) => {
      console.error("keep awake: caffeinate failed:", err.message);
      // Not there at all (not a Mac): stop trying. Anything else is retried like an exit.
      if (err.code === "ENOENT") this.disabled = true;
      this.gone(child);
    });
    child.once("exit", () => this.gone(child));
  }

  /** The assertion's process went (an exit, or an error that may come without one). */
  private gone(child: ChildProcess): void {
    if (this.child !== child) return; // stopped on purpose, or already handled
    this.child = null;
    if (!this.held || this.disabled || this.retry) return;
    // Gone while a turn still runs: start another shortly (not at once, so a caffeinate that
    // dies straight away can't spin).
    console.error("keep awake: caffeinate went mid-turn; starting another");
    this.retry = setTimeout(() => {
      this.retry = null;
      this.sync();
    }, this.retryMs);
    this.retry.unref();
  }
}
