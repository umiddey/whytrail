# whytrail

Links plan files to the code they changed, both ways, in time order.

Every feature starts life as a plan file (`docs/plans/<YYYYMMDD_HHMM>_<name>.md`), and every commit that implements it carries a `Plan:` trailer. whytrail answers two questions from that:

- `whytrail why <file>` — which plans are behind these lines, oldest first.
- `whytrail code <plan>` — which commits and files this plan changed.

It also backfills links for old commits that predate the trailer convention into a committed `.whytrail/links.jsonl`, each link with a source and a confidence, and lists the unsure ones for you to accept or reject. It reads git (`log`, `blame`, `show`, `rev-list`); it never rewrites history, amends, or pushes. Matching is deterministic unless an OpenRouter key is set. With a key, leftover commits inside a measured date window can be linked by embedding, and plans without story lines can be labeled by a classify model. With no key, those stay unclassified and whytrail says so in one line.

## Install

Requires [Bun](https://bun.sh).

```sh
# once published (v0.1.0):
bun add -g whytrail        # or: npm install -g whytrail

# from a checkout:
bun install
bun src/cli.ts --help
```

## Commands

```
whytrail why <file>[:<from>[-<to>]] [--json]
whytrail code <plan-id|path> [--json]
whytrail install | uninstall
whytrail backfill [--dry-run] [--since <date>] [--repo <path>]
whytrail labels [--json]
whytrail review [--sample <n>] [--accept|--reject <sha> <plan-id>]
whytrail config set <name> [value]
whytrail config get <name>
whytrail config list
whytrail config unset <name>
whytrail --help
```

`--repo <path>` is a global flag: point whytrail at any repository from anywhere.

### `whytrail why <file>[:<from>[-<to>]]`

Every plan behind a file's lines, oldest first — each with its date, title, first `Goal:` line, current plan path, and the commits that touch it (short SHA, date, subject). With `:<from>[-<to>]` the lines are resolved with `git blame --line-porcelain`; without a range, with `git log --follow`. `--json` emits the same result as JSON.

### `whytrail code <plan-id|path>`

The commits carrying that plan's id and the files they changed, in time order. Takes the plan id (the file's basename without `.md`) or its path. Results also include links recorded in `.whytrail/links.jsonl`: accepted review decisions count, rejected ones never show.

### `whytrail install` / `whytrail uninstall`

Installs `prepare-commit-msg` and `commit-msg` hooks into the repo's common git dir (or `core.hooksPath` if set). A hook already in place is kept as `<hook>.whytrail-chained`, called first, its exit code kept. Installing twice is a no-op; `uninstall` restores the previous state.

### `whytrail backfill [--dry-run] [--since <date>]`

Computes links for existing commits and writes `.whytrail/links.jsonl` into the repo's main checkout root. Idempotent — a re-run adds nothing — and never overwrites a `review` decision. `--dry-run` only prints what would be added (plus per-source/confidence totals); `--since <date>` limits the commits considered by author date.

### `whytrail review [--accept|--reject <sha> <plan-id>]`

Bare `whytrail review` lists the unsure links: low-confidence ones, and any commit linked to more than one plan. Decide with `--accept <sha> <plan-id>` or `--reject <sha> <plan-id>`; the decision is stored in `links.jsonl` and respected by `why`, `code`, and later backfills.

### `whytrail labels [--json]`

One label per plan, oldest first: `bad (bug|perf|taste) by <later plan>: "<its first Goal line>"` when a later bug, perf, or taste plan builds on it; `good` when the plan is at least 14 days old and no such plan builds on it; otherwise `open`. A later feature or change plan changes nothing. Labels come from `.whytrail/cards.jsonl`, not from re-reading plan bodies.

### `whytrail config`

`set`, `get`, `list`, and `unset` for `openrouter-key`, `classify-model`, and `embed-model`. The file is `~/.config/whytrail/config.json`, mode 0600. `set openrouter-key` with no value asks with hidden input, so the key stays out of shell history. `get` and `list` show the key masked (`sk-or-…ab12`), never whole. `OPENROUTER_API_KEY` wins over the file. Unknown names exit 1.

## Plan discovery

