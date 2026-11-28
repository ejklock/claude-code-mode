/**
 * Recognises a Bash command that runs a script written inline: `python -c`,
 * `python -` or a python heredoc, `node -e`/`-p`, `node -` or a node heredoc,
 * and three shell kinds: `bash`/`sh`/`zsh` with `-c` (`shell-c`), a heredoc or
 * a pipe into one of those shells (`shell-stdin`), and a `for`/`while` loop at
 * a command position (`shell-loop`). A Python or Node kind wins over any shell
 * kind; among shell kinds `shell-c` wins over `shell-stdin` over `shell-loop`.
 *
 * Known limits, not fixed: the match is textual. An interpreter or shell right
 * after a quote counts, so `bash -lc "python3 -c x"` is seen, and the price is
 * a false positive: `echo "python3 -c x"` and `echo "bash -c x"` count too. A
 * bare `cmd | python3` with no `-` is not seen, while a bare `cmd | bash` is
 * `shell-stdin`. A shell loop counts only at a command position (line start,
 * after `;`, `&`, `|`, `(`, `{`, a newline, or `do`/`then`/`else`) and with a
 * `do` after it, so `echo "for x in y"` is not a loop; but the position is
 * read textually too, so a loop shape inside a quoted string still counts:
 * `echo 'a; for x in y; z; do'` is `shell-loop`. A pipe into a shell with a
 * script file (`cmd | bash script.sh`) is not stdin. The body of a heredoc is
 * not read for shell kinds (the operator line still is), so a heredoc that
 * writes a script or a commit message is not a shell kind; a heredoc operator
 * inside a quoted string is taken for a real one and hides the lines after it.
 * Python and Node are still read in a heredoc body. Not recognised: backticks,
 * `time` and `!` prefixes, `until` and `select` loops, `--rcfile`, and
 * `bash < file`. A command longer than MAX_CLASSIFIED_LENGTH characters is
 * classified as nothing, which bounds the time the textual patterns take.
 */
export type InlineKind =
  | 'python-c'
  | 'python-stdin'
  | 'node-e'
  | 'node-stdin'
  | 'shell-c'
  | 'shell-stdin'
  | 'shell-loop'

const INTERPRETER = /(?:^|[\s;&|("']|\/)(python[\d.]*|node)(?=\s|$)([^;&|\n]*)/g
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

const SHELL = /(^|[\s;&|("']|\/)(?:bash|sh|zsh)(?=\s|$)([^;&|\n]*)/g
const SHELL_LOOP_HEAD = /(?:^|[;&|(){\n]|\b(?:do|then|else)\b)\s*(?:for\s+(?:\w+\s+in\s|\(\()|while\s)/
const SHELL_LOOP_DO = /[;\n]\s*do\b/
const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([\w.-]+)'|"([\w.-]+)"|\\?([\w.-]+))/g
const SHELL_COMBINED_C = /^-[a-zA-Z]*c[a-zA-Z]*$/
const SHELL_FLAG = /^[-+]/
const SHELL_FLAG_WITH_VALUE = /^[-+][oO]$/

/** The shell kind of one shell invocation: its flags, then what feeds it. */
function shellKindOf(args: string, piped: boolean): InlineKind | undefined {
  const tokens = args.split(/\s+/).filter(Boolean)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ''
    if (SHELL_COMBINED_C.test(token)) return 'shell-c'
    if (token.startsWith('<')) return 'shell-stdin'
    if (!SHELL_FLAG.test(token)) return undefined
    if (SHELL_FLAG_WITH_VALUE.test(token)) index++
  }
  return piped ? 'shell-stdin' : undefined
}

/** The command without the bodies of its heredocs: the operator line stays, the lines up to the delimiter go. */
function withoutHeredocBodies(command: string): string {
  const kept: string[] = []
  const pending: Array<{ word: string; indented: boolean }> = []
  for (const line of command.split('\n')) {
    const open = pending[0]
    if (open !== undefined) {
      if ((open.indented ? line.replace(/^\t+/, '') : line) === open.word) pending.shift()
      continue
    }
    kept.push(line)
    for (const match of line.matchAll(HEREDOC)) {
      pending.push({ word: match[2] ?? match[3] ?? match[4] ?? '', indented: match[1] === '-' })
    }
  }
  return kept.join('\n')
}

/** Whether a single pipe, then only whitespace, comes right before `position`. */
function pipedInto(text: string, position: number): boolean {
  let end = position
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) end--
  return text[end - 1] === '|' && text[end - 2] !== '|'
}

/** The kinds of the shell invocations in a text; a path prefix is walked once, so the scan stays linear. */
function invocationKinds(text: string): Set<InlineKind> {
  const found = new Set<InlineKind>()
  let scanned = 0
  let runStart = 0
  for (const match of text.matchAll(SHELL)) {
    const boundary = match[1] ?? ''
    const nameStart = match.index + boundary.length
    for (; boundary === '/' && scanned < nameStart; scanned++) if (/\s/.test(text[scanned] ?? '')) runStart = scanned + 1
    const kind = shellKindOf(match[2] ?? '', pipedInto(text, boundary === '/' ? runStart : nameStart))
    if (kind !== undefined) found.add(kind)
  }
  return found
}

function hasShellLoop(text: string): boolean {
  const head = SHELL_LOOP_HEAD.exec(text)
  return head !== null && SHELL_LOOP_DO.test(text.slice(head.index + head[0].length))
}

function shellKind(command: string): InlineKind | undefined {
  const text = withoutHeredocBodies(command)
  const found = invocationKinds(text)
  if (found.has('shell-c')) return 'shell-c'
  if (found.has('shell-stdin')) return 'shell-stdin'
  return hasShellLoop(text) ? 'shell-loop' : undefined
}

/** Longest command, in characters, that is classified; a longer one is classified as nothing. */
export const MAX_CLASSIFIED_LENGTH = 100_000

export function inlineScriptKind(command: string): InlineKind | undefined {
  if (command.length > MAX_CLASSIFIED_LENGTH) return undefined
  for (const match of command.matchAll(INTERPRETER)) {
    const kind = kindOf(match[1] ?? '', match[2] ?? '')
    if (kind !== undefined) return kind
  }
  return shellKind(command)
}
