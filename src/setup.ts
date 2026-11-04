// `whytrail setup` — find the plan folders, ask the few unguessable things, install, backfill, and end with a real `why`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitOut } from "./git";
import type { RepoCtx } from "./git";
import {
  DEFAULT_GLOBS,
  DEFAULT_SKIPS,
  planGlobs,
  sameSet,
  skipList,
  writeRepoPlansSkips,
} from "./plans";
import type { PlanFile } from "./plans";
import { detectPlanFolders } from "./detect";
import {
  maskSecret,
  readConfig,
  readHidden,
  readLine,
  resolveKey,
  resolveModels,
  writeConfig,
} from "./config";
import { backfill, backfillPreview, hooksDir, install, links } from "./write-side";
import { whyResult } from "./why";
import type { WhyTarget } from "./why";
import { DEFAULT_CLASSIFY_MODEL, DEFAULT_EMBED_MODEL } from "./openrouter";

/** most-committed non-.md file in the last 30 days; ties break lexicographically */
function mostChangedCodeFile(cwd: string): string | null {
  const out = gitOut(["log", "--since=30.days", "--name-only", "--format="], cwd);
  const counts = new Map<string, number>();
  for (const line of out.split("\n")) {
    const f = line.trim();
    if (!f || f.endsWith(".md")) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [f, n] of counts) {
    const bestN = best === null ? -1 : (counts.get(best) as number);
    if (n > bestN || (n === bestN && f < (best as string))) best = f;
  }
  return best;
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function commaList(input: string): string[] | null {
  const parsed = input.split(",").map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : null;
}

export function runSetup(ctx: RepoCtx, plans: PlanFile[], opts: { yes: boolean }): number {
  const tracked = gitOut(["ls-files"], ctx.mainRoot).split("\n").map((s) => s.trim()).filter(Boolean);
  const detected = detectPlanFolders(tracked);
  const proposedPlans = detected.globs.length > 0 ? detected.globs : DEFAULT_GLOBS;
  const proposedSkips = [...new Set([...detected.skips, ...DEFAULT_SKIPS])].toSorted();
  const otherNote = detected.other.length > 0
    ? ` (other stamped: ${detected.other.map((o) => `${o.folder}: ${o.count}`).join(", ")})`
    : "";

  // (a)(b) folders and skips: show the proposal, Enter accepts, a comma list replaces it.
  say(`plans: ${proposedPlans.join(", ")}${otherNote}`);
  say(`skips: ${proposedSkips.join(", ")}`);
  let chosenPlans = proposedPlans;
  let chosenSkips = proposedSkips;
  if (!opts.yes) {
    const plansIn = commaList(readLine("plans (Enter = accept, or comma list): "));
    if (plansIn) chosenPlans = plansIn;
    const skipsIn = commaList(readLine("skips (Enter = accept, or comma list): "));
    if (skipsIn) chosenSkips = skipsIn;
  }

  // (c) write .whytrail.json only when the choice differs from what the repo already has;
  // keys equal to their defaults are cleared, so defaults never land in the file.
  if (sameSet(chosenPlans, planGlobs(ctx.mainRoot)) && sameSet(chosenSkips, skipList(ctx.mainRoot))) {
    say("config: unchanged");
  } else {
    writeRepoPlansSkips(ctx.mainRoot, {
      plans: sameSet(chosenPlans, DEFAULT_GLOBS) ? null : chosenPlans,
      skip: sameSet(chosenSkips, DEFAULT_SKIPS) ? null : chosenSkips,
    });
    say("config: wrote .whytrail.json");
  }

  // (d) OpenRouter key: show it masked, ask hidden, blank keeps it. --yes never asks.
  const key = resolveKey();
  say(`key: ${key ? maskSecret(key) : "none"}`);
  if (!opts.yes) {
    const entered = readHidden("OpenRouter key (hidden, Enter = keep): ").trim();
    if (entered) {
      const cfg = readConfig();
      cfg["openrouter-key"] = entered;
      writeConfig(cfg);
      say(`key: set (${maskSecret(entered)})`);
    }
  }

  // (e) models: show the effective ones, Enter keeps them, "classify,embed" replaces both.
  const models = resolveModels(ctx.mainRoot, undefined, {
    classify: DEFAULT_CLASSIFY_MODEL,
    embed: DEFAULT_EMBED_MODEL,
  });
  say(`models: classify=${models.classify} embed=${models.embed}`);
  if (!opts.yes) {
    const entered = readLine('models (Enter = keep, or "<classify>,<embed>"): ').trim();
    const [classify, embed] = entered.split(",").map((s) => s.trim());
    if (classify && embed && (classify !== models.classify || embed !== models.embed)) {
      const cfg = readConfig();
      cfg["classify-model"] = classify;
      cfg["embed-model"] = embed;
      writeConfig(cfg);
      say(`models: set (classify=${classify} embed=${embed})`);
    }
  }

  // (f) hooks: install is idempotent; report which happened.
  const hookPath = join(hooksDir(ctx.cwd), "prepare-commit-msg");
  if (existsSync(hookPath) && readFileSync(hookPath, "utf8").includes("whytrail-hook-v1")) {
    say("hooks: unchanged");
  } else {
    install(ctx);
    say("hooks: installed");
  }

  // (g) backfill: preview totals first, then write on yes/confirmation; 0 new links means no write at all.
  const preview = backfillPreview(ctx, plans, { dryRun: true });
  if (preview.added.length === 0) {
    say("backfill: unchanged");
  } else {
    const totals: Record<string, number> = {};
    for (const l of preview.added) {
      const k = `${l.source} ${l.confidence}`;
      totals[k] = (totals[k] ?? 0) + 1;
    }
    const parts = Object.keys(totals).toSorted().map((k) => `${k}: ${totals[k]}`).join(", ");
    say(`backfill: ${preview.added.length} new links (${parts})`);
    const write = opts.yes || /^\s*y(es)?\s*$/i.test(readLine("write links? [y/N]: "));
    if (write) {
      backfill(ctx, plans, { dryRun: false });
      say(`backfill: wrote ${preview.added.length} links`);
    } else {
      say("backfill: not written");
    }
  }

  // (h) end with a real `why` answer on the most-changed code file of the last 30 days.
  const file = mostChangedCodeFile(ctx.cwd);
  if (!file) {
    say("why: no file changed in the last 30 days");
  } else {
    const target: WhyTarget = { file, from: null, to: null };
    const r = whyResult(ctx, plans, target, links(ctx));
    say(r.plans.length > 0 ? `why: ${file} -> ${r.plans[0].id}` : "why: no linked plan yet");
  }
  return 0;
}
