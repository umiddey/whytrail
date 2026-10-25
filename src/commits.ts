// Commit index: every commit on HEAD with its Plan: trailers, newest first.

import { gitOut } from "./git";

export type Commit = {
  sha: string;
  /** author date, ISO-8601 strict */
  date: string;
  subject: string;
  /** Plan: trailer values, several allowed */
  plans: string[];
};

const US = "\u001f";
const LOG_FORMAT = "%H%x1f%ad%x1f%s%x1f%(trailers:key=Plan,valueonly)";

/**
 * One `git log --format=...%(trailers:key=Plan,valueonly)` pass over HEAD.
 * Lines look like: <sha>\x1f<date>\x1f<subject>\x1f[<first trailer>]
 * with further trailer values on their own lines after it.
 */
export function commitIndex(cwd: string): Commit[] {
  const out = gitOut(["log", `--format=${LOG_FORMAT}`, "--date=iso-strict"], cwd);
  const commits: Commit[] = [];
  let cur: Commit | null = null;
  for (const line of out.split("\n")) {
    const i1 = line.indexOf(US);
    if (i1 < 0) {
      // continuation line: another Plan: trailer of the current commit
      const v = line.trim();
      if (cur && v) cur.plans[cur.plans.length] = v;
      continue;
    }
    const i2 = line.indexOf(US, i1 + 1);
    const i3 = line.indexOf(US, i2 + 1);
    cur = {
      sha: line.slice(0, i1),
      date: line.slice(i1 + 1, i2),
      subject: i3 >= 0 ? line.slice(i2 + 1, i3) : line.slice(i2 + 1),
      plans: [],
    };
    const first = i3 >= 0 ? line.slice(i3 + 1).trim() : "";
    if (first) cur.plans[cur.plans.length] = first;
    commits[commits.length] = cur;
  }
  return commits;
}

/** sha -> commit, for lookup */
export function commitBySha(commits: Commit[]): Record<string, Commit> {
  const bySha: Record<string, Commit> = {};
  for (const c of commits) bySha[c.sha] = c;
  return bySha;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
