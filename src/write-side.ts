import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitOut, git } from "./git";
import type { RepoCtx } from "./git";
import type { PlanFile } from "./plans";

export type LinkSource = "trailer" | "co-commit" | "memory-log" | "progress-sha" | "branch" | "date-files" | "review";
export type LinkDecision = "accept" | "reject";
export type Link = { commit: string; plan: string; source: LinkSource; confidence: "high" | "medium" | "low" | "review"; decision?: LinkDecision };
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
function commitInfo(cwd:string,sha:string):{date:string;subject:string;trailers:string[]}{const fields=gitOut(["show","-s","--format=%aI%x1f%s%x1f%(trailers:key=Plan,valueonly)",sha],cwd).trimEnd().split("\x1f");return {date:fields[0]??"",subject:fields[1]??"",trailers:(fields[2]??"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean)};}
function citedPaths(text:string):string[]{const found:string[]=[];let active=false;for(const line of text.split(/\r?\n/)){if(/^#{1,6}\s*(FILES MODIFIED|Files changed|Files)\s*$/i.test(line.trim())){active=true;continue;}if(active&&/^#{1,6}\s/.test(line))break;if(active){for(const m of line.matchAll(/(?:^|[\s`])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/g))found[found.length]=m[1];}}return [...new Set(found)];}
function planCodePaths(text:string):string[]{const found:string[]=[];for(const line of text.split(/\r?\n/)){for(const m of line.matchAll(/(?:^|[\s`])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/g)){const p=m[1];if(!p.endsWith(".md"))found[found.length]=p;}}return [...new Set(found)];}
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
 const since=opts.since?Date.parse(opts.since):Number.NEGATIVE_INFINITY;
 for(const sha of shas){const meta=commitInfo(ctx.cwd,sha);if(Date.parse(meta.date)<since)continue;const files=commitPaths(ctx.cwd,sha),timestamp=Date.parse(meta.date),hasCode=files.some(f=>!f.endsWith(".md"));for(const plan of plans){if(existing.has(`${sha}\0${plan.id}`)||protectedLinks.some(l=>l.commit===sha&&l.plan===plan.id))continue;const text=texts[plan.id]??"";let source:LinkSource|undefined;let confidence:Link["confidence"]|undefined;
  if(meta.trailers.includes(plan.id)){source="trailer";confidence="high";}else if(files.includes(plan.path)&&files.length>1){source="co-commit";confidence="high";}else if(planDate(plan)!==null&&timestamp>=(planDate(plan) as number)&&files.some(f=>(memoryPaths[plan.id]??[]).includes(f))){source="memory-log";confidence="medium";}else if(new RegExp(`\\b${sha.slice(0,7)}[0-9a-f]{0,33}\\b`,"i").test(text)){source="progress-sha";confidence="high";}else if(branchLinks[plan.id]?.has(sha)){source="branch";confidence="high";}else{const date=plan.date?.slice(0,10);if(date&&new Date(timestamp).toISOString().slice(0,10)===date&&hasCode&&files.some(f=>!f.endsWith(".md")&&planCodePaths(text).includes(f))){source="date-files";confidence="low";}}
  if(source&&confidence)added[added.length]={commit:sha,plan:plan.id,source,confidence};
 }}
 return {added,old};
}
export function backfill(ctx:RepoCtx,plans:PlanFile[],opts:{dryRun:boolean;since?:string}):string{
 const root=mainRoot(ctx.cwd),{added,old}=backfillPreview(ctx,plans,opts);
 const totals:Record<string,number>={};for(const l of [...old,...added]){const key=`${l.source} ${l.confidence}`;totals[key]=(totals[key]??0)+1;}const summary=[`new links: ${added.length}`,...Object.keys(totals).sort().map(k=>`${k}: ${totals[k]}`)];if(!opts.dryRun&&added.length){const path=linkFile(root);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,[...old,...added].map(l=>JSON.stringify(l)).join("\n")+"\n");}return summary.join("\n")+"\n";
}
export function review(ctx:RepoCtx,_plans:PlanFile[],decision?:{accept:boolean;sha:string;plan:string}):string{
 const root=mainRoot(ctx.cwd),old=readLinks(root);
 if(decision){
  const path=linkFile(root),keep=old.filter(l=>!(l.commit===decision.sha&&l.plan===decision.plan));
  keep[keep.length]={commit:decision.sha,plan:decision.plan,source:"review",confidence:"review",decision:decision.accept?"accept":"reject"};
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,keep.map(l=>JSON.stringify(l)).join("\n")+"\n");
  return `${decision.accept?"accepted":"rejected"} ${decision.sha} ${decision.plan}\n`;
 }
 return old.filter(l=>l.source!=="review"&&(l.confidence==="low"||old.some(x=>x.source!=="review"&&x.commit===l.commit&&x.plan!==l.plan))).map(l=>JSON.stringify(l)).join("\n")+"\n";
}
export function links(ctx:RepoCtx):Link[]{return readLinks(mainRoot(ctx.cwd)).filter(l=>l.source!=="review"||l.decision==="accept");}
