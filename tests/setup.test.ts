// `whytrail setup` tests: temp repos and temp HOME only; stdin is piped, never a real TTY.

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempRepo, removeRepo, type TempRepo } from "./helpers/repo";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let made: TempRepo[] = [];
function repo(): TempRepo {
  const r = makeTempRepo();
  made[made.length] = r;
  return r;
}
let homes: string[] = [];
function homeDir(): string {
  const h = mkdtempSync(join(tmpdir(), "whytrail-home-"));
  homes[homes.length] = h;
  return h;
}
afterEach(() => {
  for (const r of made) removeRepo(r);
  made = [];
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes = [];
});

function envFor(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "OPENROUTER_API_KEY" || value === undefined) continue;
    env[key] = value;
  }
  env.HOME = home;
  return env;
}

function runSetupCli(root: string, home: string, args: string[], stdin?: string) {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: root,
    env: envFor(home),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** every file under root (including .git) as path:content-hash, so a byte compare can prove a run changed nothing */
function treeHash(root: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[out.length] = `${p.slice(root.length)}:${Bun.hash(readFileSync(p)).toString(16)}`;
    }
  };
  walk(root);
  return out.join("\n");
}

function cpShape(): TempRepo {
  const t = repo();
  for (const p of [
    "docs/plans/immediate/20260101_1000_i1.md",
    "docs/plans/immediate/20260102_1000_i2.md",
    "docs/plans/immediate/20260103_1000_i3.md",
    "docs/plans/drafts/note.md",
    "docs/memory/20260104_0900_m1.md",
    "docs/memory/20260105_0900_m2.md",
    "docs/memory/20260106_0900_m3.md",
    "src/a.ts",
  ]) t.write(p, "# p\n");
  t.commit(["docs", "src"], "c1");
  return t;
}

function pmShape(): TempRepo {
  const t = repo();
  for (const p of [
    "docs/plans/20260101_1000_p1.md",
    "docs/plans/20260102_1000_p2.md",
    "docs/plans/20260103_1000_p3.md",
    "docs/memory/20260101_0900_m1.md",
    "docs/memory/20260102_0900_m2.md",
    "docs/memory/20260103_0900_m3.md",
  ]) t.write(p, "# p\n");
  t.commit(["docs"], "c1");
  return t;
}

describe("whytrail setup", () => {
  test("--yes on a CP-shaped repo proposes docs/plans, skips drafts/, writes config, ends with a why", () => {
    const t = cpShape();
    const r = runSetupCli(t.root, homeDir(), ["setup", "--yes"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines.some((l) => l.startsWith("plans: docs/plans/**/*.md"))).toBe(true);
    expect(lines.some((l) => l.startsWith("skips: ") && l.includes("drafts/") && l.includes("blockers/"))).toBe(true);
    expect(lines.some((l) => l.startsWith("plans:") && l.includes("docs/memory"))).toBe(false);
    expect(lines).toContain("config: wrote .whytrail.json");
    expect(lines).toContain("key: none");
    expect(lines.some((l) => l.startsWith("models: classify="))).toBe(true);
    expect(lines).toContain("hooks: installed");
    expect(lines.some((l) => l.startsWith("backfill: 4 new links") && l.includes("co-commit high: 4"))).toBe(true);
    expect(lines).toContain("backfill: wrote 4 links");
    expect(lines).toContain("why: src/a.ts -> 20260101_1000_i1");
    const cfg = JSON.parse(readFileSync(join(t.root, ".whytrail.json"), "utf8"));
    expect(cfg.skip).toContain("drafts/");
    expect(cfg.plans).toBeUndefined();
  });

  test("second --yes run on the same repo: unchanged everywhere, byte-identical tree", () => {
    const t = cpShape();
    const home = homeDir();
    runSetupCli(t.root, home, ["setup", "--yes"]);
    const before = treeHash(t.root);
    const r = runSetupCli(t.root, home, ["setup", "--yes"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines).toContain("config: unchanged");
    expect(lines).toContain("hooks: unchanged");
    expect(lines).toContain("backfill: unchanged");
    expect(lines).not.toContain("hooks: installed");
    expect(treeHash(t.root)).toBe(before);
  });

  test("--yes on a PM-shaped repo proposes the default and writes no .whytrail.json", () => {
    const t = pmShape();
    const r = runSetupCli(t.root, homeDir(), ["setup", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("config: unchanged");
    expect(existsSync(join(t.root, ".whytrail.json"))).toBe(false);
  });

  test("interactive plans edit writes .whytrail.json with the edited glob list", () => {
    const t = pmShape();
    const r = runSetupCli(t.root, homeDir(), ["setup"], "docs/plans/**/*.md, notes/**/*.md\n\n\n\n");
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("config: wrote .whytrail.json");
    expect(JSON.parse(readFileSync(join(t.root, ".whytrail.json"), "utf8")).plans).toEqual([
      "docs/plans/**/*.md",
      "notes/**/*.md",
    ]);
  });

  test("--yes never prompts for the key and never writes the HOME config", () => {
    const t = pmShape();
    const home = homeDir();
    const r = runSetupCli(t.root, home, ["setup", "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".config", "whytrail", "config.json"))).toBe(false);
    expect(`${r.stdout}${r.stderr}`).not.toContain("sk-or-");
  });

  test("usage lists setup", () => {
    const t = repo();
    const r = runSetupCli(t.root, homeDir(), ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("whytrail setup");
  });
});
