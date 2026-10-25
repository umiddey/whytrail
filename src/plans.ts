// Plan file discovery and parsing.

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { Glob } from "bun";
import type { RepoCtx } from "./git";

export const DEFAULT_GLOBS = ["docs/plans/**/*.md"];

export type PlanFile = {
  /** basename without .md, e.g. 20261025_1440_whytrail_v1 */
  id: string;
  /** path relative to the main checkout, "/" separators */
  path: string;
  absPath: string;
  title: string | null;
  /** "YYYY-MM-DD HH:MM" from the YYYYMMDD_HHMM stamp in the file name */
  date: string | null;
  /** first non-empty line after a Goal heading */
  goal: string | null;
};

export function planGlobs(mainRoot: string): string[] {
  const cfgPath = join(mainRoot, ".whytrail.json");
  if (!existsSync(cfgPath)) return DEFAULT_GLOBS;
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e) {
    throw new Error(`.whytrail.json is not valid JSON: ${(e as Error).message}`);
  }
  let g: unknown;
  if (cfg !== null && typeof cfg === "object" && "plans" in cfg) {
    g = cfg.plans;
  }
  if (g === undefined) return DEFAULT_GLOBS;
  if (!Array.isArray(g) || g.some((x) => typeof x !== "string")) {
    throw new Error('.whytrail.json: "plans" must be an array of glob strings');
  }
  return g as string[];
}

function skipped(rel: string): boolean {
  const parts = rel.split("/");
  const file = parts[parts.length - 1];
  if (file === "INDEX.md" || file === "CANCELLED.md") return true;
  const dirs = parts.slice(0, -1);
  return dirs.includes("blockers") || dirs.includes("assets");
}

const STAMP = /(\d{8}_\d{4})/;

export function stampToDate(id: string): string | null {
  const m = id.match(STAMP);
  if (!m) return null;
  const s = m[1];
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)}`;
}

export function firstHeadingTitle(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

export function firstGoalLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s+goal\b/i.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (/^#{1,6}\s/.test(t)) break; // next heading, no goal text
      return t;
    }
    break;
  }
  return null;
}

export function planFromFile(mainRoot: string, rel: string, text: string): PlanFile {
  const id = basename(rel).replace(/\.md$/, "");
  return {
    id,
    path: rel,
    absPath: join(mainRoot, rel),
    title: firstHeadingTitle(text),
    date: stampToDate(id),
    goal: firstGoalLine(text),
  };
}

function cmpDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // no date goes last
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export function discoverPlans(ctx: RepoCtx): PlanFile[] {
  const globs = planGlobs(ctx.mainRoot);
  const seen: Record<string, true> = {};
  const out: PlanFile[] = [];
  for (const g of globs) {
    const found = new Glob(g).scanSync({ cwd: ctx.mainRoot, onlyFiles: true });
    for (const rel of found) {
      if (seen[rel] || skipped(rel)) continue;
      seen[rel] = true;
      let text = "";
      try {
        text = readFileSync(join(ctx.mainRoot, rel), "utf8");
      } catch {
        continue; // vanished between scan and read
      }
      out[out.length] = planFromFile(ctx.mainRoot, rel, text);
    }
  }
  out.sort((a, b) => {
    const d = cmpDate(a.date, b.date);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : 1;
  });
  return out;
}

export function findPlan(plans: PlanFile[], id: string): PlanFile | null {
  for (const p of plans) if (p.id === id) return p;
  return null;
}
