#!/usr/bin/env bun
// whytrail - link plan files and code, both ways, in time order.

import { repoContext } from "./git";
import { discoverPlans } from "./plans";
import { whyResult, whyHuman, parseWhyTarget } from "./why";
import { codeResult, codeHuman } from "./code";
import { backfill, branchPlans, install, links, review, uninstall } from "./write-side";

const USAGE = `whytrail - link plan files and code, both ways, in time order

usage:
  whytrail why <file>[:<from>[-<to>]] [--json]
  whytrail code <plan-id|path> [--json]
  whytrail install | uninstall
  whytrail backfill [--dry-run] [--since <date>] [--repo <path>]
  whytrail review [--accept|--reject <sha> <plan-id>]
  whytrail --help
`;

function run(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cmd = argv[0];
  const repoAt = argv.indexOf("--repo");
  if (repoAt >= 0 && !argv[repoAt + 1]) {
    process.stderr.write("error: --repo needs a path\n");
    return 1;
  }
  try {
    const ctx = repoContext(repoAt >= 0 ? argv[repoAt + 1] : undefined);
    const plans = discoverPlans(ctx);
    if (cmd === "_plan-branches") { process.stdout.write(branchPlans(plans) + "\n"); return 0; }
    if (cmd === "install") { install(ctx); return 0; }
    if (cmd === "uninstall") { uninstall(ctx); return 0; }
    if (cmd === "backfill") {
      const sinceAt = argv.indexOf("--since");
      if (sinceAt >= 0 && !argv[sinceAt + 1]) throw new Error("--since needs a date");
      process.stdout.write(backfill(ctx, plans, { dryRun: argv.includes("--dry-run"), since: sinceAt >= 0 ? argv[sinceAt + 1] : undefined }));
      return 0;
    }
    if (cmd === "review") {
      const acceptAt = argv.indexOf("--accept"), rejectAt = argv.indexOf("--reject");
      const at = acceptAt >= 0 ? acceptAt : rejectAt;
      const result = at >= 0
        ? review(ctx, plans, { accept: acceptAt >= 0, sha: argv[at + 1] ?? "", plan: argv[at + 2] ?? "" })
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

if (import.meta.main) process.exit(run(process.argv.slice(2)));
