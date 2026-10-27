// Temp git repo fixture builder. Tests never touch a real repo.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export type GitOpts = { date?: string };

export type TempRepo = {
  root: string;
  git(args: string[], opts?: GitOpts): string;
  write(rel: string, content: string): void;
  /** git add the given paths, then commit; extra -m paragraphs become Plan: trailers */
  commit(paths: string[], message: string, opts?: GitOpts & { plans?: string[] }): string;
  runCli(args: string[], cwd?: string): { code: number; stdout: string; stderr: string };
};

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

export function makeTempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), "whytrail-test-"));

  const gitRaw = (args: string[], opts?: GitOpts, cwd: string = root) => {
    const env: Record<string, string> = { ...process.env };
    if (opts?.date) {
      env.GIT_AUTHOR_DATE = opts.date;
      env.GIT_COMMITTER_DATE = opts.date;
    }
    const p = Bun.spawnSync(["git", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };

  const repo: TempRepo = {
    root,
    git(args, opts?) {
      const r = gitRaw(args, opts);
      if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    },
    write(rel, content) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    commit(paths, message, opts = {}) {
      repo.git(["add", ...paths]);
      const args = ["commit", "-m", message];
      const plans = opts.plans ?? [];
      if (plans.length > 0) {
        // trailers must share ONE paragraph: git reads only the last one
        args[args.length] = "-m";
        args[args.length] = plans.map((p) => `Plan: ${p}`).join("\n");
      }
      repo.git(args, { date: opts.date });
      return repo.git(["rev-parse", "HEAD"]).trim();
    },
    runCli(args, cwd = root) {
      const p = Bun.spawnSync(["bun", "run", CLI, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
    },
  };

  repo.git(["init", "-q", "-b", "main"]);
  repo.git(["config", "user.email", "test@example.com"]);
  repo.git(["config", "user.name", "whytrail test"]);
  repo.git(["config", "commit.gpgsign", "false"]);
  return repo;
}

export function removeRepo(repo: TempRepo): void {
  rmSync(repo.root, { recursive: true, force: true });
}
