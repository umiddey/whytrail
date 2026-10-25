import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";

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

describe("cli basics", () => {
  test("--help exits 0 and mentions the why command", () => {
    const t = repo();
    const res = t.runCli(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("whytrail why");
    expect(res.stdout).toContain("whytrail code");
  });

  test("no args and unknown commands exit 1 with usage on stderr", () => {
    const t = repo();
    expect(t.runCli([]).code).toBe(1);
    expect(t.runCli(["nonsense"]).code).toBe(1);
    const missing = t.runCli(["why"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("needs an argument");
  });

  test("outside a git repository: exit 1, clear error", () => {
    const plain = mkdtempSync(join(tmpdir(), "whytrail-norepo-"));
    try {
      const t = repo();
      const res = t.runCli(["why", "src/a.ts"], plain);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain("not a git repository");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("broken .whytrail.json fails loudly", () => {
    const t = repo();
    t.write("docs/plans/20260101_0900_alpha.md", "# Alpha\n");
    t.write(".whytrail.json", "{ not json");
    t.commit(["docs", ".whytrail.json"], "cfg");
    const res = t.runCli(["why", "docs/plans/20260101_0900_alpha.md"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not valid JSON");
  });
});
