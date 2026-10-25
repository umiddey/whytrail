import { describe, test, expect, afterEach } from "bun:test";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { repoContext } from "../src/git";
import { discoverPlans } from "../src/plans";
import { whyResult, whyHuman, parseWhyTarget } from "../src/why";

let made: TempRepo[] = [];
function repo(): TempRepo {
  const r = makeTempRepo();
  made[made.length] = r;
  return r;
}
afterEach(() => {
  for (const r of made) removeRepo(r);
  made = [];
});

function seedWhy(t: TempRepo) {
  t.write(
    "docs/plans/20260101_0900_alpha.md",
    "# Alpha plan\n\n## Goal\nmake alpha real\n",
  );
  t.write("docs/plans/20260202_1000_beta.md", "# Beta plan\n\n## Goal\nbuild on alpha\n");
  t.commit(["docs"], "plans", { date: "2026-01-01T09:00:00 +0000" });
  t.write("src/app.ts", "one\n");
  const c1 = t.commit(["src/app.ts"], "touch one", {
    date: "2026-01-02T09:00:00 +0000",
    plans: ["20260101_0900_alpha"],
  });
  t.write("src/app.ts", "one\ntwo\n");
  const c2 = t.commit(["src/app.ts"], "add two", {
    date: "2026-01-03T09:00:00 +0000",
    plans: ["20260101_0900_alpha", "20260202_1000_beta"],
  });
  return { c1, c2 };
}

describe("parseWhyTarget", () => {
  test("bare path, single line, range", () => {
    expect(parseWhyTarget("src/a.ts")).toEqual({ file: "src/a.ts", from: null, to: null });
    expect(parseWhyTarget("src/a.ts:3")).toEqual({ file: "src/a.ts", from: 3, to: 3 });
    expect(parseWhyTarget("src/a.ts:3-9")).toEqual({ file: "src/a.ts", from: 3, to: 9 });
  });
});

describe("why via blame (line range)", () => {
  test("groups commits by plan, plans oldest first", () => {
    const t = repo();
    const { c1, c2 } = seedWhy(t);
    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);

    const r = whyResult(ctx, plans, { file: "src/app.ts", from: 1, to: 2 });
    expect(r.plans.map((p) => p.id)).toEqual(["20260101_0900_alpha", "20260202_1000_beta"]);

    const alpha = r.plans[0];
    expect(alpha.title).toBe("Alpha plan");
    expect(alpha.goal).toBe("make alpha real");
    expect(alpha.path).toBe("docs/plans/20260101_0900_alpha.md");
    expect(alpha.date).toBe("2026-01-01 09:00");
    expect(alpha.commits.map((c) => c.sha)).toEqual([c1, c2]);

    expect(r.plans[1].commits.map((c) => c.sha)).toEqual([c2]);
    expect(r.unlinked).toEqual([]);
  });

  test("a commit with no Plan trailer lands in unlinked", () => {
    const t = repo();
    seedWhy(t);
    t.write("src/app.ts", "one\ntwo\nthree\n");
    const c3 = t.commit(["src/app.ts"], "no trailer", { date: "2026-01-04T09:00:00 +0000" });
    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);

    const r = whyResult(ctx, plans, { file: "src/app.ts", from: 3, to: 3 });
    expect(r.plans).toEqual([]);
    expect(r.unlinked.map((c) => c.sha)).toEqual([c3]);
    expect(whyHuman(r)).toContain("(no Plan trailer)");
  });
});

describe("why via log --follow (no range)", () => {
  test("finds commits across a rename, both plans, oldest first", () => {
    const t = repo();
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha\n");
    t.write("docs/plans/20260202_1000_beta.md", "# Beta\n");
    t.commit(["docs"], "plans", { date: "2026-01-01T09:00:00 +0000" });
    t.write("a.txt", "data\n");
    const c1 = t.commit(["a.txt"], "add a", {
      date: "2026-01-02T09:00:00 +0000",
      plans: ["20260101_0900_alpha"],
    });
    t.git(["mv", "a.txt", "b.txt"]);
    const c2 = t.commit(["b.txt"], "rename to b", {
      date: "2026-02-03T09:00:00 +0000",
      plans: ["20260202_1000_beta"],
    });

    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);
    const r = whyResult(ctx, plans, { file: "b.txt", from: null, to: null });
    expect(r.plans.map((p) => p.id)).toEqual(["20260101_0900_alpha", "20260202_1000_beta"]);
    expect(r.plans[0].commits.map((c) => c.sha)).toEqual([c1]);
    expect(r.plans[1].commits.map((c) => c.sha)).toEqual([c2]);
  });

  test("unknown file yields no plans and no commits", () => {
    const t = repo();
    seedWhy(t);
    const r = whyResult(repoContext(t.root), discoverPlans(repoContext(t.root)), {
      file: "src/never-existed.ts",
      from: null,
      to: null,
    });
    expect(r.plans).toEqual([]);
    expect(r.unlinked).toEqual([]);
    expect(whyHuman(r)).toContain("(no commits found)");
  });
});

describe("why through the CLI", () => {
  test("human output names both plans with commits", () => {
    const t = repo();
    seedWhy(t);
    const res = t.runCli(["why", "src/app.ts:1-2"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("20260101_0900_alpha");
    expect(res.stdout).toContain("20260202_1000_beta");
    expect(res.stdout).toContain("Goal: make alpha real");
    expect(res.stdout).toContain("docs/plans/20260101_0900_alpha.md");
  });

  test("--json emits the full result", () => {
    const t = repo();
    const { c1, c2 } = seedWhy(t);
    const res = t.runCli(["why", "src/app.ts:1-2", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.file).toBe("src/app.ts");
    expect(parsed.plans.length).toBe(2);
    expect(parsed.plans[0].id).toBe("20260101_0900_alpha");
    expect(parsed.plans[0].commits.map((c: { sha: string }) => c.sha)).toEqual([c1, c2]);
    expect(parsed.plans[1].commits.length).toBe(1);
    expect(parsed.unlinked).toEqual([]);
  });

  test("a plan trailer whose file is missing shows (plan file not found)", () => {
    const t = repo();
    t.write("src/app.ts", "one\n");
    t.commit(["src"], "start", { date: "2026-01-01T09:00:00 +0000" });
    t.write("src/app.ts", "one\ntwo\n");
    t.commit(["src/app.ts"], "ghost work", {
      date: "2026-01-02T09:00:00 +0000",
      plans: ["20260303_1100_ghost"],
    });
    const res = t.runCli(["why", "src/app.ts:2"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("(plan file not found)");
    expect(res.stdout).toContain("20260303_1100_ghost");
  });
});
