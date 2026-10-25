// whytrail code <plan-id|path> — commits and files associated with a plan.

import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { gitOut } from "./git";
import type { RepoCtx } from "./git";
import { findPlan } from "./plans";
import type { PlanFile } from "./plans";
import { commitIndex, shortSha } from "./commits";
import type { Link } from "./write-side";

export type CodeFile = { status: string; path: string };
export type CodeCommit = { sha: string; date: string; subject: string; source?: string; files: CodeFile[] };
export type CodeResult = { id: string; path: string | null; date: string | null; title: string | null; goal: string | null; commits: CodeCommit[] };

export function resolvePlanId(arg: string, ctx: RepoCtx): string {
  for (const base of [ctx.cwd, ctx.mainRoot]) {
    const abs = join(base, arg);
    if (existsSync(abs) && statSync(abs).isFile()) return basename(arg).replace(/\.md$/, "");
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
    if (i >= 0) files[files.length] = { status: line.slice(0, i), path: line.slice(i + 1) };
  }
  return files;
}

export function codeResult(ctx: RepoCtx, plans: PlanFile[], arg: string, extraLinks: Link[] = []): CodeResult {
  const id = resolvePlanId(arg, ctx);
  const p: PlanFile | null = findPlan(plans, id);
  const index = commitIndex(ctx.cwd);
  const commits: CodeCommit[] = [];
  for (let i = index.length - 1; i >= 0; i--) {
    const c = index[i];
    const link = extraLinks.find((l) => l.commit === c.sha && l.plan === id);
    if (!c.plans.includes(id) && !link) continue;
    commits[commits.length] = { sha: c.sha, date: c.date, subject: c.subject, ...(link ? { source: link.source } : {}), files: commitFiles(ctx, c.sha) };
  }
  return { id, path: p?.path ?? null, date: p?.date ?? null, title: p?.title ?? null, goal: p?.goal ?? null, commits };
}

export function codeHuman(r: CodeResult): string {
  const lines: string[] = [];
  if (!r.path) lines[lines.length] = "(plan file not found)";
  lines[lines.length] = `${r.date ?? "(no date)"}  ${r.id}`;
  if (r.title) lines[lines.length] = `  ${r.title}`;
  if (r.goal) lines[lines.length] = `  Goal: ${r.goal}`;
  if (r.path) lines[lines.length] = `  plan: ${r.path}`;
  if (r.commits.length === 0) { lines[lines.length] = "  (no commits carry this plan)"; return lines.join("\n") + "\n"; }
  lines[lines.length] = "  commits (oldest first):";
  for (const c of r.commits) {
    lines[lines.length] = `    ${shortSha(c.sha)} ${c.date} ${c.subject}${c.source ? ` [${c.source}]` : ""}`;
    for (const f of c.files) lines[lines.length] = `      ${f.status}\t${f.path}`;
  }
  return lines.join("\n") + "\n";
}
