#!/bin/zsh
# Install (or update) the session-following mod from this folder for every Claude session.
set -e
REPO="${0:A:h:h}"
claude plugin validate "$REPO" | grep -E "Validation"
claude plugin marketplace add "$REPO" 2>/dev/null || claude plugin marketplace update claude-session-following
claude plugin install session-following@claude-session-following || claude plugin update session-following@claude-session-following
claude plugin list 2>/dev/null | grep -A2 session-following || true
echo "Done. Restart the Claude app (or open a new session) to load it."
