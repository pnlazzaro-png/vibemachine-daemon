// Entry point: open the store, bring up the session index, serve.
import { config } from "./config.js";
import { Store } from "./db.js";
import { sweep } from "./housekeeping.js";
import { pruneCaptures, pruneOriginals } from "./preview.js";
import { startServer } from "./server.js";
import { SessionManager } from "./sessions.js";
import { UsageLedger } from "./usage.js";

const store = new Store();
const sessions = new SessionManager(store);
const ledger = new UsageLedger(store);
const server = startServer(store, sessions, ledger);
ledger.start();
// Screenshots are kept a week (each screen's newest always, as the next turn's before), and any
// full-resolution originals left from before the phone got small JPEGs a few days; checked at start and hourly.
const prune = (): void => {
  try {
    const captures = pruneCaptures(store);
    const originals = pruneOriginals();
    if (captures + originals > 0) console.log(`captures: pruned ${captures} capture(s) and ${originals} original(s) past their keep`);
  } catch (err) {
    console.error("captures: prune failed:", err);
  }
  // The rest of the data folder (housekeeping.ts says what goes when).
  try {
    const s = sweep(store);
    const said = Object.entries(s).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}`);
    if (said.length > 0) console.log(`housekeeping: ${said.join(", ")}`);
  } catch (err) {
    console.error("housekeeping failed:", err);
  }
};
prune();
const pruning = setInterval(prune, 60 * 60 * 1000);
pruning.unref();

console.log(`claude: ${config.claudeBin}; model: ${config.defaultModel || "(Claude Code default)"}; permission mode: ${config.defaultPermissionMode}`);

function shutdown(signal: string): void {
  console.log(`${signal}: closing`);
  sessions.shutdown();
  ledger.stop();
  server.close();
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 500).unref();
}
// Every session on the phone is a child of this process, so dying takes every running turn with
// it. An error nobody caught (a full disk under a write, a handler's bug) is said in the log and
// the daemon carries on: the turn it came from may be the worse for it, the others are not.
process.on("unhandledRejection", (reason) => console.error("unhandled rejection (carrying on):", reason));
process.on("uncaughtException", (err) => console.error("uncaught exception (carrying on):", err));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
