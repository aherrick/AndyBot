import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { RepoInfo } from "./state.js";

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getLastCommitUnix(repoPath: string): number {
  try {
    const val = Number(runGit(repoPath, ["log", "-1", "--format=%ct"]));
    return Number.isFinite(val) ? val : 0;
  } catch {
    return 0;
  }
}

function formatUnix(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleString() : "no commits";
}

export function getTopRepos(rootPath: string, maxCount = 15): RepoInfo[] {
  if (!fs.existsSync(rootPath)) return [];

  const repos: RepoInfo[] = [];

  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(rootPath, entry.name);
    if (!fs.existsSync(path.join(repoPath, ".git"))) continue;

    const lastCommitUnix = getLastCommitUnix(repoPath);
    repos.push({
      index: 0,
      name: entry.name,
      path: repoPath,
      lastCommitUnix,
      lastCommitText: formatUnix(lastCommitUnix),
    });
  }

  repos.sort((a, b) => b.lastCommitUnix - a.lastCommitUnix);

  return repos.slice(0, maxCount).map((repo, i) => ({ ...repo, index: i + 1 }));
}
