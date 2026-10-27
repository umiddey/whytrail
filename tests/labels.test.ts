import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { NO_KEY_LINE } from "../src/config";
import { ageDays, labelPlans, labelsHuman, lineageWeight, syncCards, type Card, type ClassifyAnswer } from "../src/lineage";

const repos: TempRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const repo of repos) removeRepo(repo);
  repos.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function card(partial: Partial<Card> & Pick<Card, "plan">): Card {
  return {
    blob: partial.blob ?? partial.plan,
    born: partial.born ?? null,
    builds_on: partial.builds_on ?? [],
    files: partial.files ?? [],
    outcome: partial.outcome ?? "",
    confidence: partial.confidence ?? 1,
    source: partial.source ?? "field",
    goal: partial.goal ?? null,
    ...partial,
  };
}

describe("labels", () => {
  test("unchanged blob is not re-read and the classifier is not called", async () => {
    let calls = 0;
    let reads = 0;
    const plan = {
      id: "20260101_0900_a",
      blob: "blob-a",
      readText: () => {
        reads += 1;
        return "# A\n\n## Goal\nBuild A\n";
      },
    };
    const classify = () => {
      calls += 1;
      return { born: "feature" as const, outcome: "built", confidence: 0.9, builds_on: [] };
    };
    const first = await syncCards({ plans: [plan], existing: [], classify });
    expect(calls).toBe(1);
    expect(reads).toBe(1);
    const second = await syncCards({ plans: [plan], existing: first.cards, classify });
    expect(calls).toBe(1);
    expect(second.calls).toBe(0);
    expect(reads).toBe(1);
  });

  test("a later bug plan marks the earlier plan bad with the later Goal line", async () => {
    const plans = [
      { id: "20260101_0900_a", blob: "a", readText: () => "# A\n\n## Goal\nBuild the thing\n" },
      { id: "20260120_0900_b", blob: "b", readText: () => "# B\n\n## Goal\nFix the crash\n\nBorn from: bug\nBuilds on: 20260101_0900_a\n" },
    ];
    const synced = await syncCards({ plans, existing: [], classify: null });
    const text = labelsHuman(labelPlans(synced.current, Date.parse("2026-02-01T00:00:00Z")));
    expect(text).toContain('20260101_0900_a\tbad (bug) by 20260120_0900_b: "Fix the crash"');
  });

  test("a later feature plan does not mark the earlier plan bad", async () => {
    const plans = [
      { id: "20260101_0900_a", blob: "a", readText: () => "# A\n\n## Goal\nBuild the thing\n\nBorn from: feature\n" },
      { id: "20260120_0900_b", blob: "b", readText: () => "# B\n\n## Goal\nAdd a button\n\nBorn from: feature\nBuilds on: 20260101_0900_a\n" },
    ];
    const synced = await syncCards({ plans, existing: [], classify: null });
    const rows = labelPlans(synced.current, Date.parse("2026-01-25T00:00:00Z"));
    expect(rows.find((row) => row.plan === "20260101_0900_a")?.label).not.toBe("bad");
  });

  test("classifier confidence 0.6 takes the unclassified fallback and does not keep the guess", async () => {
    const classify = (): ClassifyAnswer => ({ born: "bug", outcome: "guessed", confidence: 0.6, builds_on: [] });
    const synced = await syncCards({
      plans: [{ id: "20260101_0900_a", blob: "a", readText: () => "# A\n\n## Goal\nBuild\n" }],
      existing: [],
      classify,
    });
    expect(synced.current[0]).toMatchObject({ source: "unclassified", born: null, builds_on: [], outcome: "" });
  });

  test("no key leaves a plan without story lines unclassified and does not call a classifier", async () => {
    const synced = await syncCards({
      plans: [{ id: "20260101_0900_a", blob: "a", readText: () => "# A\n\n## Goal\nBuild\n" }],
      existing: [],
      classify: null,
    });
    expect(synced.calls).toBe(0);
    expect(synced.aiSkipped).toBe(true);
    expect(synced.current[0].source).toBe("unclassified");
  });

  test("13 days old is open and 14 days old is good", () => {
    const rows = [card({ plan: "20260101_0900_a", born: "feature", goal: "Build" })];
    expect(ageDays("20260101_0900_a", Date.parse("2026-01-14T09:00:00Z"))).toBe(13);
    expect(labelPlans(rows, Date.parse("2026-01-14T09:00:00Z"))[0].label).toBe("open");
    expect(labelPlans(rows, Date.parse("2026-01-15T09:00:00Z"))[0].label).toBe("good");
  });

  test("a newer bug judgment outweighs an older one", () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const rows = labelPlans([
      card({ plan: "20260101_0900_a", born: "feature", goal: "Build" }),
      card({ plan: "20260115_0900_old", born: "bug", goal: "old bug", builds_on: ["20260101_0900_a"] }),
      card({ plan: "20260215_0900_new", born: "bug", goal: "new bug", builds_on: ["20260101_0900_a"] }),
    ], now);
    expect(labelsHuman(rows)).toContain('bad (bug) by 20260215_0900_new: "new bug"');
    expect(lineageWeight(0)).toBe(1);
    expect(lineageWeight(30)).toBe(0.5);
  });

  test("labels with no key print the fallback line and do not crash", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const home = mkdtempSync(join(tmpdir(), "whytrail-home-"));
    dirs.push(home);
    repo.write("docs/plans/20260101_0900_a.md", "# A\n\n## Goal\nBuild the thing\n");
    repo.write("docs/plans/20260120_0900_b.md", "# B\n\n## Goal\nFix the crash\n\nBorn from: bug\nBuilds on: 20260101_0900_a\n");
    repo.commit(["docs"], "plans");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === "OPENROUTER_API_KEY" || value === undefined) continue;
      env[key] = value;
    }
    env.HOME = home;
    const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), "labels"], {
      cwd: repo.root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const stderr = proc.stderr.toString();
    expect(proc.exitCode).toBe(0);
    expect(stderr.split(NO_KEY_LINE).length - 1).toBe(1);
    expect(proc.stdout.toString()).toContain('bad (bug) by 20260120_0900_b: "Fix the crash"');
  });
});
