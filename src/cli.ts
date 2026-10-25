#!/usr/bin/env bun
// whytrail - link plan files and code, both ways, in time order.

import { repoContext } from "./git";
import { discoverPlans } from "./plans";
import { whyResult, whyHuman, parseWhyTarget } from "./why";
import { codeResult, codeHuman } from "./code";

const USAGE = `whytrail - link plan files and code, both ways, in time order

usage:
  whytrail why <file>[:<from>[-<to>]] [--json]
      every plan behind those lines (or behind the whole file), oldest first

  whytrail code <plan-id|path> [--json]
      the commits and files that plan changed, in time order

  whytrail --help
`;

function run(argv: string[]): number {
  const flags = argv.filter((a) => a.startsWith("-"));
  const rest = argv.filter((a) => !a.startsWith("-"));
  const json = flags.includes("--json");

  if (flags.includes("-h") || flags.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  const cmd = rest[0];
  if (cmd !== "why" && cmd !== "code") {
    process.stderr.write(USAGE);
    return 1;
  }
  const arg = rest[1];
  if (!arg) {
    process.stderr.write(`error: whytrail ${cmd} needs an argument\n\n${USAGE}`);
    return 1;
  }

  try {
    const ctx = repoContext();
    const plans = discoverPlans(ctx);
    if (cmd === "why") {
      const r = whyResult(ctx, plans, parseWhyTarget(arg));
      process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : whyHuman(r));
    } else {
      const r = codeResult(ctx, plans, arg);
      process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : codeHuman(r));
    }
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
