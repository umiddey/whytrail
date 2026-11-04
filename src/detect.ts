// Propose plan folders and skips for `whytrail setup` from the tracked file list.

import { basename } from "node:path";
import { STAMP } from "./plans";

const MIN_STAMPED = 3;

export type DetectedFolders = {
  // proposed plan globs: "<root>/**/*.md" for every root holding >= 3 stamped files
  globs: string[];
  /** proposed skips: "<name>/" for first-level folders inside a proposed root holding .md but no stamped file */
  skips: string[];
  /** stamped folders with no "plan" segment (docs/memory excluded: memory-log source), with counts */
  other: { folder: string; count: number }[];
};

/** Pure detection over a tracked-file list (git ls-files of the main checkout): no git, no fs. */
export function detectPlanFolders(files: string[]): DetectedFolders {
  const stampedMd: string[] = [];
  const anyMd: string[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    anyMd[anyMd.length] = f;
    if (STAMP.test(basename(f))) stampedMd[stampedMd.length] = f;
  }
  const rootStamps = new Map<string, string[]>();
  const otherCount = new Map<string, number>();
  for (const f of stampedMd) {
    if (f.startsWith("docs/memory/")) continue; // memory-log source, never a plan folder
    const parts = f.split("/");
    const pi = parts.slice(0, -1).findIndex((seg) => /plan/i.test(seg));
    if (pi < 0) {
      const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      otherCount.set(folder, (otherCount.get(folder) ?? 0) + 1);
      continue;
    }
    const root = parts.slice(0, pi + 1).join("/");
    const bucket = rootStamps.get(root);
    if (bucket) bucket[bucket.length] = f;
    else rootStamps.set(root, [f]);
  }
  const globs: string[] = [];
  const skips = new Set<string>();
  for (const [root, stamps] of rootStamps) {
    if (stamps.length < MIN_STAMPED) continue;
    globs[globs.length] = `${root}/**/*.md`;
    const firstSegs = new Set<string>();
    for (const f of anyMd) {
      if (!f.startsWith(`${root}/`)) continue;
      const rest = f.slice(root.length + 1);
      const slash = rest.indexOf("/");
      if (slash > 0) firstSegs.add(rest.slice(0, slash));
    }
    for (const seg of [...firstSegs].toSorted()) {
      const prefix = `${root}/${seg}/`;
      const hasStamped = stamps.some((f) => f.startsWith(prefix));
      if (!hasStamped) skips.add(`${seg}/`);
    }
  }
  return {
    globs: globs.toSorted(),
    skips: [...skips].toSorted(),
    other: [...otherCount.entries()]
      .map(([folder, count]) => ({ folder, count }))
      .toSorted((a, b) => (a.folder < b.folder ? -1 : 1)),
  };
}
