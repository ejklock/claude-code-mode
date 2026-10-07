#!/bin/sh
# Installs the codemode plugin and its runtime dependency.
# Environment: SCOPE (user, project or local; default user),
# MARKETPLACE (default ejklock/claude-code-mode; a local clone path also works).
set -eu

SCOPE="${SCOPE:-user}"
MARKETPLACE="${MARKETPLACE:-ejklock/claude-code-mode}"
PLUGIN_ID="codemode@codemode"

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

case "$SCOPE" in
  user | project | local) ;;
  *) fail "SCOPE must be user, project or local (got '$SCOPE')." ;;
esac

command -v claude >/dev/null 2>&1 || fail "claude not found. Install Claude Code first: https://claude.com/claude-code"
command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js 22.19 or newer."
command -v npm >/dev/null 2>&1 || fail "npm not found. Install Node.js 22.19 or newer, which includes npm."

node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
' || fail "Node.js $(node -v) is too old. Install Node.js 22.19 or newer."

claude plugin install codemode --marketplace "$MARKETPLACE" --scope "$SCOPE"

INSTALL_PATH="$(claude plugin list --json | node -e '
const fs = require("fs");
let list;
try {
  list = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(3);
}
const matches = list.filter((p) => p.id === process.argv[1]);
const hit = matches.find((p) => p.scope === process.argv[2]) || matches[0];
if (hit && hit.installPath) process.stdout.write(hit.installPath);
' "$PLUGIN_ID" "$SCOPE")" || fail "could not read 'claude plugin list --json' output; cannot locate the install folder."

[ -n "$INSTALL_PATH" ] || fail "$PLUGIN_ID not found in 'claude plugin list --json'; cannot locate the install folder."
[ -d "$INSTALL_PATH" ] || fail "install folder '$INSTALL_PATH' does not exist."

(cd "$INSTALL_PATH" && npm ci --omit=dev) ||
  fail "npm ci failed in '$INSTALL_PATH'. Run 'npm ci --omit=dev' there by hand."

printf '\ncodemode is installed in %s\n' "$INSTALL_PATH"
printf 'To start: run "claude", then ask it to use codemode.\n'
