// Telling a command that runs a release script from one that only names it: shared by the
// preview's pipeline lines (preview.ts) and the turn's Live Activity (turnactivity.ts), which is
// kept free of imports beyond this.

/**
 * The repo's release scripts, `ios/scripts/testflight.sh` and `adhoc.sh` (an archive and an upload in
 * one command), when a step of the command runs one: as its program, or through a shell. Naming the
 * script isn't running it: `pgrep -f testflight.sh`, `cat … testflight.sh` or a log path once
 * counted as an upload and lit the flight lamp.
 */
export function isReleaseScript(command: string | undefined): boolean {
  if (!command) return false;
  const script = /^(?:\S*\/)?(testflight|adhoc)\.sh$/;
  for (const step of command.split(/&&|\|\||[;|\n]/)) {
    const words = step.trim().replace(/^[({]\s*/, "").split(/\s+/).filter((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    while (words[0] && ["time", "exec", "nohup", "command"].includes(words[0])) words.shift();
    const [first = "", second = ""] = words.map((w) => w.replace(/^["'(]+|["')}&]+$/g, ""));
    if (script.test(first)) return true;
    if (/^(?:\S*\/)?(ba|z)?sh$/.test(first) && script.test(second)) return true;
  }
  return false;
}
