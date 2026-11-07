// Keeping the data folder from growing without end. Run at start and hourly from main.ts, beside the
// captures' own pruning (preview.ts). What goes, and when:
//
//   streaming deltas in the events table   after a day (a replay never shows them; most of the rows)
//   attachments sent with prompts          after 30 days (the prompt line keeps its name; the thumbnail goes)
//   the phone's crash reports              after 30 days
//   ad hoc builds under install/           all but the newest, after 14 days
//   the daemon's logs                      rolled to .1 past 10 MB, so two at most
//   image bytes in stored tool results     at once (a screenshot Claude read; the preview keeps it as a file)
//   the database's free pages              given back when they're a quarter of the file, between turns
//
// Sessions, their messages, the usage ledger and the newest screenshots are kept: they are the history.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Store } from "./db.js";
import { derivedPaths } from "./video.js";

const DAY = 24 * 60 * 60 * 1000;
export const LIVE_ONLY_KEEP_MS = DAY;
export const ATTACHMENT_KEEP_MS = 30 * DAY;
export const DIAGNOSTIC_KEEP_MS = 30 * DAY;
export const INSTALL_KEEP_MS = 14 * DAY;
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface Swept {
  images: number;
  deltas: number;
  attachments: number;
  diagnostics: number;
  builds: number;
  logs: number;
  megabytesFreed: number;
}

/** How far each store's events have been looked through for image bytes: the whole table once per start, then what's new. */
const imagesCheckedTo = new WeakMap<Store, number>();

/** Files directly in `dir` older than `keepMs`, deleted; how many. */
function sweepFiles(dir: string, keepMs: number, now: number): number {
  let n = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && now - st.mtimeMs > keepMs) {
        fs.rmSync(file, { force: true });
        n++;
      }
    } catch {
      /* gone already */
    }
  }
  return n;
}

export function sweep(store: Store, dataDir = config.dataDir, now = Date.now()): Swept {
  const { rows: images, lastSeq } = store.dropImageBytes(imagesCheckedTo.get(store) ?? 0);
  imagesCheckedTo.set(store, lastSeq);
  const deltas = store.pruneLiveOnly(new Date(now - LIVE_ONLY_KEEP_MS));

  let attachments = 0;
  for (const file of store.pruneAttachments(new Date(now - ATTACHMENT_KEEP_MS))) {
    fs.rmSync(file, { force: true });
    // A video's sheets and poster go with it.
    for (const made of derivedPaths(file)) fs.rmSync(made, { recursive: true, force: true });
    attachments++;
  }
  // A session's attachment folder left empty goes too.
  const attachDir = path.join(dataDir, "attachments");
  for (const name of safeList(attachDir)) {
    const dir = path.join(attachDir, name);
    if (safeList(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
  }

  const diagnostics = sweepFiles(path.join(dataDir, "diagnostics"), DIAGNOSTIC_KEEP_MS, now);

  // Ad hoc builds: one folder per token; the newest stays whatever its age.
  let builds = 0;
  const installDir = path.join(dataDir, "install");
  const folders = safeList(installDir)
    .map((name) => ({ dir: path.join(installDir, name), mtime: mtimeOf(path.join(installDir, name)) }))
    .filter((f) => f.mtime !== null)
    .sort((a, b) => b.mtime! - a.mtime!);
  for (const f of folders.slice(1)) {
    if (now - f.mtime! > INSTALL_KEEP_MS) {
      fs.rmSync(f.dir, { recursive: true, force: true });
      builds++;
    }
  }

  // Logs: launchd holds them open for appending, so the big one is copied to .1 and emptied in place.
  let logs = 0;
  const logDir = path.join(dataDir, "logs");
  for (const name of safeList(logDir).filter((n) => n.endsWith(".log"))) {
    const file = path.join(logDir, name);
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.copyFileSync(file, `${file}.1`);
        fs.truncateSync(file, 0);
        logs++;
      }
    } catch {
      /* gone */
    }
  }

  // Last, so what the steps above let go is given back to the disk.
  const megabytesFreed = Math.round(store.compact() / (1024 * 1024));
  return { images, deltas, attachments, diagnostics, builds, logs, megabytesFreed };
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeOf(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
