// Plan cards and story labels. Lineage queries read cards, never plan bodies.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitOut } from "./git";
import type { RepoCtx } from "./git";
import type { PlanFile } from "./plans";
import { firstGoalLine, stampToDate } from "./plans";
import { planCodePaths } from "./write-side";

export const KEEP_CONFIDENCE = 0.8;
export const GOOD_AFTER_DAYS = 14;

export type Born = "bug" | "perf" | "feature" | "change" | "taste";
export type CardSource = "field" | "llm" | "unclassified";

export type Card = {
  blob: string;
  plan: string;
  born: Born | null;
  builds_on: string[];
  files: string[];
  outcome: string;
  confidence: number;
  source: CardSource;
  /** Stored so labels can quote the Goal line without re-reading the plan. */
  goal: string | null;
};

export type ClassifyInput = {
  plan: string;
  goalSection: string;
  candidates: { plan: string; goal: string | null }[];
};

export type ClassifyAnswer = {
  born: Born;
  outcome: string;
  confidence: number;
  builds_on: { plan: string; yes: boolean; confidence: number }[];
};
const BORN_OK: Record<string, true> = { bug: true, perf: true, feature: true, change: true, taste: true };
const BAD_BORN: Record<string, true> = { bug: true, perf: true, taste: true };
export type ClassifyFn = (input: ClassifyInput) => Promise<ClassifyAnswer> | ClassifyAnswer;


export function cardsPath(root: string): string {
  return join(root, ".whytrail", "cards.jsonl");
}

export function readCards(root: string): Card[] {
  const path = cardsPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Card);
}

export function writeCards(root: string, cards: Card[]): void {
  const path = cardsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cards.length ? cards.map((card) => JSON.stringify(card)).join("\n") + "\n" : "");
}

export function stampMs(id: string): number | null {
  const stamp = stampToDate(id);
  if (!stamp) return null;
  const ms = Date.parse(stamp.replace(" ", "T") + ":00Z");
  return Number.isFinite(ms) ? ms : null;
}

export function ageDays(planId: string, nowMs: number): number | null {
  const ms = stampMs(planId);
  if (ms === null) return null;
  return (nowMs - ms) / 86_400_000;
}

/** Newer cards weigh more. age 0 → 1, age 30 days → 0.5. */
export function lineageWeight(ageDaysValue: number): number {
  return 0.5 ** (ageDaysValue / 30);
}

export function goalSection(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{1,6}\s+goal\b/i.test(lines[i])) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{1,6}\s/.test(lines[j])) break;
      body.push(lines[j]);
    }
    return body.join("\n").trim();
  }
  return "";
}

function parseBorn(text: string): Born | null {
  const match = text.match(/^Born from:\s*(bug|perf|feature|change|taste)\s*$/im);
  if (!match) return null;
  const born = match[1].toLowerCase() as Born;
  return BORN_OK[born] ? born : null;
}

