#!/usr/bin/env bash
# plantrail-v1-scope.sh: phase-0 blocker for plan 20261025_1440_plantrail_v1.
# In /home/ukd/projects/plantrail-v1: the plan files stay Main's, source never rewrites git history or
# pushes, and tests never touch a real repo (only temp repos they create).
set -uo pipefail
# Called by plan-guard with one tool call on stdin: the tree scan only judges commits/pushes, so a red
# tree never refuses the reads and edits that clean it. Run with no stdin it scans unconditionally.
if [ ! -t 0 ]; then
  CALL=$(timeout 2 cat 2>/dev/null || true)
  if [ -n "$CALL" ] && ! printf '%s' "$CALL" | grep -qE 'git[^|;&]*\b(commit|push)\b'; then exit 0; fi
fi
WT=/home/ukd/projects/plantrail-v1
[ -d "$WT" ] || { echo "plantrail-v1-scope: no worktree"; exit 0; }
cd "$WT" || exit 1
BASE=$(git merge-base main HEAD 2>/dev/null || echo main)
FILES=$( { git diff --name-only "$BASE"; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
rc=0
for f in $FILES; do
  case "$f" in docs/plans/*) echo "OUT OF SCOPE (Main's plan files): $f"; rc=1 ;; esac
done
if [ -d src ]; then
  if grep -rnE "filter-branch|commit[\"', ]+--amend|\brebase\b|\bpush\b|notes[\"', ]+(add|append|edit|remove)|update-ref" src; then
    echo "FORBIDDEN in src: history rewrite, push or ref writes"; rc=1
  fi
fi
if [ -d tests ]; then
  if grep -rnE "/home/ukd/(Work|projects)/" tests; then echo "FORBIDDEN in tests: a real repo path (use temp repos)"; rc=1; fi
fi
[ $rc -eq 0 ] && echo "plantrail-v1-scope: clean"
exit $rc
