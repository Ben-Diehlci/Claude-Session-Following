#!/bin/zsh
# Load session-following in every session as a plugin folder (CLAUDE_CODE_PLUGIN_DIRS in
# ~/.claude/settings.json env), and disable (not remove) the marketplace install, whose
# copy cannot reach the desktop app's session tools. Backs up settings.json first.
set -euo pipefail
S="$HOME/.claude/settings.json"
R="${0:A:h:h}"   # this repo folder, wherever it was cloned
print "mod folder: $R"
mkdir -p "$HOME/.claude"; [[ -e "$S" ]] || print "{}" > "$S"
cp -p "$S" "$S.bak-$(date +%Y%m%d-%H%M%S)"; print "backup made"
claude plugin disable session-following@claude-session-following 2>/dev/null || true
python3 -I - "$S" "$R" <<'PY'
import json, os, sys
s, r = sys.argv[1], sys.argv[2]
real = os.path.realpath(s)
d = json.load(open(real))
env = d.setdefault("env", {})
dirs = [x for x in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if x]
if r not in dirs: dirs.append(r)
env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
json.dump(d, open(real, "w"), indent=2); open(real, "a").write("\n")
print("CLAUDE_CODE_PLUGIN_DIRS =", env["CLAUDE_CODE_PLUGIN_DIRS"])
print("session-following@claude-session-following enabled:", d.get("enabledPlugins", {}).get("session-following@claude-session-following"))
PY
print "Done. Restart the Claude app so new sessions pick it up."