function parseBuildsOn(text: string, self: string): string[] {
  const match = text.match(/^Builds on:\s*(.+)\s*$/im);
  if (!match) return [];
  const ids: string[] = [];
  for (const part of match[1].split(",")) {
    const id = part.trim();
    if (id && id !== self && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function hasStoryField(text: string): boolean {
  return /^Born from:\s*\S/im.test(text) || /^Builds on:\s*\S/im.test(text);
}

export function classifyPrompt(input: ClassifyInput): string {
  const candidates = input.candidates.length
    ? input.candidates.map((c) => `- ${c.plan}: ${c.goal ?? "(no goal)"}`).join("\n")
    : "(none)";
  return [
    `Plan ${input.plan}`,
    "Born is one of bug, perf, feature, change, taste. taste = the owner disliked a working thing.",
    "For each candidate, yes only if this plan continues or replaces that plan's work.",
    "Goal section:",
    input.goalSection || "(empty)",
    "Candidates:",
    candidates,
  ].join("\n");
}

export function answerFromModel(raw: unknown, allowed: string[]): ClassifyAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ClassifyAnswer>;
  if (typeof row.born !== "string" || !BORN_OK[row.born]) return null;
  if (typeof row.outcome !== "string" || typeof row.confidence !== "number") return null;
  if (!Array.isArray(row.builds_on)) return null;
  const builds: ClassifyAnswer["builds_on"] = [];
  for (const item of row.builds_on) {
    if (!item || typeof item !== "object") return null;
    const pair = item as { plan?: unknown; yes?: unknown; confidence?: unknown };
    if (typeof pair.plan !== "string" || typeof pair.yes !== "boolean" || typeof pair.confidence !== "number") return null;
    if (!allowed.includes(pair.plan)) continue;
    builds.push({ plan: pair.plan, yes: pair.yes, confidence: pair.confidence });
  }
  return { born: row.born as Born, outcome: row.outcome.trim().slice(0, 200), confidence: row.confidence, builds_on: builds };
}

export type PlanInput = { id: string; blob: string; readText: () => string };

function byAge(a: string, b: string): number {
  const am = stampMs(a);
  const bm = stampMs(b);
  if (am === null && bm === null) return a < b ? -1 : a > b ? 1 : 0;
  if (am === null) return 1;
  if (bm === null) return -1;
  if (am !== bm) return am - bm;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cardFromText(blob: string, id: string, text: string, source: CardSource, extra?: Partial<Card>): Card {
  return {
    blob,
    plan: id,
    born: extra?.born ?? parseBorn(text),
    builds_on: extra?.builds_on ?? parseBuildsOn(text, id),
    files: planCodePaths(text),
    outcome: extra?.outcome ?? (firstGoalLine(text) ?? ""),
    confidence: extra?.confidence ?? (source === "field" ? 1 : 0),
    source,
    goal: firstGoalLine(text),
  };
}

export async function syncCards(args: {
  plans: PlanInput[];
  existing: Card[];
  classify: ClassifyFn | null;
}): Promise<{ cards: Card[]; current: Card[]; calls: number; aiSkipped: boolean }> {
  const byBlob = new Map(args.existing.map((card) => [card.blob, card]));
  const ordered = [...args.plans].sort((a, b) => byAge(a.id, b.id));
  const current: Card[] = [];
  let calls = 0;
  let aiSkipped = false;
  for (const plan of ordered) {
    const cached = byBlob.get(plan.blob);
    if (cached && cached.plan === plan.id) {
      current.push(cached);
      continue;
    }
    const text = plan.readText();
    if (hasStoryField(text)) {
      const card = cardFromText(plan.blob, plan.id, text, "field");
      byBlob.set(plan.blob, card);
      current.push(card);
      continue;
    }
    if (!args.classify) {
      aiSkipped = true;
      const card = cardFromText(plan.blob, plan.id, text, "unclassified", { born: null, builds_on: [], confidence: 0, outcome: "" });
      byBlob.set(plan.blob, card);
      current.push(card);
      continue;
    }
    const files = planCodePaths(text);
    const candidates = current
      .filter((card) => card.plan !== plan.id && card.files.some((file) => files.includes(file)))
      .map((card) => ({ plan: card.plan, goal: card.goal }));
    calls += 1;
    const answer = answerFromModel(await args.classify({ plan: plan.id, goalSection: goalSection(text), candidates }), candidates.map((c) => c.plan));
    if (!answer || answer.confidence < KEEP_CONFIDENCE) {
      const card = cardFromText(plan.blob, plan.id, text, "unclassified", { born: null, builds_on: [], confidence: answer?.confidence ?? 0, outcome: "" });
      byBlob.set(plan.blob, card);
      current.push(card);
      continue;
    }
    const builds = answer.builds_on
      .filter((pair) => pair.yes && pair.confidence >= KEEP_CONFIDENCE && pair.plan !== plan.id)
      .map((pair) => pair.plan);
    const card = cardFromText(plan.blob, plan.id, text, "llm", {
      born: answer.born,
      builds_on: builds,
      confidence: answer.confidence,
      outcome: answer.outcome,
    });
    byBlob.set(plan.blob, card);
    current.push(card);
  }
  return { cards: [...byBlob.values()], current, calls, aiSkipped };
}

export async function ensureCards(ctx: RepoCtx, plans: PlanFile[], classify: ClassifyFn | null): Promise<{ cards: Card[]; current: Card[]; calls: number; aiSkipped: boolean }> {
  const existing = readCards(ctx.mainRoot);
  const inputs: PlanInput[] = plans.map((plan) => ({
    id: plan.id,
    blob: gitOut(["hash-object", plan.absPath], ctx.cwd).trim(),
    readText: () => readFileSync(plan.absPath, "utf8"),
  }));
  const result = await syncCards({ plans: inputs, existing, classify });
  writeCards(ctx.mainRoot, result.cards);
  return result;
}

export type PlanLabel = {
  plan: string;
  label: "bad" | "good" | "open";
  kind?: Born;
  by?: string;
  goal?: string;
};


export function labelPlans(cards: Card[], nowMs: number): PlanLabel[] {
  const sorted = [...cards].sort((a, b) => byAge(a.plan, b.plan));
  const rows: PlanLabel[] = [];
  for (const card of sorted) {
    const builders = sorted.filter((other) =>
      other.plan !== card.plan &&
      other.source !== "unclassified" &&
      other.born !== null &&
      BAD_BORN[other.born] &&
      other.builds_on.includes(card.plan));
    if (builders.length > 0) {
      const best = builders.slice().sort((a, b) => {
        const delta = lineageWeight(ageDays(b.plan, nowMs) ?? 1e9) - lineageWeight(ageDays(a.plan, nowMs) ?? 1e9);
        if (delta !== 0) return delta;
        return a.plan < b.plan ? 1 : -1;
      })[0];
      rows.push({ plan: card.plan, label: "bad", kind: best.born ?? undefined, by: best.plan, goal: best.goal ?? "" });
      continue;
    }
    const age = ageDays(card.plan, nowMs);
    rows.push(age !== null && age >= GOOD_AFTER_DAYS ? { plan: card.plan, label: "good" } : { plan: card.plan, label: "open" });
  }
  return rows;
}

export function labelsHuman(rows: PlanLabel[]): string {
  return rows.map((row) => {
    if (row.label === "bad") return `${row.plan}\tbad (${row.kind}) by ${row.by}: "${row.goal}"`;
    return `${row.plan}\t${row.label}`;
  }).join("\n") + (rows.length ? "\n" : "");
}

export function sampleCards(cards: Card[], n: number, rng: () => number = Math.random): Card[] {
  const llm = cards.filter((card) => card.source === "llm");
  const copy = llm.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy.slice(0, Math.max(0, n));
}
