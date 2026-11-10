# session-following

A Claude desktop app mod that adds a **Sessions** pane beside the chat. It lists your Claude Code sessions grouped by project folder, nests sub-sessions under the session that started them, marks which are working (green) or idle (grey), shows Remote Control (RC) and how long ago each was active, and opens a session when you click its title.

Open it with `/sessions`. It refreshes every 10 seconds and hides sessions idle for more than 3 days.

Private project. Notes: handoff.md, plan.md, todo.md.

## Install
Run `scripts/use-plugin-dir.sh` (adds this folder to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json), then restart the Claude app. The marketplace route (`scripts/install.sh`) installs a copy that cannot reach the app's session tools, so it is not used.
