#!/usr/bin/env bun
// whytrail - link plan files and code, both ways, in time order.

import { repoContext } from "./git";
import { discoverPlans } from "./plans";
import { whyResult, whyHuman, parseWhyTarget } from "./why";
import { codeResult, codeHuman } from "./code";
import { applySemantic, backfill, branchPlans, install, links, review, uninstall } from "./write-side";
import { NO_KEY_LINE, resolveKey, resolveModels, runConfig } from "./config";
import { classifyPrompt, ensureCards, labelPlans, labelsHuman, sampleCards } from "./lineage";
import type { ClassifyFn } from "./lineage";
import { DEFAULT_CLASSIFY_MODEL, DEFAULT_EMBED_MODEL, openRouter } from "./openrouter";
import { answerFromModel } from "./lineage";

const USAGE = `whytrail - link plan files and code, both ways, in time order

usage:
  whytrail why <file>[:<from>[-<to>]] [--json]
  whytrail code <plan-id|path> [--json]
  whytrail install | uninstall
  whytrail backfill [--dry-run] [--since <date>] [--repo <path>]
  whytrail labels [--json]
  whytrail review [--sample <n>] [--accept|--reject <sha> <plan-id>]
  whytrail config set <name> [value]
  whytrail config get <name>
  whytrail config list
  whytrail config unset <name>
  whytrail --help
`;

function classifyFn(key: string, repoRoot: string): ClassifyFn {
  const models = resolveModels(repoRoot, undefined, { classify: DEFAULT_CLASSIFY_MODEL, embed: DEFAULT_EMBED_MODEL });
  const client = openRouter({ apiKey: key, classifyModel: models.classify, embedModel: models.embed });
  return async (input) => {
    const raw = await client.classify(classifyPrompt(input));
    const answer = answerFromModel(raw, input.candidates.map((item) => item.plan));
    if (!answer) return { born: "change", outcome: "", confidence: 0, builds_on: [] };
    return answer;
  };
}

async function run(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === "config") return runConfig(argv.slice(1));
  const cmd = argv[0];
  const repoAt = argv.indexOf("--repo");
  if (repoAt >= 0 && !argv[repoAt + 1]) {
    process.stderr.write("error: --repo needs a path\n");
    return 1;
  }
  try {
    const ctx = repoContext(repoAt >= 0 ? argv[repoAt + 1] : undefined);
    const plans = discoverPlans(ctx);
    const key = resolveKey();
    if (cmd === "_plan-branches") { process.stdout.write(branchPlans(plans) + "\n"); return 0; }
    if (cmd === "install") { install(ctx); return 0; }
    if (cmd === "uninstall") { uninstall(ctx); return 0; }
    if (cmd === "backfill") {
      const sinceAt = argv.indexOf("--since");
      if (sinceAt >= 0 && !argv[sinceAt + 1]) throw new Error("--since needs a date");
      const since = sinceAt >= 0 ? argv[sinceAt + 1] : undefined;
      const dryRun = argv.includes("--dry-run");
      let summary = backfill(ctx, plans, { dryRun, since });
      if (key) {
        const models = resolveModels(ctx.mainRoot, undefined, { classify: DEFAULT_CLASSIFY_MODEL, embed: DEFAULT_EMBED_MODEL });
        const client = openRouter({ apiKey: key, classifyModel: models.classify, embedModel: models.embed });
        summary += await applySemantic(ctx, plans, { dryRun, since, embed: (texts) => client.embed(texts) });
      } else {
        process.stderr.write(NO_KEY_LINE);
      }
      process.stdout.write(summary);
      return 0;
    }
    if (cmd === "labels") {
      const result = await ensureCards(ctx, plans, key ? classifyFn(key, ctx.mainRoot) : null);
      if (result.aiSkipped) process.stderr.write(NO_KEY_LINE);
      const rows = labelPlans(result.current, Date.now());
      process.stdout.write(argv.includes("--json") ? JSON.stringify(rows, null, 2) + "\n" : labelsHuman(rows));
      return 0;
    }
    if (cmd === "review") {
      const sampleAt = argv.indexOf("--sample");
      const acceptAt = argv.indexOf("--accept"), rejectAt = argv.indexOf("--reject");
      if (sampleAt >= 0 && (acceptAt >= 0 || rejectAt >= 0)) throw new Error("use only one of --sample, --accept or --reject");
      if (sampleAt >= 0) {
        const n = Number(argv[sampleAt + 1]);
        if (!Number.isInteger(n) || n < 1) throw new Error("--sample needs a positive count");
        const result = await ensureCards(ctx, plans, key ? classifyFn(key, ctx.mainRoot) : null);
        if (result.aiSkipped) process.stderr.write(NO_KEY_LINE);
        const picked = sampleCards(result.cards, n);
        process.stdout.write(picked.length ? picked.map((card) => JSON.stringify(card)).join("\n") + "\n" : "no llm cards\n");
        return 0;
      }
      const selected = (acceptAt >= 0 ? 1 : 0) + (rejectAt >= 0 ? 1 : 0);
      if (selected > 1) throw new Error("use only one of --accept or --reject");
      const at = acceptAt >= 0 ? acceptAt : rejectAt;
      if (at >= 0 && (!argv[at + 1] || !argv[at + 2])) throw new Error("review decision needs <sha> <plan-id>");
      const result = at >= 0
        ? review(ctx, plans, { accept: acceptAt >= 0, sha: argv[at + 1], plan: argv[at + 2] })
        : review(ctx, plans);
      process.stdout.write(result);
      return 0;
    }
    const flags = argv.filter((a) => a.startsWith("-"));
    const rest = argv.filter((a) => !a.startsWith("-"));
    const json = flags.includes("--json");
    if (cmd !== "why" && cmd !== "code") { process.stderr.write(USAGE); return 1; }
    const arg = rest[1];
    if (!arg) throw new Error(`whytrail ${cmd} needs an argument`);
    const extra = links(ctx);
    if (cmd === "why") {
      const r = whyResult(ctx, plans, parseWhyTarget(arg), extra);
      process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : whyHuman(r));
    } else {
      const r = codeResult(ctx, plans, arg, extra);
      process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : codeHuman(r));
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
