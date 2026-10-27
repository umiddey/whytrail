// Thin sync wrapper around the git CLI. whytrail only reads git.

export type GitRun = {
  code: number;
  stdout: string;
  stderr: string;
};

export function git(args: string[], cwd: string = process.cwd()): GitRun {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    code: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

export function gitOut(args: string[], cwd: string = process.cwd()): string {
  const r = git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${r.code}): ${r.stderr.trim()}`);
  }
  return r.stdout;
}

export type RepoCtx = {
  /** directory the command ran in */
  cwd: string;
  /** working tree of the checkout the user is in (a worktree counts) */
  toplevel: string;
  /** working tree of the repo's main checkout; plan files live here */
  mainRoot: string;
};

export function repoContext(cwd: string = process.cwd()): RepoCtx {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  const common = gitOut(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  ).trim();
  // common dir is e.g. <mainRoot>/.git; its parent is the main checkout
  const mainRoot = common.replace(/\/\.git$/, "").replace(/\/$/, "");
  return { cwd, toplevel: top.stdout.trim(), mainRoot };
}
