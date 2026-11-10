#!/bin/zsh
# Publish a new version of session-following so installed copies are offered the update.
#   ./scripts/release.sh 0.4.1 "What changed, in a sentence or two"
# Steps: checks (on main, nothing uncommitted, plugin validates, tag is new), sets the version
# in .claude-plugin/plugin.json, commits "Release vX", tags vX, pushes both, then creates the
# GitHub release with your notes. Ordinary pushes between releases reach nobody.
set -euo pipefail
R="${0:A:h:h}"; cd "$R"
V="${1:-}"; NOTES="${2:-}"
[[ -n "$V" && -n "$NOTES" ]] || { print 'usage: ./scripts/release.sh <version> "notes"'; exit 1 }
[[ "$V" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || { print "version must look like 1.2.3"; exit 1 }
[[ "$(git branch --show-current)" == main ]] || { print "switch to main first"; exit 1 }
[[ -z "$(git status --porcelain)" ]] || { print "commit or stash your changes first"; exit 1 }
if git rev-parse -q --verify "refs/tags/v$V" >/dev/null; then print "v$V already exists"; exit 1; fi

python3 -I - "$V" <<'PY'
import json, sys
p = ".claude-plugin/plugin.json"
d = json.load(open(p)); old = d.get("version"); d["version"] = sys.argv[1]
open(p, "w").write(json.dumps(d, indent=2) + "\n")
print(f"version {old} -> {sys.argv[1]}")
PY

if ! claude plugin validate . >/dev/null 2>&1; then
  git checkout -- .claude-plugin/plugin.json
  print "plugin validate failed; version change undone. Run: claude plugin validate ."; exit 1
fi

MSG=("-m" "Release v$V" "-m" "$NOTES")
[[ -n "${RELEASE_TRAILER:-}" ]] && MSG+=("-m" "$RELEASE_TRAILER")
git add .claude-plugin/plugin.json
git commit -q "${MSG[@]}"
git tag -a "v$V" -m "v$V"
git push -q origin main "v$V"
GH_TOKEN=$(gh auth token --user Ben-Diehlci) gh release create "v$V" --verify-tag --title "v$V" --notes "$NOTES"
print "Released v$V. People with auto-update get it on their next start; others run: claude plugin update session-following@claude-session-following"
