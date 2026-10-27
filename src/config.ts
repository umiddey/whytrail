// User settings. The repo's write-side only writes links and hooks, not a 0600 home file.
import { chmodSync, existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_NAMES = ["openrouter-key", "classify-model", "embed-model"] as const;
export type ConfigName = (typeof CONFIG_NAMES)[number];

export const NO_KEY_LINE = "whytrail: no OpenRouter key; using non-AI links only\n";

export function configPath(home: string = homedir()): string {
  return join(home, ".config", "whytrail", "config.json");
}

export function isConfigName(name: string): name is ConfigName {
  return (CONFIG_NAMES as readonly string[]).includes(name);
}

export function readConfig(home: string = homedir()): Partial<Record<ConfigName, string>> {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Partial<Record<ConfigName, string>> = {};
  for (const name of CONFIG_NAMES) {
    const value = raw[name];
    if (typeof value === "string" && value.length > 0) out[name] = value;
  }
  return out;
}

export function writeConfig(data: Partial<Record<ConfigName, string>>, home: string = homedir()): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const stored: Partial<Record<ConfigName, string>> = {};
  for (const name of CONFIG_NAMES) {
    if (data[name]) stored[name] = data[name];
  }
  writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** `sk-or-…ab12` — never the whole secret. */
export function maskSecret(value: string): string {
  if (value.length <= 10) return "…";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function displayValue(name: string, value: string): string {
  return name === "openrouter-key" ? maskSecret(value) : value;
}

export function resolveKey(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readConfig(home)["openrouter-key"]?.trim();
  return fromFile || null;
}

export type RepoModels = { classify?: string; embed?: string };

export function readRepoModels(repoRoot: string): RepoModels {
  const path = join(repoRoot, ".whytrail", "config.json");
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as { classify_model?: unknown; embed_model?: unknown };
  return {
    classify: typeof raw.classify_model === "string" ? raw.classify_model : undefined,
    embed: typeof raw.embed_model === "string" ? raw.embed_model : undefined,
  };
}

export function resolveModels(
  repoRoot: string | null,
  home: string = homedir(),
  defaults: { classify: string; embed: string },
): { classify: string; embed: string } {
  const user = readConfig(home);
  const repo = repoRoot ? readRepoModels(repoRoot) : {};
  return {
    classify: user["classify-model"] || repo.classify || defaults.classify,
    embed: user["embed-model"] || repo.embed || defaults.embed,
  };
}

function readHidden(prompt: string): string {
  process.stderr.write(prompt);
  if (process.stdin.isTTY) {
    const proc = Bun.spawnSync(["bash", "-c", "IFS= read -rs line; printf '%s' \"$line\""], {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
    });
    process.stderr.write("\n");
    if ((proc.exitCode ?? 1) !== 0) throw new Error("could not read hidden input");
    return proc.stdout.toString();
  }
  let line = "";
  const buf = Buffer.alloc(1);
  while (true) {
    const n = readSync(0, buf, 0, 1, null);
    if (n === 0) break;
    const ch = buf.toString("utf8", 0, n);
    if (ch === "\n") break;
    line += ch;
  }
  return line.replace(/\r$/, "");
}

function fail(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 1;
}

export function runConfig(argv: string[], home: string = homedir(), env: NodeJS.ProcessEnv = process.env): number {
  const sub = argv[0];
  if (sub !== "set" && sub !== "get" && sub !== "list" && sub !== "unset") {
    return fail("usage: whytrail config set|get|list|unset");
  }
  try {
    if (sub === "list") {
      const cfg = readConfig(home);
      const lines: string[] = [];
      for (const name of CONFIG_NAMES) {
        const value = name === "openrouter-key" ? resolveKey(env, home) : cfg[name];
        if (!value) continue;
        lines.push(`${name}=${displayValue(name, value)}`);
      }
      process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
      return 0;
    }
    const name = argv[1];
    if (!name || !isConfigName(name)) return fail(`unknown config name: ${name ?? "(missing)"}`);
    if (sub === "get") {
      const value = name === "openrouter-key" ? resolveKey(env, home) : readConfig(home)[name];
      if (!value) return fail(`${name} is not set`);
      process.stdout.write(displayValue(name, value) + "\n");
      return 0;
    }
    if (sub === "unset") {
      const cfg = readConfig(home);
      delete cfg[name];
      writeConfig(cfg, home);
      process.stdout.write(`unset ${name}\n`);
      return 0;
    }
    let value = argv.slice(2).join(" ");
    if (!value) {
      if (name !== "openrouter-key") return fail(`${name} needs a value`);
      value = readHidden("openrouter-key (hidden): ");
    }
    if (!value.trim()) return fail("empty value");
    const cfg = readConfig(home);
    cfg[name] = value.trim();
    writeConfig(cfg, home);
    process.stdout.write(`set ${name}\n`);
    return 0;
  } catch (e) {
    return fail((e as Error).message);
  }
}
