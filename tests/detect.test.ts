// Plan folder detection for `whytrail setup` (P2): pure function over git ls-files output.

import { describe, test, expect, afterEach } from "bun:test";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";
import { detectPlanFolders } from "../src/detect";

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

describe("plan folder detection", () => {
  test("CP shape: docs/plans root wins, drafts sub-folder proposed as skip, docs/memory excluded", () => {
    const t = repo();
    for (const p of [
      "docs/memory/20260101_0900_m1.md",
      "docs/memory/20260102_0900_m2.md",
      "docs/memory/20260103_0900_m3.md",
      "docs/plans/immediate/20260101_1000_i1.md",
      "docs/plans/immediate/20260102_1000_i2.md",
      "docs/plans/immediate/20260103_1000_i3.md",
      "docs/plans/improvements/20260104_1000_imp1.md",
      "docs/plans/improvements/20260105_1000_imp2.md",
      "docs/plans/improvements/20260106_1000_imp3.md",
      "docs/plans/archive/202609/20260107_1000_a1.md",
      "docs/plans/archive/202609/20260108_1000_a2.md",
      "docs/plans/archive/202609/20260109_1000_a3.md",
      "docs/plans/drafts/note.md",
      "docs/plans/INDEX.md",
    ]) t.write(p, "# p\n");
    t.commit(["docs"], "plans");
    const tracked = t.git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
    const d = detectPlanFolders(tracked);
    expect(d.globs).toEqual(["docs/plans/**/*.md"]);
    expect(d.skips).toEqual(["drafts/"]);
    expect(d.other).toEqual([]);
  });

  test("PM shape: flat docs/plans, docs/memory never proposed", () => {
    const t = repo();
    for (const p of [
      "docs/memory/20260101_0900_m1.md",
      "docs/memory/20260102_0900_m2.md",
      "docs/memory/20260103_0900_m3.md",
      "docs/plans/20260101_1000_p1.md",
      "docs/plans/20260102_1000_p2.md",
      "docs/plans/20260103_1000_p3.md",
    ]) t.write(p, "# p\n");
    t.commit(["docs"], "plans");
    const tracked = t.git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
    const d = detectPlanFolders(tracked);
    expect(d.globs).toEqual(["docs/plans/**/*.md"]);
    expect(d.skips).toEqual([]);
    expect(d.other).toEqual([]);
  });

  test("neurastream shape: archive joins the root, blockers (.sh only) and stamped briefs are no skips", () => {
    const t = repo();
    for (const p of [
      "docs/plans/20260101_1000_p1.md",
      "docs/plans/20260102_1000_p2.md",
      "docs/plans/20260103_1000_p3.md",
      "docs/plans/archive/202610/20260104_1000_a1.md",
      "docs/plans/archive/202610/20260105_1000_a2.md",
      "docs/plans/archive/202610/20260106_1000_a3.md",
      "docs/plans/briefs/20260107_1000_b1.md",
      "docs/plans/blockers/scope.sh",
      "docs/plans/CANCELLED.md",
    ]) t.write(p, "# p\n");
    t.commit(["docs"], "plans");
    const tracked = t.git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
    const d = detectPlanFolders(tracked);
    expect(d.globs).toEqual(["docs/plans/**/*.md"]);
    expect(d.skips).toEqual([]);
    expect(d.other).toEqual([]);
  });

  test("stamped files outside any plan folder are listed with counts, root under threshold has no glob", () => {
    const t = repo();
    t.write("notes/20260101_1000_n1.md", "# n\n");
    t.write("notes/20260102_1000_n2.md", "# n\n");
    t.write("docs/plans/20260103_1000_p1.md", "# p\n");
    t.commit(["notes", "docs"], "plans");
    const tracked = t.git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
    const d = detectPlanFolders(tracked);
    expect(d.globs).toEqual([]);
    expect(d.other).toEqual([{ folder: "notes", count: 2 }]);
  });

  test("no stamped files: empty detection", () => {
    const t = repo();
    t.write("README.md", "# r\n");
    t.commit(["README.md"], "init");
    const tracked = t.git(["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean);
    expect(detectPlanFolders(tracked)).toEqual({ globs: [], skips: [], other: [] });
  });
});
