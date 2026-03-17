import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { RepoInfo } from "./state.js";

function getLastCommitUnix(repoPath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoPath, "log", "-1", "--format=%ct"],
      { encoding: "utf8" },
      (err, stdout) => {
        if (err) return resolve(0);
        const val = Number(stdout.trim());
        resolve(Number.isFinite(val) ? val : 0);
      }
    );
  });
}

function formatUnix(unix: number): string {
  return unix ? new Date(unix * 1000).toLocaleString() : "no commits";
}

export async function getTopRepos(rootPath: string, maxCount = 15): Promise<RepoInfo[]> {
  if (!fs.existsSync(rootPath)) return [];

  const entries = fs
    .readdirSync(rootPath, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootPath, e.name, ".git")));

  const repos = await Promise.all(
    entries.map(async (e) => {
      const repoPath = path.join(rootPath, e.name);
      const lastCommitUnix = await getLastCommitUnix(repoPath);
      return {
        index: 0,
        name: e.name,
        path: repoPath,
        lastCommitUnix,
        lastCommitText: formatUnix(lastCommitUnix),
      };
    })
  );

  repos.sort((a, b) => b.lastCommitUnix - a.lastCommitUnix);

  return repos.slice(0, maxCount).map((repo, i) => ({ ...repo, index: i + 1 }));
}
