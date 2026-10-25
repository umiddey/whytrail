import { describe, test, expect, afterEach } from "bun:test";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { repoContext } from "../src/git";
import { discoverPlans } from "../src/plans";
import { codeResult, codeHuman, resolvePlanId } from "../src/code";

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

function seedCode(t: TempRepo) {
  t.write("docs/plans/20260101_0900_alpha.md", "# Alpha plan\n\n## Goal\nmake alpha real\n");
  t.commit(["docs"], "plans", { date: "2026-01-01T09:00:00 +0000" });
  t.write("src/app.ts", "one\n");
  const c1 = t.commit(["src/app.ts"], "touch one", {
    date: "2026-01-02T09:00:00 +0000",
    plans: ["20260101_0900_alpha"],
  });
  t.write("src/app.ts", "one\ntwo\n");
  t.write("src/util.ts", "u\n");
  const c2 = t.commit(["src/app.ts", "src/util.ts"], "add two + util", {
    date: "2026-01-03T09:00:00 +0000",
    plans: ["20260101_0900_alpha"],
  });
  return { c1, c2 };
}

describe("resolvePlanId", () => {
  test("accepts a bare id and a plan file path", () => {
    const t = repo();
    seedCode(t);
    const ctx = repoContext(t.root);
    expect(resolvePlanId("20260101_0900_alpha", ctx)).toBe("20260101_0900_alpha");
    expect(resolvePlanId("docs/plans/20260101_0900_alpha.md", ctx)).toBe("20260101_0900_alpha");
    expect(resolvePlanId("20260101_0900_alpha.md", ctx)).toBe("20260101_0900_alpha");
  });
});

describe("code by id", () => {
  test("commits in time order with their files", () => {
    const t = repo();
    const { c1, c2 } = seedCode(t);
    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);

    const r = codeResult(ctx, plans, "20260101_0900_alpha");
    expect(r.id).toBe("20260101_0900_alpha");
    expect(r.path).toBe("docs/plans/20260101_0900_alpha.md");
    expect(r.title).toBe("Alpha plan");
    expect(r.commits.map((c) => c.sha)).toEqual([c1, c2]);
    expect(r.commits[0].files).toEqual([{ status: "A", path: "src/app.ts" }]);
    expect(r.commits[1].files).toEqual([
      { status: "M", path: "src/app.ts" },
      { status: "A", path: "src/util.ts" },
    ]);
  });

  test("plan file path resolves to the same result", () => {
    const t = repo();
    seedCode(t);
    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);
    const byPath = codeResult(ctx, plans, "docs/plans/20260101_0900_alpha.md");
    const byId = codeResult(ctx, plans, "20260101_0900_alpha");
    expect(byPath).toEqual(byId);
  });

  test("id with no commits and no file: (plan file not found), no failure", () => {
    const t = repo();
    seedCode(t);
    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);

    const r = codeResult(ctx, plans, "20260303_1100_ghost");
    expect(r.path).toBe(null);
    expect(r.commits).toEqual([]);
    const human = codeHuman(r);
    expect(human.startsWith("(plan file not found)")).toBe(true);
    expect(human).toContain("20260303_1100_ghost");

    // trailer exists but the plan file does not: commits still listed
    t.write("src/ghost.ts", "g\n");
    const cg = t.commit(["src/ghost.ts"], "ghost work", {
      date: "2026-01-04T09:00:00 +0000",
      plans: ["20260303_1100_ghost"],
    });
    const r2 = codeResult(ctx, discoverPlans(ctx), "20260303_1100_ghost");
    expect(r2.path).toBe(null);
    expect(r2.commits.map((c) => c.sha)).toEqual([cg]);
  });
});

describe("code through the CLI", () => {
  test("human output lists commits and files", () => {
    const t = repo();
    seedCode(t);
    const res = t.runCli(["code", "20260101_0900_alpha"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("commits (oldest first):");
    expect(res.stdout).toContain("M\tsrc/app.ts");
    expect(res.stdout).toContain("A\tsrc/util.ts");
  });

  test("--json carries id, plan fields and files", () => {
    const t = repo();
    seedCode(t);
    const res = t.runCli(["code", "docs/plans/20260101_0900_alpha.md", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.id).toBe("20260101_0900_alpha");
    expect(parsed.path).toBe("docs/plans/20260101_0900_alpha.md");
    expect(parsed.commits.length).toBe(2);
    expect(parsed.commits[1].files[1]).toEqual({ status: "A", path: "src/util.ts" });
  });

  test("unknown id exits 0 and prints (plan file not found)", () => {
    const t = repo();
    seedCode(t);
    const res = t.runCli(["code", "no_such_plan"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("(plan file not found)");
    expect(res.stdout).toContain("(no commits carry this plan)");
  });
});
