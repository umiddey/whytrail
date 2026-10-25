// whytrail code <plan-id|path> — the commits and files that plan changed, in time order.

import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { gitOut } from "./git";
import type { RepoCtx } from "./git";
import { findPlan } from "./plans";
import type { PlanFile } from "./plans";
import { commitIndex, shortSha } from "./commits";

export type CodeFile = { status: string; path: string };

export type CodeCommit = {
  sha: string;
  date: string;
  subject: string;
  files: CodeFile[];
};

export type CodeResult = {
  id: string;
  path: string | null;
  date: string | null;
  title: string | null;
  goal: string | null;
  commits: CodeCommit[];
};

/**
 * A plan id, or a path to the plan file (relative to cwd or to the main
 * checkout). A file path resolves to its basename without .md.
 */
export function resolvePlanId(arg: string, ctx: RepoCtx): string {
  for (const base of [ctx.cwd, ctx.mainRoot]) {
    const abs = join(base, arg);
    if (existsSync(abs) && statSync(abs).isFile()) {
      return basename(arg).replace(/\.md$/, "");
    }
  }
  return arg.replace(/\.md$/, "");
}

export function commitFiles(ctx: RepoCtx, sha: string): CodeFile[] {
  const out = gitOut(["show", "--name-status", "--format=%x1e", sha], ctx.cwd);
  const files: CodeFile[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t || t === "\u001e") continue;
    const i = line.indexOf("\t");
    if (i < 0) continue;
    files[files.length] = { status: line.slice(0, i), path: line.slice(i + 1) };
  }
  return files;
}

export function codeResult(ctx: RepoCtx, plans: PlanFile[], arg: string): CodeResult {
  const id = resolvePlanId(arg, ctx);
  const p: PlanFile | null = findPlan(plans, id);
  const index = commitIndex(ctx.cwd);
  const commits: CodeCommit[] = [];
  for (let i = index.length - 1; i >= 0; i--) {
    // git log is newest first; walk backwards for time order
    const c = index[i];
    if (!c.plans.includes(id)) continue;
    commits[commits.length] = {
      sha: c.sha,
      date: c.date,
      subject: c.subject,
      files: commitFiles(ctx, c.sha),
    };
  }
  return {
    id,
    path: p ? p.path : null,
    date: p ? p.date : null,
    title: p ? p.title : null,
    goal: p ? p.goal : null,
    commits,
  };
}

export function codeHuman(r: CodeResult): string {
  const lines: string[] = [];
  if (!r.path) lines[lines.length] = "(plan file not found)";
  lines[lines.length] = `${r.date ?? "(no date)"}  ${r.id}`;
  if (r.title) lines[lines.length] = `  ${r.title}`;
  if (r.goal) lines[lines.length] = `  Goal: ${r.goal}`;
  if (r.path) lines[lines.length] = `  plan: ${r.path}`;
  if (r.commits.length === 0) {
    lines[lines.length] = "  (no commits carry this plan)";
    return lines.join("\n") + "\n";
  }
  lines[lines.length] = "  commits (oldest first):";
  for (const c of r.commits) {
    lines[lines.length] = `    ${shortSha(c.sha)} ${c.date} ${c.subject}`;
    for (const f of c.files) {
      lines[lines.length] = `      ${f.status}\t${f.path}`;
    }
  }
  return lines.join("\n") + "\n";
}
