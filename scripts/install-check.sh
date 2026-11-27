#!/bin/sh
# Runs install.sh for real against a throwaway CLAUDE_CONFIG_DIR. Slow: it needs the network.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

case "$(cd "$WORK" && pwd -P)" in
  "$HOME"/.claude | "$HOME"/.claude/*)
    echo "install-check.sh: refusing to run under $HOME/.claude" >&2
    exit 2
    ;;
esac

MARKETPLACE="$ROOT"
export MARKETPLACE
SH="$(command -v sh)"
FAILED=0

report() {
  if [ "$2" = ok ]; then
    echo "PASS $1"
  else
    echo "FAIL $1"
    FAILED=1
  fi
}

fresh_config() {
  mkdir -p "$WORK/$1"
  CLAUDE_CONFIG_DIR="$WORK/$1"
  export CLAUDE_CONFIG_DIR
}

install_path() {
  claude plugin list --json | node -e '
const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
const hit = list.find((p) => p.id === "codemode@codemode");
if (hit) process.stdout.write(hit.installPath);
'
}

fresh_config a
if "$SH" "$ROOT/install.sh" >"$WORK/a.out" 2>&1 &&
  p="$(install_path)" && [ -n "$p" ] && [ -d "$p/node_modules/@earendil-works/pi-codemode" ]; then
  report "fresh install" ok
else
  cat "$WORK/a.out"
  report "fresh install" bad
fi

if "$SH" "$ROOT/install.sh" >"$WORK/b.out" 2>&1; then
  report "second run exits 0" ok
else
  cat "$WORK/b.out"
  report "second run exits 0" bad
fi

fresh_config c
if ! SCOPE=bogus "$SH" "$ROOT/install.sh" >"$WORK/c.out" 2>&1 && [ -z "$(install_path)" ]; then
  report "bogus SCOPE fails and installs nothing" ok
else
  report "bogus SCOPE fails and installs nothing" bad
fi

STUB="$WORK/stub"
mkdir -p "$STUB"
printf "#!/bin/sh\n[ \"\$2\" = list ] && echo 'not json'\nexit 0\n" >"$STUB/claude"
chmod +x "$STUB/claude"

if ! PATH="$STUB" "$SH" "$ROOT/install.sh" >"$WORK/d.out" 2>&1 && grep -q 'node not found' "$WORK/d.out"; then
  report "no node fails with a plain line" ok
else
  report "no node fails with a plain line" bad
fi

if ! PATH="$STUB:$PATH" "$SH" "$ROOT/install.sh" >"$WORK/e.out" 2>&1 &&
  grep -q "could not read 'claude plugin list --json' output" "$WORK/e.out" &&
  ! grep -q SyntaxError "$WORK/e.out"; then
  report "non-JSON plugin list fails with a plain line" ok
else
  cat "$WORK/e.out"
  report "non-JSON plugin list fails with a plain line" bad
fi

SRC="$WORK/other-source"
mkdir -p "$SRC"
(cd "$ROOT" && git archive HEAD) | tar -x -C "$SRC"
fresh_config f
claude plugin marketplace add "$SRC" >"$WORK/f-add.out" 2>&1
if "$SH" "$ROOT/install.sh" >"$WORK/f.out" 2>&1 &&
  grep -q 'reusing the registered codemode marketplace' "$WORK/f.out" &&
  p="$(install_path)" && [ -n "$p" ] && [ -d "$p/node_modules/@earendil-works/pi-codemode" ] &&
  "$SH" "$ROOT/install.sh" >"$WORK/f2.out" 2>&1; then
  report "reuses a codemode marketplace registered from another source" ok
else
  cat "$WORK/f.out"
  report "reuses a codemode marketplace registered from another source" bad
fi

# Prints the permissions.allow list of the throwaway config's settings.json, one rule per line.
allow_list() {
  node -e '
let settings = {};
try {
  settings = JSON.parse(require("fs").readFileSync(process.argv[1] + "/settings.json", "utf8"));
} catch {}
for (const rule of settings.permissions?.allow ?? []) console.log(rule);
' "$CLAUDE_CONFIG_DIR"
}

has_all_rules() {
  rules="$(allow_list)"
  for rule in Read Glob Grep ListMcpResourcesTool ReadMcpResourceTool ReadMcpResourceDirTool WebSearch 'mcp__codegraph__*' 'mcp__mail__get_*'; do
    printf '%s\n' "$rules" | grep -qxF "$rule" || return 1
  done
}

fresh_config h
printf '{"pluginConfigs":{"codemode":{"options":{"mcpCodemode":"codegraph, mail__get_*"}}}}\n' >"$CLAUDE_CONFIG_DIR/settings.json"
if ALLOW_RULES=print "$SH" "$ROOT/install.sh" >"$WORK/h.out" 2>&1 &&
  [ -z "$(allow_list)" ] && grep -q '^  Read$' "$WORK/h.out" && grep -q '^  mcp__codegraph__\*$' "$WORK/h.out"; then
  report "ALLOW_RULES=print lists the rules and writes nothing" ok
else
  cat "$WORK/h.out"
  report "ALLOW_RULES=print lists the rules and writes nothing" bad
fi

fresh_config i
printf '{"pluginConfigs":{"codemode":{"options":{"mcpCodemode":"codegraph, mail__get_*"}}}}\n' >"$CLAUDE_CONFIG_DIR/settings.json"
if ALLOW_RULES=yes "$SH" "$ROOT/install.sh" >"$WORK/i.out" 2>&1 && has_all_rules; then
  report "ALLOW_RULES=yes writes the rules" ok
else
  cat "$WORK/i.out"
  report "ALLOW_RULES=yes writes the rules" bad
fi

fresh_config j
if ALLOW_RULES=no "$SH" "$ROOT/install.sh" >"$WORK/j.out" 2>&1 && [ -z "$(allow_list)" ]; then
  report "ALLOW_RULES=no writes nothing" ok
else
  cat "$WORK/j.out"
  report "ALLOW_RULES=no writes nothing" bad
fi

fresh_config k
if "$SH" "$ROOT/install.sh" >"$WORK/k.out" 2>&1 </dev/null && [ -z "$(allow_list)" ] &&
  grep -q 'No terminal to ask on' "$WORK/k.out"; then
  report "ask without a terminal writes nothing" ok
else
  cat "$WORK/k.out"
  report "ask without a terminal writes nothing" bad
fi

STUB2="$WORK/stub2"
mkdir -p "$STUB2"
printf "#!/bin/sh\n[ \"\$3\" = list ] && echo 'not json'\nexit 0\n" >"$STUB2/claude"
chmod +x "$STUB2/claude"

if ! PATH="$STUB2:$PATH" "$SH" "$ROOT/install.sh" >"$WORK/g.out" 2>&1 &&
  grep -q "could not read 'claude plugin marketplace list --json' output" "$WORK/g.out" &&
  ! grep -q SyntaxError "$WORK/g.out" && ! grep -q '    at ' "$WORK/g.out"; then
  report "non-JSON marketplace list fails with a plain line" ok
else
  cat "$WORK/g.out"
  report "non-JSON marketplace list fails with a plain line" bad
fi

exit "$FAILED"
