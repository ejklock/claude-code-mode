/**
 * Recognises a Bash command that runs a script written inline: `python -c`,
 * `python -` or a python heredoc, `node -e`/`-p`, `node -` or a node heredoc.
 *
 * Known limits, not fixed: the match is textual. An interpreter right after a
 * quote counts, so `bash -lc "python3 -c x"` is seen, and the price is a false
 * positive: `echo "python3 -c x"` counts too. A bare `cmd | python3` with no
 * `-` is not seen.
 */
export type InlineKind = 'python-c' | 'python-stdin' | 'node-e' | 'node-stdin'

const INTERPRETER = /(?:^|[\s;&|("'])(?:\S*\/)?(python[\d.]*|node)(?=\s|$)([^;&|\n]*)/g
const PYTHON_EVAL = new Set(['-c'])
const NODE_EVAL = new Set(['-e', '-p', '--eval', '--print', '-pe'])

function kindOf(interpreter: string, args: string): InlineKind | undefined {
  const python = interpreter !== 'node'
  const evalFlags = python ? PYTHON_EVAL : NODE_EVAL
  for (const token of args.split(/\s+/).filter(Boolean)) {
    if (evalFlags.has(token)) return python ? 'python-c' : 'node-e'
    if (token === '-' || token.startsWith('<')) return python ? 'python-stdin' : 'node-stdin'
    if (!token.startsWith('-')) return undefined
    if (python && token === '-m') return undefined
  }
  return undefined
}

export function inlineScriptKind(command: string): InlineKind | undefined {
  for (const match of command.matchAll(INTERPRETER)) {
    const kind = kindOf(match[1] ?? '', match[2] ?? '')
    if (kind !== undefined) return kind
  }
  return undefined
}
