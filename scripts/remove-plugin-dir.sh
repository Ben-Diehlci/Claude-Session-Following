#!/bin/zsh
# Stop loading session-following: removes this folder from CLAUDE_CODE_PLUGIN_DIRS in
# ~/.claude/settings.json (backup first). Deletes nothing else; restart the Claude app after.
set -euo pipefail
S="$HOME/.claude/settings.json"; R="${0:A:h:h}"
[[ -e "$S" ]] || { print "no settings.json, nothing to do"; exit 0; }
cp -p "$S" "$S.bak-$(date +%Y%m%d-%H%M%S)"; print "backup made"
python3 -I - "$S" "$R" <<'PY'
import json, os, sys
s, r = sys.argv[1], sys.argv[2]
real = os.path.realpath(s)
d = json.load(open(real))
env = d.get("env", {})
dirs = [x for x in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(":") if x and x != r]
if dirs: env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
else: env.pop("CLAUDE_CODE_PLUGIN_DIRS", None)
json.dump(d, open(real, "w"), indent=2); open(real, "a").write("\n")
print("CLAUDE_CODE_PLUGIN_DIRS =", env.get("CLAUDE_CODE_PLUGIN_DIRS", "(removed)"))
PY
print "Done. Restart the Claude app."
