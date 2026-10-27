import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOut, git } from "./git";
import type { RepoCtx } from "./git";
import type { PlanFile } from "./plans";

export type LinkSource = "trailer" | "co-commit" | "memory-log" | "progress-sha" | "branch" | "date-files" | "cited-path" | "semantic" | "review";
export type LinkDecision = "accept" | "reject";
export type Link = { commit: string; plan: string; source: LinkSource; confidence: "high" | "medium" | "low" | "review"; decision?: LinkDecision; files?: string[] };
function linkFile(root: string): string { return join(root, ".whytrail", "links.jsonl"); }
function mainRoot(cwd: string): string { const common=gitOut(["rev-parse","--path-format=absolute","--git-common-dir"],cwd).trim();return common.replace(/\/\.git$/,"").replace(/\/$/,""); }
function readLinks(root: string): Link[] { const path=linkFile(root);if(!existsSync(path))return [];return readFileSync(path,"utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x) as Link); }
const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));
function hooksDir(cwd: string): string { const configured=git(["config","--path","core.hooksPath"],cwd);if(configured.code===0&&configured.stdout.trim())return resolve(cwd,configured.stdout.trim());return resolve(cwd,gitOut(["rev-parse","--git-path","hooks"],cwd).trim()); }
const PREPARE = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const [msg, source] = process.argv.slice(2);
const chained = join(import.meta.dir, "prepare-commit-msg.whytrail-chained");
if (await Bun.file(chained).exists()) { const r=spawnSync(chained,[msg,source],{stdio:"inherit"}); if ((r.status ?? 1)!==0) process.exit(r.status ?? 1); }
let id=process.env.WHYTRAIL_PLAN;
if(id==="undefined"||id==="null")id=undefined;
if (!id) { const branch=spawnSync("git",["branch","--show-current"],{encoding:"utf8"}).stdout.trim(); const root=spawnSync("git",["rev-parse","--show-toplevel"],{encoding:"utf8"}).stdout.trim(); const plans=spawnSync("bun",[${JSON.stringify(CLI_PATH)},"_plan-branches"],{cwd:root,encoding:"utf8"}); if(plans.status===0){const matches=plans.stdout.split("\\n").filter(x=>x.endsWith("\\t"+branch));if(matches.length===1){const planId=matches[0].split("\\t")[0];if(planId&&planId!=="undefined"&&planId!=="null")id=planId;}}}
if(!id)process.exit(0);
const text=readFileSync(msg,"utf8"), paragraphs=text.trimEnd().split(/\\r?\\n[ \\t]*\\r?\\n/), trailerBlock=paragraphs.at(-1)??"";
if(/^Plan:\\s*\\S/im.test(trailerBlock))process.exit(0);
const lines=text.replace(/\\s*$/,"").split("\\n"); let start=lines.length-1; while(start>=0&&lines[start].trim())start--; const trailer=/^[A-Za-z0-9-]+:\\s*\\S/.test(lines[start+1]??""); if(trailer)lines.splice(start+1,0,"Plan: "+id);else{lines[lines.length]="";lines[lines.length]="Plan: "+id;} writeFileSync(msg,lines.join("\\n")+"\\n");
`;
const COMMIT = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const msg=process.argv[2];
const chained=join(import.meta.dir,"commit-msg.whytrail-chained");
if (await Bun.file(chained).exists()) { const r=spawnSync(chained,[msg],{stdio:"inherit"}); if ((r.status ?? 1)!==0) process.exit(r.status ?? 1); }
const text=readFileSync(msg,"utf8"), subject=text.split(/\\r?\\n/,1)[0]??"";
if(/^Merge\\s/.test(subject)||/^Revert\\s/.test(subject)||/^(?:fixup|squash)!\\s/.test(subject))process.exit(0);
const paragraphs=text.trimEnd().split(/\\r?\\n[ \\t]*\\r?\\n/), trailerBlock=paragraphs.at(-1)??"";
const trailers=trailerBlock.split(/\\r?\\n/).filter(line=>/^Plan:\\s*/i.test(line));
if(trailers.some(line=>/^Plan:\\s*none\\s*-\\s*\\S/i.test(line)||(/^Plan:\\s*\\S/i.test(line)&&!/^Plan:\\s*none(\\s|$)/i.test(line))))process.exit(0);
console.error("whytrail: commit needs a Plan: <id> trailer or 'Plan: none - <reason>'");process.exit(1);
`;
export function install(ctx: RepoCtx): void {
 const dir=hooksDir(ctx.cwd);mkdirSync(dir,{recursive:true});
 for(const [name,body] of [["prepare-commit-msg",PREPARE],["commit-msg",COMMIT]] as const){const target=join(dir,name),chained=target+".whytrail-chained";if(existsSync(target)&&readFileSync(target,"utf8").includes("whytrail-hook-v1"))continue;if(existsSync(target)&&!existsSync(chained))copyFileSync(target,chained);const [shebang,...script]=body.split("\n");writeFileSync(target,`${shebang}\n// whytrail-hook-v1\n${script.join("\n")}`);chmodSync(target,0o755);}
}
export function uninstall(ctx: RepoCtx): void {const dir=hooksDir(ctx.cwd);for(const name of ["prepare-commit-msg","commit-msg"]){const target=join(dir,name),chained=target+".whytrail-chained";if(!existsSync(target)||!readFileSync(target,"utf8").includes("whytrail-hook-v1"))continue;if(existsSync(chained)){copyFileSync(chained,target);unlinkSync(chained);}else unlinkSync(target);}}
export function branchPlans(plans: PlanFile[]): string {const out:string[]=[];for(const p of plans){let text="";try{text=readFileSync(p.absPath,"utf8");}catch{continue;}const branch=text.match(/^Branch:\s*(.+?)\s*$/m)?.[1];if(branch)out[out.length]=`${p.id}\t${branch}`;}return out.join("\n");}
function planDate(plan:PlanFile):number|null{if(!plan.date)return null;const value=Date.parse(plan.date.replace(" ","T")+":00Z");return Number.isFinite(value)?value:null;}
function commitPaths(cwd:string,sha:string):string[]{return gitOut(["diff-tree","--root","--no-commit-id","--name-only","-r",sha],cwd).split(/\r?\n/).filter(Boolean);}
function codeFiles(cwd: string, sha: string): string[] {
  return gitOut(["show", "--name-only", "--format=", sha], cwd).split(/\r?\n/).filter((path) => path && !path.endsWith(".md")).sort();
}
function commitInfo(cwd:string,sha:string):{date:string;subject:string;trailers:string[]}{const fields=gitOut(["show","-s","--format=%aI%x1f%s%x1f%(trailers:key=Plan,valueonly)",sha],cwd).trimEnd().split("\x1f");return {date:fields[0]??"",subject:fields[1]??"",trailers:(fields[2]??"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean)};}
function citedPaths(text:string):string[]{const found:string[]=[];let active=false;for(const line of text.split(/\r?\n/)){if(/^#{1,6}\s*(FILES MODIFIED|Files changed|Files)\s*$/i.test(line.trim())){active=true;continue;}if(active&&/^#{1,6}\s/.test(line))break;if(active){for(const m of line.matchAll(/(?:^|[\s`])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/g))found[found.length]=m[1];}}return [...new Set(found)];}
export function planCodePaths(text:string):string[]{const found:string[]=[];for(const line of text.split(/\r?\n/)){for(const m of line.matchAll(/(?:^|[\s`])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/g)){const p=m[1];if(!p.endsWith(".md"))found[found.length]=p;}}return [...new Set(found)];}
/** Read-only: compute the links a backfill would add, without writing anything. Used by backfill and by the P3 real-repo hand-check. */
export function backfillPreview(ctx:RepoCtx,plans:PlanFile[],opts:{dryRun:boolean;since?:string}):{added:Link[];old:Link[]}{
 const root=mainRoot(ctx.cwd),old=readLinks(root),protectedLinks=old.filter(x=>x.source==="review"),existing=new Set(old.map(x=>`${x.commit}\0${x.plan}`)),shas=gitOut(["rev-list","--reverse","--all"],ctx.cwd).split(/\r?\n/).filter(Boolean),added:Link[]=[],texts:Record<string,string>={};
 for(const p of plans){try{texts[p.id]=readFileSync(p.absPath,"utf8");}catch{}}
 const memoryPaths:Record<string,string[]>={};
 for(const plan of plans){const path=join(root,"docs","memory",`${plan.id}.md`);if(existsSync(path))memoryPaths[plan.id]=citedPaths(readFileSync(path,"utf8"));}
 const branchLinks:Record<string,Set<string>>={};
 const branchFor:Record<string,string>={};
 for(const plan of plans){const branch=texts[plan.id]?.match(/^Branch:\s*(.+?)\s*$/m)?.[1];if(branch)branchFor[plan.id]=branch;}
 for(const row of gitOut(["log","--all","--merges","--format=%H%x09%s"],ctx.cwd).split(/\r?\n/)){
  const [sha,subject]=row.split("\t");if(!sha||!subject)continue;
  for(const [planId,branch] of Object.entries(branchFor)){
   if(subject!==`Merge branch '${branch}'`&&!subject.startsWith(`Merge branch '${branch}' `))continue;
   const parents=gitOut(["rev-list","--parents","-n","1",sha],ctx.cwd).trim().split(/\s+/).slice(1);
   if(parents.length<2)continue;
   const commits=gitOut(["rev-list",parents[1],`^${parents[0]}`],ctx.cwd).split(/\r?\n/).filter(Boolean);
   commits.push(sha);
   branchLinks[planId]??=new Set();
   for(const commit of commits)branchLinks[planId].add(commit);
  }
 }
 const storedWindows=readStoredWindows(root);
 const since=opts.since?Date.parse(opts.since):Number.NEGATIVE_INFINITY;
 const citedCandidates:{sha:string;plan:PlanFile;timestamp:number;text:string}[]=[];
 const codeCache: Record<string, string[]> = {};
 for(const sha of shas){const meta=commitInfo(ctx.cwd,sha);if(Date.parse(meta.date)<since)continue;const files=commitPaths(ctx.cwd,sha),timestamp=Date.parse(meta.date),hasCode=files.some(f=>!f.endsWith(".md"));for(const plan of plans){if(existing.has(`${sha}\0${plan.id}`)||protectedLinks.some(l=>l.commit===sha&&l.plan===plan.id))continue;const text=texts[plan.id]??"";let source:LinkSource|undefined;let confidence:Link["confidence"]|undefined;
  if(meta.trailers.includes(plan.id)){source="trailer";confidence="high";}else if(files.includes(plan.path)&&files.length>1){source="co-commit";confidence=files.length>100?"low":"high";}else if(planDate(plan)!==null&&timestamp>=(planDate(plan) as number)&&files.some(f=>(memoryPaths[plan.id]??[]).includes(f))){source="memory-log";confidence="medium";}else if(new RegExp(`\\b${sha.slice(0,7)}[0-9a-f]{0,33}\\b`,"i").test(text)){source="progress-sha";confidence="high";}else if(branchLinks[plan.id]?.has(sha)){source="branch";confidence="high";}else{const date=plan.date?.slice(0,10);const cited=files.some(f=>!f.endsWith(".md")&&planCodePaths(text).includes(f));if(date&&new Date(timestamp).toISOString().slice(0,10)===date&&hasCode&&cited){source="date-files";confidence="low";}else if(cited)citedCandidates[citedCandidates.length]={sha,plan,timestamp,text};}
  if(source&&confidence)added[added.length]={commit:sha,plan:plan.id,source,confidence,files:codeCache[sha]??(codeCache[sha]=codeFiles(ctx.cwd,sha))};
 }}
 const measured=windowsFor(ctx,plans,[...old,...added]);
 const citedDays={beforeDays:measured.plan_before_code_days??storedWindows?.plan_before_code_days??FALLBACK_BEFORE_DAYS,afterDays:measured.plan_after_code_days??storedWindows?.plan_after_code_days??FALLBACK_AFTER_DAYS};
 for(const row of citedCandidates){if(citedPathInWindow(row.timestamp,row.plan,row.text,citedDays))added[added.length]={commit:row.sha,plan:row.plan.id,source:"cited-path",confidence:"medium",files:codeCache[row.sha]??(codeCache[row.sha]=codeFiles(ctx.cwd,row.sha))};}
 return {added,old};
}
export function backfill(ctx:RepoCtx,plans:PlanFile[],opts:{dryRun:boolean;since?:string}):string{
 const root=mainRoot(ctx.cwd),{added,old}=backfillPreview(ctx,plans,opts);
 const windows=windowsFor(ctx,plans,[...old,...added]);
 const totals:Record<string,number>={};for(const l of [...old,...added]){const key=`${l.source} ${l.confidence}`;totals[key]=(totals[key]??0)+1;}
 const summary=[`new links: ${added.length}`,...Object.keys(totals).sort().map(k=>`${k}: ${totals[k]}`),formatWindows(windows)];
 if(!opts.dryRun){
  const path=linkFile(root);
  const cache:Record<string,string[]>={};
  let changed=false;
  const kept=old.map((row)=>{if(Array.isArray(row.files))return row;changed=true;const files=cache[row.commit]??(cache[row.commit]=codeFiles(ctx.cwd,row.commit));return {...row,files};});
  if(added.length||changed){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,[...kept,...added].map(l=>JSON.stringify(l)).join("\n")+"\n");}
  writeWindows(root,windows);
 }
 return summary.join("\n")+"\n";
}
export function review(ctx:RepoCtx,_plans:PlanFile[],decision?:{accept:boolean;sha:string;plan:string}):string{
 const root=mainRoot(ctx.cwd),old=readLinks(root);
 if(decision){
  const path=linkFile(root),keep=old.filter(l=>!(l.commit===decision.sha&&l.plan===decision.plan));
  keep[keep.length]={commit:decision.sha,plan:decision.plan,source:"review",confidence:"review",decision:decision.accept?"accept":"reject",files:codeFiles(ctx.cwd,decision.sha)};
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,keep.map(l=>JSON.stringify(l)).join("\n")+"\n");
  return `${decision.accept?"accepted":"rejected"} ${decision.sha} ${decision.plan}\n`;
 }
 return old.filter(l=>l.source!=="review"&&(l.confidence==="low"||old.some(x=>x.source!=="review"&&x.commit===l.commit&&x.plan!==l.plan))).map(l=>JSON.stringify(l)).join("\n")+"\n";
}
export function links(ctx:RepoCtx):Link[]{return readLinks(mainRoot(ctx.cwd)).filter(l=>l.source!=="review"||l.decision==="accept");}

const DAY_MS = 86_400_000;
export const SEMANTIC_FLOOR = 0.5;

export type Windows = {
  plan_before_code_days: number | null;
  plan_after_code_days: number | null;
  before_n: number;
  after_n: number;
};

const FALLBACK_BEFORE_DAYS = 1;
const FALLBACK_AFTER_DAYS = 3;

function readStoredWindows(root: string): Windows | null {
  const path = join(root, ".whytrail", "windows.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Windows>;
    const before = parsed.plan_before_code_days;
    const after = parsed.plan_after_code_days;
    return {
      plan_before_code_days: typeof before === "number" && Number.isFinite(before) ? before : null,
      plan_after_code_days: typeof after === "number" && Number.isFinite(after) ? after : null,
      before_n: typeof parsed.before_n === "number" ? parsed.before_n : 0,
      after_n: typeof parsed.after_n === "number" ? parsed.after_n : 0,
    };
  } catch {
    return null;
  }
}

function lastProgressMs(text: string): number | null {
  let inProgress = false;
  let best: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s+Progress\b/.test(line)) { inProgress = true; continue; }
    if (inProgress && /^##\s+/.test(line)) break;
    if (!inProgress) continue;
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})(?:\s+~?(\d{2}):(\d{2}))?/);
    if (!m) continue;
    const stamp = m[2] && m[3] ? `${m[1]}T${m[2]}:${m[3]}:00Z` : `${m[1]}T23:59:59.999Z`;
    const ms = Date.parse(stamp);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

function citedPathInWindow(commitMs: number, plan: PlanFile, text: string, days: { beforeDays: number; afterDays: number }): boolean {
  const start = planDate(plan);
  if (start === null || !Number.isFinite(commitMs)) return false;
  const end = lastProgressMs(text) ?? start;
  return commitMs >= start - days.afterDays * DAY_MS && commitMs <= end + days.beforeDays * DAY_MS;
}

export function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function measureWindows(rows: { planMs: number; codeMs: number }[]): Windows {
  const before: number[] = [];
  const after: number[] = [];
  for (const row of rows) {
    const days = (row.codeMs - row.planMs) / DAY_MS;
    if (days >= 0) before.push(days);
    else after.push(-days);
  }
  return {
    plan_before_code_days: percentile95(before),
    plan_after_code_days: percentile95(after),
    before_n: before.length,
    after_n: after.length,
  };
}

export function formatWindows(w: Windows): string {
  const before = w.plan_before_code_days === null ? "none" : `${w.plan_before_code_days}d`;
  const after = w.plan_after_code_days === null ? "none" : `${w.plan_after_code_days}d`;
  return `windows: plan-before-code 95th ${before} (n=${w.before_n}), plan-after-code 95th ${after} (n=${w.after_n})`;
}

function authorDates(cwd: string): Record<string, number> {
  const log = git(["log", "--all", "--format=%H%x09%aI"], cwd);
  const out: Record<string, number> = {};
  if (log.code !== 0) return out;
  for (const line of log.stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ms = Date.parse(line.slice(tab + 1));
    if (Number.isFinite(ms)) out[line.slice(0, tab)] = ms;
  }
  return out;
}

function windowsFor(ctx: RepoCtx, plans: PlanFile[], rows: Link[]): Windows {
  const dates = authorDates(ctx.cwd);
  const samples: { planMs: number; codeMs: number }[] = [];
  for (const link of rows) {
    if (link.confidence !== "high") continue;
    const plan = plans.find((item) => item.id === link.plan);
    const planMs = plan ? planDate(plan) : null;
    const codeMs = dates[link.commit];
    if (planMs === null || codeMs === undefined) continue;
    samples.push({ planMs, codeMs });
  }
  return measureWindows(samples);
}

function writeWindows(root: string, windows: Windows): void {
  const path = join(root, ".whytrail", "windows.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(windows, null, 2) + "\n");
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function semanticLinks(opts: {
  commits: { sha: string; ms: number; text: string }[];
  plans: { id: string; ms: number; text: string }[];
  linkedCommits: Set<string>;
  blockedPairs: Set<string>;
  windows: Windows;
  embed: (text: string) => number[];
}): Link[] {
  const planVec: Record<string, number[]> = {};
  const out: Link[] = [];
  for (const commit of opts.commits) {
    if (opts.linkedCommits.has(commit.sha)) continue;
    let best: { id: string; score: number } | null = null;
    let commitVec: number[] | null = null;
    for (const plan of opts.plans) {
      if (opts.blockedPairs.has(`${commit.sha}\0${plan.id}`)) continue;
      const days = (commit.ms - plan.ms) / DAY_MS;
      const inside = days >= 0
        ? opts.windows.plan_before_code_days !== null && days <= opts.windows.plan_before_code_days
        : opts.windows.plan_after_code_days !== null && -days <= opts.windows.plan_after_code_days;
      if (!inside) continue;
      if (!commitVec) commitVec = opts.embed(commit.text);
      const vec = planVec[plan.id] ?? (planVec[plan.id] = opts.embed(plan.text));
      const score = cosine(commitVec, vec);
      if (!best || score > best.score) best = { id: plan.id, score };
    }
    if (best && best.score >= SEMANTIC_FLOOR) {
      out.push({ commit: commit.sha, plan: best.id, source: "semantic", confidence: best.score >= 0.8 ? "medium" : "low" });
    }
  }
  return out;
}

export async function applySemantic(ctx: RepoCtx, plans: PlanFile[], opts: { dryRun: boolean; since?: string; embed: (texts: string[]) => Promise<number[][]> }): Promise<string> {
  const root = mainRoot(ctx.cwd);
  const { added, old } = backfillPreview(ctx, plans, opts);
  const combined = [...old, ...added];
  const windows = windowsFor(ctx, plans, combined);
  const dates = authorDates(ctx.cwd);
  const since = opts.since ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
  const linked = new Set(combined.filter((link) => !(link.source === "review" && link.decision === "reject")).map((link) => link.commit));
  const blocked = new Set(combined.map((link) => `${link.commit}\0${link.plan}`));
  const commits: { sha: string; ms: number; text: string }[] = [];
  for (const sha of gitOut(["rev-list", "--reverse", "--all"], ctx.cwd).split(/\r?\n/).filter(Boolean)) {
    if (linked.has(sha)) continue;
    const ms = dates[sha];
    if (ms === undefined || ms < since) continue;
    const subject = gitOut(["show", "-s", "--format=%s", sha], ctx.cwd).trim();
    const names = gitOut(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", sha], ctx.cwd).trim();
    commits.push({ sha, ms, text: `${subject}\n${names}`.slice(0, 4000) });
  }
  const planInputs: { id: string; ms: number; text: string }[] = [];
  for (const plan of plans) {
    const ms = planDate(plan);
    if (ms === null) continue;
    let text = "";
    try { text = readFileSync(plan.absPath, "utf8"); } catch { continue; }
    planInputs.push({ id: plan.id, ms, text: text.slice(0, 4000) });
  }
  const texts: string[] = [];
  const seen: Record<string, true> = {};
  for (const row of [...commits, ...planInputs]) {
    if (seen[row.text]) continue;
    seen[row.text] = true;
    texts.push(row.text);
  }
  const vectors = texts.length ? await opts.embed(texts) : [];
  const byText: Record<string, number[]> = {};
  for (let i = 0; i < texts.length; i++) byText[texts[i]] = vectors[i] ?? [];
  const semantic = semanticLinks({
    commits,
    plans: planInputs,
    linkedCommits: linked,
    blockedPairs: blocked,
    windows,
    embed: (text) => byText[text] ?? [],
  });
  if (!opts.dryRun && semantic.length) {
    const path = linkFile(root);
    const stored = readLinks(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [...stored, ...semantic.map((link) => ({ ...link, files: codeFiles(ctx.cwd, link.commit) }))].map((link) => JSON.stringify(link)).join("\n") + "\n");
  }
  return semantic.length ? `semantic links: ${semantic.length}\n` : "";
}
