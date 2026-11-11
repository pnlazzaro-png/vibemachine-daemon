// The repos a new session can start in: every git repository directly
// under PROJECTS_DIR (~/dev), newest commit first, for the phone's picker.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { previewSummary } from "./project.js";

const run = promisify(execFile);

export interface Project {
  name: string;
  cwd: string;
  branch: string | null;
  /** The last commit's date (ISO), when there is one. */
  last_commit: string | null;
  /** Builds get screenshots: an iPhone app the daemon found, or a .vibemachine.json. */
  preview: boolean;
}

export async function listProjects(root = config.projectsDir): Promise<Project[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(root, e.name, ".git")));
  const projects = await Promise.all(
    repos.map(async (e): Promise<Project> => {
      const cwd = path.join(root, e.name);
      const [branch, last] = await Promise.all([git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), git(cwd, "log", "-1", "--format=%cI")]);
      return { name: e.name, cwd, branch, last_commit: last, preview: previewSummary(cwd) !== null };
    }),
  );
  return projects.sort((a, b) => (b.last_commit ?? "").localeCompare(a.last_commit ?? ""));
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
