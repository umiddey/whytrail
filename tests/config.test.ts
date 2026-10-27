import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const homes: string[] = [];
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

function homeDir(): string {
  const home = mkdtempSync(join(tmpdir(), "whytrail-home-"));
  homes.push(home);
  return home;
}

function envFor(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "OPENROUTER_API_KEY" || value === undefined) continue;
    env[key] = value;
  }
  env.HOME = home;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function run(home: string, args: string[], extra: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: envFor(home, extra),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("whytrail config", () => {
  test("set writes mode 0600, get and list mask the key, unset removes it, unknown name exits 1", () => {
    const home = homeDir();
    const key = "sk-or-v1-hiddenkeyvalueab12";
    const hidden = run(home, ["config", "set", "openrouter-key"], {}, `${key}\n`);
    expect(hidden.code).toBe(0);
    expect(`${hidden.stdout}${hidden.stderr}`).not.toContain(key);
    const path = join(home, ".config", "whytrail", "config.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))["openrouter-key"]).toBe(key);
    const got = run(home, ["config", "get", "openrouter-key"]);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe("sk-or-…ab12\n");
    expect(got.stdout).not.toContain(key);
    const listed = run(home, ["config", "list"]);
    expect(listed.stdout).toContain("openrouter-key=sk-or-…ab12");
    expect(listed.stdout).not.toContain(key);
    expect(run(home, ["config", "set", "classify-model", "openai/gpt-4o-mini"]).code).toBe(0);
    expect(run(home, ["config", "get", "classify-model"]).stdout).toBe("openai/gpt-4o-mini\n");
    expect(run(home, ["config", "unset", "openrouter-key"]).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))["openrouter-key"]).toBeUndefined();
    expect(run(home, ["config", "get", "openrouter-key"]).code).toBe(1);
    const unknown = run(home, ["config", "set", "nope", "x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown config name");
  });

  test("OPENROUTER_API_KEY overrides the file and is still masked", () => {
    const home = homeDir();
    const fileKey = "sk-or-v1-fromfile-zzzzfile";
    const envKey = "sk-or-v1-fromenv-zzzzenv1";
    mkdirSync(join(home, ".config", "whytrail"), { recursive: true });
    const path = join(home, ".config", "whytrail", "config.json");
    writeFileSync(path, JSON.stringify({ "openrouter-key": fileKey }) + "\n");
    chmodSync(path, 0o600);
    const got = run(home, ["config", "get", "openrouter-key"], { OPENROUTER_API_KEY: envKey });
    expect(got.code).toBe(0);
    expect(got.stdout).toBe("sk-or-…env1\n");
    expect(`${got.stdout}${got.stderr}`).not.toContain(envKey);
    expect(got.stdout).not.toContain("file");
    expect(JSON.parse(readFileSync(path, "utf8"))["openrouter-key"]).toBe(fileKey);
  });
});
