# Changelog

## 0.3.0 (2026-11-04)

### Added

- `whytrail setup [--repo <path>] [--yes]` — detects plan folders from the tracked stamped files, asks for the OpenRouter key (hidden) and models, installs the hooks, previews then writes the backfill, and ends with a real `why` answer on the most-changed code file of the last 30 days. Re-running on an unchanged repo changes no file. (P3)
- `whytrail config set|get|list|unset` now also reads and writes the repo-level `plans` and `skip` in `.whytrail.json` (comma lists, written only when they differ from the defaults). The three HOME names behave exactly as before. (P3b)
- `.whytrail.json` accepts a `"skip"` array (entries ending in `/` are directory names skipped at any depth, the rest are file names; default `["INDEX.md", "CANCELLED.md", "blockers/", "assets/"]`). (P1)

## 0.2.2 (2026-10-27)

### Fixed

- `memory-log` counts only when the commit date is inside the same measured window `cited-path` uses, measured in that backfill run. (P3f)

## 0.2.1 (2026-10-27)

### Added

- Every `.whytrail/links.jsonl` line carries `files`: the code files that commit changed (`.md` excluded, sorted). A re-run fills only that field on old lines; review decisions stay. (P3e)

### Fixed

- `cited-path` counts only when the commit date is inside the measured window from `.whytrail/windows.json` (fallback when not measured: 3 days before the plan date, 1 day after the last Progress date, or the plan date when Progress has none). (P3c)
- `cited-path` uses the windows measured from high-confidence links in the same backfill run, including `--dry-run`, instead of the 3-day/1-day fallback. A real run still writes `.whytrail/windows.json`. (P3d)

## 0.2.0 (2026-10-27)

### Added

- `whytrail labels` — story labels (`bad` / `good` / `open`) from plan lineage, cached in `.whytrail/cards.jsonl` by git blob hash. OpenRouter classifies plans that have no `Born from` / `Builds on` lines; no key leaves them `unclassified`. (P3b)
- `whytrail config set|get|list|unset` — OpenRouter key and model ids in `~/.config/whytrail/config.json` (mode 0600). The key is masked on output; `OPENROUTER_API_KEY` wins. (P3b)
- Backfill sources `cited-path` and `semantic`, measured date windows in `.whytrail/windows.json`, and low confidence for co-commit links from commits that touch more than 100 files. (P3b)

## 0.1.1 - 2026-10-27

### Changed

- Releases publish from GitHub Actions on every push to main with a new version, through npm trusted publishing (provenance attached); no token.

## 0.1.0 - 2026-10-26

First release: link plan files and code both ways, in time order.

### Added

- `whytrail why <file>[:<from>[-<to>]] [--json]` — every plan behind a file's lines, oldest first, each with date, title, first Goal line, current plan path, and the commits (`git blame` for line ranges, `git log --follow` without). (P1)
- `whytrail code <plan-id|path> [--json]` — the commits carrying that plan's id and the files they changed, in time order. (P1)
- Plan discovery in the repo's main checkout (via `git rev-parse --git-common-dir`, so it works from any worktree): globs from `.whytrail.json` `"plans"` (default `docs/plans/**/*.md`), skipping `blockers/`, `assets/`, `INDEX.md`, `CANCELLED.md`; plan id = file basename without `.md`, so links survive archiving. (P1)
- `whytrail install` / `whytrail uninstall` — `prepare-commit-msg` + `commit-msg` hooks in the common git dir (or `core.hooksPath` if set); an existing hook is chained as `<hook>.whytrail-chained`, called first, its exit code kept; installing twice is a no-op; uninstall restores. (P2)
- Trailer stamping: `prepare-commit-msg` appends `Plan: <id>` from `WHYTRAIL_PLAN` or a unique `Branch:` line match, always inside the existing trailer paragraph and never duplicated. `commit-msg` refuses commits without `Plan: <id>` (merge/revert/`fixup!`/`squash!` exempt; `Plan: none - <reason>` accepted). (P2)
- `whytrail backfill [--dry-run] [--since <date>] [--repo <path>]` — idempotent backfill writing `.whytrail/links.jsonl` records `{commit, plan, source, confidence}`; sources trailer/co-commit/progress-sha/branch (high), memory-log (medium), date-files (low, commit-day match plus a code path cited in the plan); never overwrites a review decision. (P3)
- `whytrail review [--accept|--reject <sha> <plan-id>]` — records accept/reject decisions that backfill and the `why`/`code` output respect; bare `whytrail review` lists unsure links (low confidence, or a commit linked to more than one plan). (P3)
