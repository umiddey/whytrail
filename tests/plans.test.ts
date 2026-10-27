import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { repoContext } from "../src/git";
import { discoverPlans, planGlobs } from "../src/plans";

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

describe("plan discovery", () => {
  test("default glob finds plans, skips blockers/assets/INDEX/CANCELLED", () => {
    const t = repo();
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha plan\n\n## Goal\nmake alpha\n");
    t.write("docs/plans/20260102_1000_beta.md", "# Beta plan\n");
    t.write("docs/plans/blockers/20260103_0900_blocked.md", "# Blocked\n");
    t.write("docs/plans/assets/20260104_0900_asset.md", "# Asset\n");
    t.write("docs/plans/INDEX.md", "# Index\n");
    t.write("docs/plans/CANCELLED.md", "# Gone\n");
    t.write("docs/other/20260105_0900_elsewhere.md", "# Elsewhere\n");
    t.commit(["docs"], "plans");

    const ctx = repoContext(t.root);
    const plans = discoverPlans(ctx);
    expect(plans.map((p) => p.id)).toEqual(["20260101_0900_alpha", "20260102_1000_beta"]);
  });

  test("parses title, date stamp and first Goal line", () => {
    const t = repo();
    t.write(
      "docs/plans/20260101_0905_alpha.md",
      "# Alpha plan\n\nsome intro\n\n## Goal\nmake alpha real\n\n## Steps\n- one\n",
    );
    t.commit(["docs"], "plan");

    const plans = discoverPlans(repoContext(t.root));
    expect(plans.length).toBe(1);
    const p = plans[0];
    expect(p.id).toBe("20260101_0905_alpha");
    expect(p.path).toBe("docs/plans/20260101_0905_alpha.md");
    expect(p.title).toBe("Alpha plan");
    expect(p.date).toBe("2026-01-01 09:05");
    expect(p.goal).toBe("make alpha real");
  });

  test("oldest first ordering, undated plans last", () => {
    const t = repo();
    t.write("docs/plans/20260202_1000_beta.md", "# Beta\n");
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha\n");
    t.write("docs/plans/undated.md", "# Undated\n");
    t.commit(["docs"], "plans");

    const plans = discoverPlans(repoContext(t.root));
    expect(plans.map((p) => p.id)).toEqual([
      "20260101_0900_alpha",
      "20260202_1000_beta",
      "undated",
    ]);
  });

  test(".whytrail.json plans globs replace the default", () => {
    const t = repo();
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha\n");
    t.write("notes/20260201_1200_note.md", "# Note\n");
    t.write(".whytrail.json", JSON.stringify({ plans: ["notes/**/*.md"] }));
    t.commit(["docs", "notes", ".whytrail.json"], "cfg");

    expect(planGlobs(t.root)).toEqual(["notes/**/*.md"]);
    const plans = discoverPlans(repoContext(t.root));
    expect(plans.map((p) => p.id)).toEqual(["20260201_1200_note"]);
  });

  test(".whytrail.json without plans key falls back to the default", () => {
    const t = repo();
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha\n");
    t.write(".whytrail.json", JSON.stringify({ other: true }));
    t.commit(["docs", ".whytrail.json"], "cfg");

    expect(planGlobs(t.root)).toEqual(["docs/plans/**/*.md"]);
    expect(discoverPlans(repoContext(t.root)).map((p) => p.id)).toEqual([
      "20260101_0900_alpha",
    ]);
  });

  test("discovery works from a linked worktree (main checkout via git-common-dir)", () => {
    const t = repo();
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha\n");
    t.write("src/a.ts", "a\n");
    t.commit(["docs", "src"], "c1");

    const wt = join(t.root, "..", "whytrail-test-wt");
    try {
      t.git(["worktree", "add", "-q", wt, "-b", "side"]);
      const ctx = repoContext(wt);
      expect(ctx.mainRoot).toBe(t.root);
      const plans = discoverPlans(ctx);
      expect(plans.map((p) => p.id)).toEqual(["20260101_0900_alpha"]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
