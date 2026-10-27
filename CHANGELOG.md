# Changelog

## Unreleased

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
