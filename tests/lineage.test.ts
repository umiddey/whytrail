import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { repoContext } from "../src/git";
import { planFromFile } from "../src/plans";
import { backfill, backfillPreview, links, measureWindows, semanticLinks, applySemantic } from "../src/write-side";
import { openRouter, OPENROUTER_ORIGIN } from "../src/openrouter";

const repos: TempRepo[] = [];
afterEach(() => {
  for (const repo of repos) removeRepo(repo);
  repos.length = 0;
});

describe("lineage links", () => {
  test("windows from fixture links equal the hand-computed 95th percentiles", () => {
    const planMs = Date.parse("2026-01-01T00:00:00Z");
    const day = 86_400_000;
    // before gaps [1,2,3,4,10]: n=5, rank = ceil(0.95*5) = 5, index 4, value 10
    // after gaps [2]: n=1, rank = ceil(0.95*1) = 1, index 0, value 2
    const before = [1, 2, 3, 4, 10].map((gap) => ({ planMs, codeMs: planMs + gap * day }));
    const after = [{ planMs, codeMs: planMs - 2 * day }];
    const windows = measureWindows([...before, ...after]);
    expect(windows.plan_before_code_days).toBe(10);
    expect(windows.plan_after_code_days).toBe(2);
    expect(windows.before_n).toBe(5);
    expect(windows.after_n).toBe(1);
  });

  test("backfill writes those percentiles and a dry run writes nothing", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260101_0000_win.md";
    const text = "# Win\n\n## Goal\nMeasure windows\n";
    repo.write(planPath, text);
    repo.commit([planPath], "plan only", { date: "2026-01-01T00:00:00Z" });
    const id = "20260101_0000_win";
    const commits: [string, string][] = [
      ["src/d1.ts", "2026-01-02T00:00:00Z"],
      ["src/d2.ts", "2026-01-03T00:00:00Z"],
      ["src/d3.ts", "2026-01-04T00:00:00Z"],
      ["src/d4.ts", "2026-01-05T00:00:00Z"],
      ["src/d10.ts", "2026-01-11T00:00:00Z"],
      ["src/before.ts", "2025-12-30T00:00:00Z"],
    ];
    for (const [path, date] of commits) {
      repo.write(path, "x\n");
      repo.commit([path], path, { date, plans: [id] });
    }
    const ctx = repoContext(repo.root);
    const plans = [planFromFile(repo.root, planPath, text)];
    const preview = backfill(ctx, plans, { dryRun: true });
    expect(preview).toContain("windows: plan-before-code 95th 10d (n=5), plan-after-code 95th 2d (n=1)");
    expect(existsSync(join(repo.root, ".whytrail", "windows.json"))).toBe(false);
    backfill(ctx, plans, { dryRun: false });
    const stored = JSON.parse(readFileSync(join(repo.root, ".whytrail", "windows.json"), "utf8"));
    expect(stored.plan_before_code_days).toBe(10);
    expect(stored.plan_after_code_days).toBe(2);
  });

  test("a 300-file snapshot commit lands co-commit links at low, not high", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260101_0900_snap.md";
    const text = "# Snap\n\n## Goal\nBulk snapshot\n";
    repo.write(planPath, text);
    const paths = [planPath];
    for (let i = 0; i < 300; i++) {
      const rel = `snap/f${i}.txt`;
      repo.write(rel, "x\n");
      paths.push(rel);
    }
    repo.commit(paths, "wip-snapshot");
    const ctx = repoContext(repo.root);
    const plans = [planFromFile(repo.root, planPath, text)];
    backfill(ctx, plans, { dryRun: false });
    expect(links(ctx)).toHaveLength(1);
    expect(links(ctx)[0]).toMatchObject({ source: "co-commit", confidence: "low" });
  });

  test("cited-path links a later commit of a file the plan names", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260101_0900_cite.md";
    const text = "# Cite\n\n## Goal\nTouch src/later.ts\n";
    repo.write(planPath, text);
    repo.commit([planPath], "plan", { date: "2026-01-01T09:00:00Z" });
    repo.write("src/later.ts", "x\n");
    repo.commit(["src/later.ts"], "later", { date: "2026-01-02T09:00:00Z" });
    const ctx = repoContext(repo.root);
    backfill(ctx, [planFromFile(repo.root, planPath, text)], { dryRun: false });
    expect(links(ctx).find((link) => link.source === "cited-path")).toMatchObject({ confidence: "medium", plan: "20260101_0900_cite" });
  });

  test("cited-path links a file the plan names only inside the fallback window", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260101_0900_citewin.md";
    const text = "# Cite window\n\n## Goal\nTouch src/a.ts\n";
    repo.write(planPath, text);
    repo.commit([planPath], "plan", { date: "2026-01-01T09:00:00Z" });
    repo.write("src/a.ts", "near\n");
    const near = repo.commit(["src/a.ts"], "one day", { date: "2026-01-02T09:00:00Z" });
    repo.write("src/a.ts", "far\n");
    const far = repo.commit(["src/a.ts"], "sixty days", { date: "2026-03-02T09:00:00Z" });
    const ctx = repoContext(repo.root);
    backfill(ctx, [planFromFile(repo.root, planPath, text)], { dryRun: false });
    const cited = links(ctx).filter((link) => link.source === "cited-path");
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatchObject({ commit: near, confidence: "medium", plan: "20260101_0900_citewin" });
    expect(links(ctx).some((link) => link.commit === far)).toBe(false);
  });

  test("cited-path uses windows.json and the last Progress date", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260101_0900_citeprog.md";
    const text = "# Cite progress\n\n## Goal\nTouch src/a.ts\n\n## Progress\n- 2026-01-10 09:00 Main: still open\n";
    repo.write(planPath, text);
    repo.commit([planPath], "plan", { date: "2026-01-01T09:00:00Z" });
    repo.write(".whytrail/windows.json", JSON.stringify({
      plan_before_code_days: 2,
      plan_after_code_days: 0.5,
      before_n: 4,
      after_n: 4,
    }) + "\n");
    repo.write("src/a.ts", "early\n");
    const early = repo.commit(["src/a.ts"], "early", { date: "2025-12-30T09:00:00Z" });
    repo.write("src/a.ts", "edge\n");
    const edge = repo.commit(["src/a.ts"], "edge", { date: "2025-12-31T21:00:00Z" });
    repo.write("src/a.ts", "end\n");
    const end = repo.commit(["src/a.ts"], "end", { date: "2026-01-12T09:00:00Z" });
    repo.write("src/a.ts", "past\n");
    const past = repo.commit(["src/a.ts"], "past", { date: "2026-01-12T09:00:01Z" });
    const ctx = repoContext(repo.root);
    backfill(ctx, [planFromFile(repo.root, planPath, text)], { dryRun: false });
    const cited = links(ctx).filter((link) => link.source === "cited-path").map((link) => link.commit);
    expect(cited).toEqual([edge, end]);
    expect(cited).not.toContain(early);
    expect(cited).not.toContain(past);
  });

  test("cited-path uses the window measured in the same run when windows.json is absent", () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260110_0900_same.md";
    repo.write("src/early.ts", "early\n");
    const earlySha = repo.commit(["src/early.ts"], "early code", { date: "2026-01-09T21:00:00Z" });
    const text = `# Same run\n\n## Goal\nTouch src/late.ts\n\nEarly ${earlySha}\n`;
    repo.write(planPath, text);
    repo.write("src/anchor.ts", "anchor\n");
    repo.commit([planPath, "src/anchor.ts"], "plan and anchor", { date: "2026-01-11T03:00:00Z" });
    repo.write("src/late.ts", "too early\n");
    const tooEarly = repo.commit(["src/late.ts"], "inside fallback before", { date: "2026-01-08T09:00:00Z" });
    repo.write("src/late.ts", "after edge\n");
    const insideAfter = repo.commit(["src/late.ts"], "inside measured after", { date: "2026-01-09T21:00:00Z" });
    repo.write("src/late.ts", "before edge\n");
    const insideBefore = repo.commit(["src/late.ts"], "inside measured before", { date: "2026-01-11T00:00:00Z" });
    repo.write("src/late.ts", "too late\n");
    const tooLate = repo.commit(["src/late.ts"], "inside fallback after", { date: "2026-01-11T09:00:00Z" });
    const ctx = repoContext(repo.root);
    const plans = [planFromFile(repo.root, planPath, text)];
    expect(existsSync(join(repo.root, ".whytrail", "windows.json"))).toBe(false);
    const preview = backfill(ctx, plans, { dryRun: true });
    expect(existsSync(join(repo.root, ".whytrail", "windows.json"))).toBe(false);
    expect(preview).toContain("windows: plan-before-code 95th 0.75d (n=1), plan-after-code 95th 0.5d (n=1)");
    const cited = backfillPreview(ctx, plans, { dryRun: true }).added.filter((link) => link.source === "cited-path").map((link) => link.commit);
    expect(cited).toEqual([insideAfter, insideBefore]);
    expect(cited).not.toContain(tooEarly);
    expect(cited).not.toContain(tooLate);
  });

  test("semantic links a leftover inside the measured window and skips one outside it", async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const planPath = "docs/plans/20260101_0000_sem.md";
    const text = "# Sem\n\n## Goal\nMATCH plan\n";
    repo.write(planPath, text);
    repo.commit([planPath], "plan", { date: "2026-01-01T00:00:00Z" });
    repo.write("src/known.ts", "x\n");
    repo.commit(["src/known.ts"], "known", { date: "2026-01-05T00:00:00Z", plans: ["20260101_0000_sem"] });
    repo.write("src/near.ts", "x\n");
    repo.commit(["src/near.ts"], "MATCH near", { date: "2026-01-03T00:00:00Z" });
    repo.write("src/far.ts", "x\n");
    repo.commit(["src/far.ts"], "MATCH far", { date: "2026-03-01T00:00:00Z" });
    const ctx = repoContext(repo.root);
    const plans = [planFromFile(repo.root, planPath, text)];
    backfill(ctx, plans, { dryRun: false });
    const note = await applySemantic(ctx, plans, {
      dryRun: false,
      embed: async (texts) => texts.map((item) => (item.includes("MATCH") ? [1, 0] : [0, 1])),
    });
    expect(note).toBe("semantic links: 1\n");
    const semantic = links(ctx).filter((link) => link.source === "semantic");
    expect(semantic).toHaveLength(1);
    expect(semantic[0].confidence).toBe("medium");
    expect(await applySemantic(ctx, plans, { dryRun: false, embed: async (texts) => texts.map((item) => (item.includes("MATCH") ? [1, 0] : [0, 1])) })).toBe("");
    expect(links(ctx).filter((link) => link.source === "semantic")).toHaveLength(1);
  });

  test("semantic similarity below the floor adds no link", () => {
    const planMs = Date.parse("2026-01-01T00:00:00Z");
    const added = semanticLinks({
      commits: [{ sha: "abc", ms: planMs + 86_400_000, text: "commit" }],
      plans: [{ id: "20260101_0000_sem", ms: planMs, text: "plan" }],
      linkedCommits: new Set(),
      blockedPairs: new Set(),
      windows: { plan_before_code_days: 10, plan_after_code_days: null, before_n: 1, after_n: 0 },
      embed: (text) => (text === "commit" ? [1, 0] : [0, 1]),
    });
    expect(added).toHaveLength(0);
  });

  test("OpenRouter requests stay on the injected client", async () => {
    const seen: string[] = [];
    const client = openRouter({
      apiKey: "test",
      classifyModel: "openai/gpt-4o-mini",
      embedModel: "openai/text-embedding-3-small",
      http: async (req) => {
        seen.push(req.url);
        if (req.url.endsWith("/chat/completions")) {
          return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "{\"born\":\"bug\",\"outcome\":\"fixed\",\"confidence\":0.9,\"builds_on\":[]}" } }] }) };
        }
        return { status: 200, body: JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }) };
      },
    });
    const answer = await client.classify("plan");
    const vectors = await client.embed(["plan"]);
    expect(answer).toMatchObject({ born: "bug", confidence: 0.9 });
    expect(vectors).toEqual([[1, 0]]);
    expect(seen).toEqual([`${OPENROUTER_ORIGIN}/chat/completions`, `${OPENROUTER_ORIGIN}/embeddings`]);
  });
});
