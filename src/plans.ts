// Plan file discovery and parsing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const cfg = readRepoJson(mainRoot);
  if (!cfg) return DEFAULT_GLOBS;
  const g = cfg.plans;
  if (g === undefined) return DEFAULT_GLOBS;
  if (!Array.isArray(g) || g.some((x) => typeof x !== "string")) {
    throw new Error('.whytrail.json: "plans" must be an array of glob strings');
  }
  return g as string[];
}

/** ".whytrail.json" parsed, or null when absent; shared by every key this file reads. */
function readRepoJson(mainRoot: string): Record<string, unknown> | null {
  const cfgPath = join(mainRoot, ".whytrail.json");
  if (!existsSync(cfgPath)) return null;
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch (e) {
    throw new Error(`.whytrail.json is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  return cfg !== null && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
}

/** Default skip list: file names, or directory names with a trailing "/" (any depth). */
export const DEFAULT_SKIPS = ["INDEX.md", "CANCELLED.md", "blockers/", "assets/"];

export function skipList(mainRoot: string): string[] {
  const cfg = readRepoJson(mainRoot);
  if (!cfg || cfg.skip === undefined) return DEFAULT_SKIPS;
  const s = cfg.skip;
  if (!Array.isArray(s) || s.some((x) => typeof x !== "string")) {
    throw new Error('.whytrail.json: "skip" must be an array of strings');
  }
  return s as string[];
}

/** Order-insensitive string-array equality (plans/skip lists are sets). */
export function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.toSorted().join("\0") === b.toSorted().join("\0");
}

/** string[] narrowed from unknown JSON values, else null */
function asList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
}

/** Set or clear "plans"/"skip" in .whytrail.json. null clears the key; an array equal to the
 * stored one is a no-op; an array equal to its default clears the key; keys absent from the
 * patch stay untouched; nothing is written when the file would not change. Returns true when
 * the file was written. */
export function writeRepoPlansSkips(
  mainRoot: string,
  patch: { plans?: string[] | null; skip?: string[] | null },
): boolean {
  const cfgPath = join(mainRoot, ".whytrail.json");
  const raw = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : null;
  const cfg: Record<string, unknown> = raw !== null ? { ...readRepoJson(mainRoot) } : {};
  if (patch.plans !== undefined) {
    if (patch.plans !== null && sameSet(patch.plans, asList(cfg.plans) ?? [])) {
      // file already holds exactly this list
    } else if (patch.plans === null || sameSet(patch.plans, DEFAULT_GLOBS)) delete cfg.plans;
    else cfg.plans = patch.plans;
  }
  if (patch.skip !== undefined) {
    if (patch.skip !== null && sameSet(patch.skip, asList(cfg.skip) ?? [])) {
      // file already holds exactly this list
    } else if (patch.skip === null || sameSet(patch.skip, DEFAULT_SKIPS)) delete cfg.skip;
    else cfg.skip = patch.skip;
  }
  const next = `${JSON.stringify(cfg, null, 2)}\n`;
  // a hand-formatted file holding the same values must not be rewritten either
  const unchanged = raw !== null && JSON.stringify(cfg) === JSON.stringify(readRepoJson(mainRoot));
  if (unchanged || (raw === null && next === "{}\n")) return false;
  writeFileSync(cfgPath, next);
  return true;
}

function skipped(rel: string, skipDirs: Set<string>, skipFiles: Set<string>): boolean {
  const parts = rel.split("/");
  if (skipFiles.has(parts[parts.length - 1])) return true;
  return parts.slice(0, -1).some((d) => skipDirs.has(d));
}

export const STAMP = /(\d{8}_\d{4})/;

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
  const skips = skipList(ctx.mainRoot);
  const skipDirs = new Set(skips.filter((s) => s.endsWith("/")).map((s) => s.slice(0, -1)));
  const skipFiles = new Set(skips.filter((s) => !s.endsWith("/")));
  const seen = new Set<string>();
  const out: PlanFile[] = [];
  for (const g of globs) {
    const found = new Glob(g).scanSync({ cwd: ctx.mainRoot, onlyFiles: true });
    for (const rel of found) {
      if (seen.has(rel) || skipped(rel, skipDirs, skipFiles)) continue;
      seen.add(rel);
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
