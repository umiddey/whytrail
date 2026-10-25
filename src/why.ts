// whytrail why <file>[:from[-to]] — every plan behind those lines, oldest first.

import { gitOut } from "./git";
import type { RepoCtx } from "./git";
import type { PlanFile } from "./plans";
import { commitIndex, commitBySha, shortSha } from "./commits";
import type { Link } from "./write-side";
import type { Commit } from "./commits";

export type WhyTarget = {
  file: string;
  from: number | null;
  to: number | null;
};

/** "src/a.ts", "src/a.ts:3", "src/a.ts:3-9" */
export function parseWhyTarget(arg: string): WhyTarget {
  const m = arg.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!m) return { file: arg, from: null, to: null };
  const from = Number(m[2]);
  return { file: m[1], from, to: m[3] ? Number(m[3]) : from };
}

export type CommitRef = { sha: string; date: string; subject: string };

export type WhyPlanGroup = {
  id: string;
  path: string | null;
  date: string | null;
  title: string | null;
  goal: string | null;
  commits: (CommitRef & { source?: string })[];
};

export type WhyResult = {
  file: string;
  from: number | null;
  to: number | null;
  plans: WhyPlanGroup[];
  unlinked: CommitRef[];
};

/** commits that last touched the given lines (unique, in line order) */
function blameShas(ctx: RepoCtx, t: WhyTarget): string[] {
  const out = gitOut(
    ["blame", "--line-porcelain", "-L", `${t.from},${t.to}`, "--", t.file],
    ctx.cwd,
  );
  const shas: string[] = [];
  const seen: Record<string, true> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^([0-9a-f]{40})\s/);
    if (!m || seen[m[1]]) continue;
    seen[m[1]] = true;
    shas[shas.length] = m[1];
  }
  return shas;
}

/** every commit that ever touched the file, following renames (newest first) */
function followShas(ctx: RepoCtx, file: string): string[] {
  const out = gitOut(["log", "--follow", "--format=%H", "--", file], ctx.cwd);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{40}$/.test(s));
}

function sortRefs(refs: CommitRef[]): CommitRef[] {
  return refs.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.sha < b.sha ? -1 : 1;
  });
}

export function whyResult(ctx: RepoCtx, plans: PlanFile[], t: WhyTarget, extraLinks: Link[] = []): WhyResult {
  const bySha = commitBySha(commitIndex(ctx.cwd));

  const shas = t.from !== null ? blameShas(ctx, t) : followShas(ctx, t.file);

  const groups: Record<string, (CommitRef & { source?: string })[]> = {};
  const unlinked: CommitRef[] = [];
  for (const sha of shas) {
    const c: Commit | undefined = bySha[sha];
    const ref: CommitRef = { sha, date: c?.date ?? "", subject: c?.subject ?? "" };
    if (c && c.plans.length > 0) {
      for (const pid of c.plans) {
        const list = groups[pid] ?? [];
        list[list.length] = ref;
        groups[pid] = list;
      }
    }
    for (const link of extraLinks) {
      if (link.commit !== sha || c?.plans.includes(link.plan)) continue;
      const list = groups[link.plan] ?? [];
      list[list.length] = { ...ref, source: link.source };
      groups[link.plan] = list;
    }
    if (!c || (c.plans.length === 0 && !extraLinks.some((l) => l.commit === sha))) unlinked[unlinked.length] = ref;
  }

  const byId: Record<string, PlanFile> = {};
  for (const p of plans) byId[p.id] = p;

  const result: WhyResult = {
    file: t.file,
    from: t.from,
    to: t.to,
    plans: [],
    unlinked: sortRefs(unlinked),
  };
  for (const pid of Object.keys(groups)) {
    const p = byId[pid];
    result.plans[result.plans.length] = {
      id: pid,
      path: p ? p.path : null,
      date: p ? p.date : null,
      title: p ? p.title : null,
      goal: p ? p.goal : null,
      commits: sortRefs(groups[pid]),
    };
  }
  result.plans.sort((a, b) => {
    const da = a.date ?? "9999";
    const db = b.date ?? "9999";
    if (da !== db) return da < db ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return result;
}

export function whyHuman(r: WhyResult): string {
  const lines: string[] = [];
  const where =
    r.from !== null ? `${r.file}:${r.from}${r.to !== r.from ? `-${r.to}` : ""}` : r.file;
  lines[lines.length] = where;
  if (r.plans.length === 0 && r.unlinked.length === 0) {
    lines[lines.length] = "  (no commits found)";
    return lines.join("\n") + "\n";
  }
  for (const p of r.plans) {
    lines[lines.length] = "";
    lines[lines.length] = `${p.date ?? "(no date)"}  ${p.id}`;
    if (p.title) lines[lines.length] = `  ${p.title}`;
    if (p.goal) lines[lines.length] = `  Goal: ${p.goal}`;
    lines[lines.length] = `  plan: ${p.path ?? "(plan file not found)"}`;
    for (const c of p.commits) {
      lines[lines.length] = `    ${shortSha(c.sha)} ${c.date} ${c.subject}${c.source ? ` [${c.source}]` : ""}`;
    }
  }
  if (r.unlinked.length > 0) {
    lines[lines.length] = "";
    lines[lines.length] = "(no Plan trailer)";
    for (const c of r.unlinked) {
      lines[lines.length] = `    ${shortSha(c.sha)} ${c.date} ${c.subject}`;
    }
  }
  return lines.join("\n") + "\n";
}