Plans are found in the repo's **main checkout** (resolved via `git rev-parse --git-common-dir`, so every command works from any worktree). Globs come from `.whytrail.json`'s `"plans"` array, default `docs/plans/**/*.md`. Files named `INDEX.md` or `CANCELLED.md` and anything under `blockers/` or `assets/` are skipped. A plan's id is its file basename without `.md` (e.g. `20261025_1440_whytrail_v1`), so links survive moving a plan into `docs/plans/archive/`. Title is the first `# ` heading; the date comes from the `YYYYMMDD_HHMM` stamp in the file name.

## The `Plan:` trailer convention

```
feat: add jurisdiction validator

Plan: 20260827_1344_jurisdiction_content_location_validator
```

- `prepare-commit-msg` appends `Plan: <id>` when `WHYTRAIL_PLAN` is set, or when exactly one discovered plan's `Branch:` line equals the current branch. It never duplicates an existing `Plan:`, and it appends inside the existing trailer paragraph (git reads only the last paragraph as trailers, so a separate paragraph would be ignored).
- `commit-msg` refuses (exit 1) any commit without a `Plan: <id>` trailer. Merge, revert, `fixup!` and `squash!` commits are exempt. Opting out for one commit is explicit: `Plan: none - <reason>`.
- Several `Plan:` trailers in one commit are fine — that commit belongs to several plans.

## `.whytrail/links.jsonl`

One JSON object per line:

```json
{"commit":"1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b","plan":"20260827_1344_jurisdiction_content_location_validator","source":"trailer","confidence":"high"}
```

Fields: `commit` (full SHA), `plan` (plan id), `source`, `confidence`, and — only on recorded review decisions — `decision` (`"accept"` or `"reject"`).

Sources, in the order backfill tries them (first match wins):

| source | confidence | matched when |
| --- | --- | --- |
| `trailer` | high | the commit carries a `Plan: <id>` trailer naming the plan |
| `co-commit` | high, or low if the commit touches more than 100 files | the commit changes the plan file and other files together |
| `memory-log` | medium | `docs/memory/<plan-id>.md` lists files under a `FILES MODIFIED` / `Files changed` / `Files` heading, and a commit dated on/after the plan changes one of them |
| `progress-sha` | high | the plan text cites the commit's SHA (abbreviated or full) |
| `branch` | high | the plan's `Branch:` line matches a `Merge branch '<branch>'` commit; the branch's commits and the merge link to the plan |
| `date-files` | low | only a date match (commit day = plan day) plus a non-`.md` code path cited anywhere in the plan text |
| `cited-path` | medium | the plan names a non-`.md` file the commit changes, and no cheaper source matched |
| `semantic` | medium at similarity ≥ 0.8, otherwise low | embedding similarity of plan text vs commit message + diff summary, only for commits with no cheaper link, and only inside the measured date window |
| `review` | review | your explicit `--accept`/`--reject` decision; overrides backfill and is never overwritten by it |

A commit touching more than 100 files (a bulk snapshot) still gets `co-commit` links, but at low confidence.

`whytrail backfill` measures date windows from the high-confidence links: the 95th percentile (nearest rank, `ceil(0.95 * n)`) of code-date minus plan-date when the plan is first, and of plan-date minus code-date when the plan is later. It writes `.whytrail/windows.json` and prints the percentiles. Semantic linking does not guess a window when there are no high-confidence samples.

## OpenRouter

Key: `OPENROUTER_API_KEY`, else `openrouter-key` in `~/.config/whytrail/config.json`. Model ids: the home file (`classify-model`, `embed-model`), else `.whytrail/config.json` (`classify_model`, `embed_model`), else `openai/gpt-4o-mini` and `openai/text-embedding-3-small`. Chat completions use a JSON schema; embeddings use `/embeddings`. No SDK. Confidence below 0.8 is not kept: the plan stays `unclassified`.

## `.whytrail/cards.jsonl`

One card per plan blob. A plan whose blob hash is unchanged is not sent to the classifier again. Fields: `blob`, `plan`, `born` (`bug|perf|feature|change|taste`), `builds_on`, `files`, `outcome`, `confidence`, `source` (`field` | `llm` | `unclassified`), and `goal` (the first Goal line, stored so labels do not re-read the plan). Plans that already have `Born from:` or `Builds on:` lines are read as-is (`source: field`, confidence 1). In a lineage, newer cards weigh more: `0.5^(age_days/30)`.

`whytrail review --sample 30` prints 30 random `llm` cards for hand-checking.

## Development

```sh
bun test
```

Tests build their own throwaway git repos; no test reads or writes a real repository.
