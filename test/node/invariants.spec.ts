import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { toCodemodeIdentifier } from '@earendil-works/pi-codemode'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DESCRIPTION_CAP,
  codeDescription,
  describeCodemode,
  mcpSection,
  renderSections,
  selectSections,
  toIdentifier,
  toolDocs,
} from '../../hooks/describe.ts'
import type { Section } from '../../hooks/describe.ts'
import { classifyRun } from '../../scripts/adoption.ts'
import { EXPOSED_TOOLS, TOOL_SPECS, declarationOf, inputSchemaOf } from '../../shared/protocol.ts'
import type { ToolSpec } from '../../shared/protocol.ts'

const DESCRIPTION_SNAPSHOT = [
  'Runs JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a sandbox: top-level `await` works. No Node, file system, network, or timers.',
  '- `await tools.<name>({ ...args })` resolves to the tool\'s text and rejects with an Error when the call fails or a permission rule refuses it; catch it to continue.',
  '- Only what the script prints comes back, so filter and combine results in the script.',
  '',
  'Globals:',
  '- `text(value)` and `console.log(...)` add output; non-strings are JSON-stringified. A top-level `return` ends the script, and its value is not sent back.',
  '- `exit()` ends the script successfully, keeping its output.',
  '- `ALL_TOOLS` lists `{ name, description }` for each tool a script can call.',
  '- Connected MCP tools are callable too, as `tools.<name>(args)` by their full `mcp__server__tool` name, and listed in `ALL_TOOLS`.',
  '- Each nested tool has a section in the description of the `code` parameter; one with no section there is still callable, and `ALL_TOOLS` is how to find it.',
].join('\n')

const CODE_SNAPSHOT = [
  'The script to run.',
  '',
  'Nested tools:',
  '',
  '### `Read`',
  'Reads a file. `tools.Read(args)` takes `file_path` (absolute path), optional `offset` (first line, from 1) and `limit` (number of lines), and resolves to the file text.',
  '',
  '### `Bash`',
  'Runs a shell command. `tools.Bash(args)` takes `command`, optional `timeout` (milliseconds), and resolves to the command output.',
  '',
  '### `Write`',
  'Writes a file. `tools.Write(args)` takes `file_path` (absolute path), `content`, and resolves to a confirmation.',
  '',
  '### `Edit`',
  'Replaces text in a file. `tools.Edit(args)` takes `file_path` (absolute path), `old_string`, `new_string`, optional `replace_all` (every match), and resolves to a confirmation.',
].join('\n')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE_DIRECTORIES = ['hooks', 'child', 'shared']
const PINNED_PACKAGE = '@earendil-works/pi-codemode'
const MCP_CALL = /\bmcp\s*(\.\s*call\b|\[\s*['"`]call['"`]\s*\])/
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function sourceFiles(root: string): string[] {
  return SOURCE_DIRECTORIES.flatMap(directory => {
    const entries = readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    return entries
      .filter(entry => entry.isFile() && /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(entry.name))
      .map(entry => join(entry.parentPath, entry.name))
  })
}

function filesCallingMcp(root: string): string[] {
  return sourceFiles(root).filter(file => MCP_CALL.test(readFileSync(file, 'utf8')))
}

function pinProblem(manifestText: string): string | undefined {
  const manifest = JSON.parse(manifestText) as Record<string, Record<string, string> | undefined>
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
  const versions = sections.flatMap(section => {
    const version = manifest[section]?.[PINNED_PACKAGE]
    return version === undefined ? [] : [version]
  })
  if (versions.length === 0) return `${PINNED_PACKAGE} is not declared`
  const loose = versions.find(version => !EXACT_VERSION.test(version))
  return loose === undefined ? undefined : `${PINNED_PACKAGE} is "${loose}", not an exact version`
}

const scratch = mkdtempSync(join(tmpdir(), 'codemode-invariants-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

function treeWith(file: string, content: string): string {
  const root = mkdtempSync(join(scratch, 'tree-'))
  for (const directory of SOURCE_DIRECTORIES) mkdirSync(join(root, directory))
  writeFileSync(join(root, file), content)
  return root
}

describe('the mod never calls the MCP path', () => {
  it('Proves C5: the real tree is clean', () => {
    assert.deepEqual(filesCallingMcp(ROOT), [])
  })

  it('Proves C5: a hooks file that calls the MCP path is found', () => {
    const root = treeWith('hooks/bad.ts', 'await $.mcp.call("server", "tool", {})\n')
    assert.deepEqual(filesCallingMcp(root), [join(root, 'hooks/bad.ts')])
  })

  it('Proves C5: a child file that calls it is found', () => {
    const root = treeWith('child/bad.ts', 'await $.mcp . call("server", "tool", {})\n')
    assert.deepEqual(filesCallingMcp(root), [join(root, 'child/bad.ts')])
  })

  it('Proves C5: a file that only mentions other mcp members is not found', () => {
    const root = treeWith('shared/ok.ts', 'const names = await $.mcp.list()\n')
    assert.deepEqual(filesCallingMcp(root), [])
  })
})

const RUNS_REFERENCE = /RUNS\s*=\s*atom\(\s*\{\s*plugin:\s*'([^']+)'\s*,\s*key:\s*'([^']+)'/

function runsReference(source: string): string | undefined {
  const match = RUNS_REFERENCE.exec(source)
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

function driftProblem(registerSource: string, renderSource: string): string | undefined {
  const written = runsReference(registerSource)
  const drawn = runsReference(renderSource)
  if (written === undefined || drawn === undefined) return 'a module does not declare the RUNS atom'
  return written === drawn ? undefined : `register.ts writes ${written} but render.tsx reads ${drawn}`
}

describe('the two RUNS atoms name one state value', () => {
  const module = (plugin: string, key: string): string =>
    `const RUNS = atom({ plugin: '${plugin}', key: '${key}' } as const, [])\n`

  it('Proves N2: the real tree passes', () => {
    const register = readFileSync(join(ROOT, 'hooks/register.ts'), 'utf8')
    const render = readFileSync(join(ROOT, 'hooks/render.tsx'), 'utf8')
    assert.notEqual(runsReference(register), undefined)
    assert.equal(driftProblem(register, render), undefined)
  })

  it('Proves N2: a different key fails', () => {
    assert.match(driftProblem(module('codemode', 'runs'), module('codemode', 'other')) ?? '', /writes codemode\/runs but .* codemode\/other/)
  })

  it('Proves N2: a different plugin fails', () => {
    assert.match(driftProblem(module('codemode', 'runs'), module('another', 'runs')) ?? '', /another\/runs/)
  })

  it('Proves N2: a module with no declaration fails', () => {
    assert.match(driftProblem('', module('codemode', 'runs')) ?? '', /does not declare/)
  })
})

describe('the pi-codemode pin is exact', () => {
  const manifest = (version: string): string =>
    JSON.stringify({ dependencies: { [PINNED_PACKAGE]: version } })

  it('Proves C5: the real package.json passes', () => {
    assert.equal(pinProblem(readFileSync(join(ROOT, 'package.json'), 'utf8')), undefined)
  })

  it('Proves C5: an exact version passes', () => {
    assert.equal(pinProblem(manifest('1.0.4')), undefined)
  })

  for (const range of ['^1.0.4', '~1.0.4', '>=1.0.4', '1.x', '*']) {
    it(`Proves C5: "${range}" fails`, () => {
      assert.match(pinProblem(manifest(range)) ?? '', /not an exact version/)
    })
  }

  it('Proves C5: a missing dependency fails', () => {
    assert.match(pinProblem('{}') ?? '', /not declared/)
  })
})

describe('an adoption run is valid only when claude finished', () => {
  const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`
  const calling = (...names: string[]): string =>
    line({ type: 'assistant', message: { content: names.map(name => ({ type: 'tool_use', name })) } })
  const finished = line({ type: 'result' })

  it('Proves C1: a run that used codemode is valid and counts', () => {
    const outcome = classifyRun({ status: 0, stdout: calling('mcp__codemode__codemode') + finished })
    assert.deepEqual(outcome, { ok: true, tools: ['mcp__codemode__codemode'], usedCodemode: true })
  })

  it('Proves C1: a run that used Bash only is valid and does not count', () => {
    const outcome = classifyRun({ status: 0, stdout: calling('Bash', 'Bash') + finished })
    assert.deepEqual(outcome, { ok: true, tools: ['Bash', 'Bash'], usedCodemode: false })
  })

  it('Proves C1: a spawn error fails the run', () => {
    const outcome = classifyRun({ error: new Error('spawnSync claude ENOENT'), status: null, stdout: '' })
    assert.deepEqual(outcome, { ok: false, reason: 'spawn failed: spawnSync claude ENOENT' })
  })

  it('Proves C1: a non-zero status fails the run', () => {
    const outcome = classifyRun({ status: 1, stdout: calling('Bash') + finished })
    assert.deepEqual(outcome, { ok: false, reason: 'exit status 1' })
  })

  it('Proves C1: a zero status with no result event fails the run', () => {
    const outcome = classifyRun({ status: 0, stdout: calling('Bash') })
    assert.deepEqual(outcome, { ok: false, reason: 'the stream has no result event' })
  })
})

describe('the sandbox declarations read as they always did', () => {
  it('Proves C1: Read is declared with its original text', () => {
    assert.deepEqual(declarationOf('Read'), {
      description: 'Reads a file; resolves to its text.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path of the file.' },
          offset: { type: 'number', description: 'First line to read, from 1.' },
          limit: { type: 'number', description: 'Number of lines to read.' },
        },
        required: ['file_path'],
      },
      outputSchema: { type: 'string' },
    })
  })

  it('Proves C1: Bash is declared with its original text', () => {
    assert.deepEqual(declarationOf('Bash'), {
      description: 'Runs a shell command; resolves to its output.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout: { type: 'number', description: 'Milliseconds.' },
        },
        required: ['command'],
      },
      outputSchema: { type: 'string' },
    })
  })
})

describe('the sandbox declares Write and Edit as the build types them', () => {
  it('Proves C1: Write is declared with its two required strings', () => {
    const { inputSchema, outputSchema } = declarationOf('Write')
    const properties = inputSchema.properties as Record<string, { type: string }>
    assert.deepEqual(Object.keys(properties), ['file_path', 'content'])
    assert.deepEqual(Object.values(properties).map(property => property.type), ['string', 'string'])
    assert.deepEqual(inputSchema.required, ['file_path', 'content'])
    assert.deepEqual(outputSchema, { type: 'string' })
  })

  it('Proves C1: Edit is declared with replace_all as an optional boolean', () => {
    const { inputSchema } = declarationOf('Edit')
    const properties = inputSchema.properties as Record<string, { type: string }>
    assert.deepEqual(Object.keys(properties), ['file_path', 'old_string', 'new_string', 'replace_all'])
    assert.deepEqual(Object.values(properties).map(property => property.type), ['string', 'string', 'string', 'boolean'])
    assert.deepEqual(inputSchema.required, ['file_path', 'old_string', 'new_string'])
  })
})

describe('the description holds to the cap', () => {
  const sectionNames = (text: string): string[] => [...text.matchAll(/^### `(\w+)`$/gm)].map(match => match[1] ?? '')
  const manyTools = Array.from({ length: 200 }, (_, index) => ({ name: `mcp__s__t${index}`, description: 'd'.repeat(400) }))

  it('Proves C2: the description holds the intro and the globals, under the cap, with no tool section', () => {
    const text = describeCodemode()
    assert.ok(text.length <= DESCRIPTION_CAP, `description is ${text.length} characters`)
    assert.deepEqual(sectionNames(text), [])
    assert.doesNotMatch(text, /Nested tools:/)
    assert.match(text, /no section there is still callable, and `ALL_TOOLS` is how to find it/)
    assert.match(text, /Connected MCP tools are callable too, as `tools\.<name>\(args\)`.*listed in `ALL_TOOLS`/)
  })

  it('Proves C2: the sections, however many, never reach the description', () => {
    const text = codeDescription(manyTools)
    assert.ok(!text.includes(describeCodemode()))
    assert.equal(describeCodemode().length <= DESCRIPTION_CAP, true)
  })

  it('Proves C1: the sections of 200 large tools stay within the budget', () => {
    const text = codeDescription(manyTools)
    assert.ok(text.length <= 3000 * 4 + 200, `sections are ${text.length} characters`)
    assert.match(text, /## s \(some tools not listed\)/)
  })
})

describe('the sections fit a budget in estimated tokens', () => {
  const sec = (name: string, server: string | undefined, tokens: number): Section => ({
    name,
    server,
    text: 'x'.repeat(tokens * 4 - 3),
  })
  const shownNames = (sections: Section[], budget: number): string[] =>
    selectSections(sections, budget).flatMap(group => group.shown.map(section => section.name))

  const tight = [sec('B1', undefined, 2), sec('B2', undefined, 6), sec('S1', 's', 2), sec('S2', 's', 4)]

  it('Proves C1: everything fits, so all are shown in group order, built-ins first and servers by name', () => {
    const sections = [sec('z1', 'zeta', 1), sec('b1', undefined, 1), sec('a1', 'alpha', 1)]
    assert.deepEqual(shownNames(sections, 100), ['b1', 'a1', 'z1'])
  })

  it('Proves C1: a budget exactly equal to the total cost shows all', () => {
    assert.deepEqual(shownNames(tight, 14).sort(), ['B1', 'B2', 'S1', 'S2'])
  })

  it('Proves C1: a budget one token short drops the most expensive tool of the group that placed last', () => {
    assert.deepEqual(shownNames(tight, 13), ['B1', 'B2', 'S1'])
  })

  it('Proves C1: a tight budget represents every server before any is complete', () => {
    const sections = [
      sec('b1', undefined, 1), sec('b2', undefined, 10),
      sec('a1', 'a', 1), sec('a2', 'a', 10),
      sec('c1', 'c', 1), sec('c2', 'c', 10),
    ]
    assert.deepEqual(shownNames(sections, 3), ['b1', 'a1', 'c1'])
  })

  it('Proves C1: a group whose next tool does not fit drops out while the others go on', () => {
    const sections = [sec('b1', undefined, 1), sec('b2', undefined, 50), sec('s1', 's', 2), sec('s2', 's', 2), sec('s3', 's', 2)]
    assert.deepEqual(shownNames(sections, 8), ['b1', 's1', 's2', 's3'])
  })

  it('Proves C1: the cheapest of a group is placed first and rendered in the group order', () => {
    const sections = [sec('big', 's', 5), sec('small', 's', 1)]
    assert.deepEqual(shownNames(sections, 1), ['small'])
    assert.deepEqual(shownNames(sections, 6), ['big', 'small'])
  })

  it('Proves C1: an empty list renders no Nested tools heading', () => {
    assert.equal(renderSections([]), '')
    assert.doesNotMatch(codeDescription([], []), /Nested tools:/)
  })

  it('Proves C1: the real four built-ins are all shown and none is marked unlisted', () => {
    const text = codeDescription()
    assert.deepEqual([...text.matchAll(/^### `(\w+)`$/gm)].map(match => match[1]), ['Read', 'Bash', 'Write', 'Edit'])
    assert.doesNotMatch(text, /not listed/)
  })
})

describe('the sections render', () => {
  const headings = (text: string): string[] => text.split('\n').filter(line => line.startsWith('## '))

  it('Proves C2: a server heading says whether all, some or none of its tools are shown', () => {
    const all = renderSections([mcpSection({ name: 'mcp__a__one', description: 'One.' })], 1000)
    assert.deepEqual(headings(all), ['## a'])
    const two = [
      mcpSection({ name: 'mcp__a__one', description: 'One.' }),
      mcpSection({ name: 'mcp__a__two', description: 't'.repeat(400) }),
    ]
    const first = Math.ceil((two[0]?.text.length ?? 0) / 4)
    assert.deepEqual(headings(renderSections(two, first)), ['## a (some tools not listed)'])
    assert.deepEqual(headings(renderSections(two, first - 1)), ['## a (tools not listed)'])
  })

  it('Proves C2: an identifier that differs from the raw name is shown with both', () => {
    const { text } = mcpSection({ name: 'mcp__my-server__run', description: 'Runs.' })
    assert.equal(text.split('\n')[0], '### `mcp__my_server__run` (`mcp__my-server__run`)')
    assert.match(text, /`tools\.mcp__my_server__run\(args\)`/)
    assert.equal(mcpSection({ name: 'mcp__plain__run', description: 'Runs.' }).text.split('\n')[0], '### `mcp__plain__run`')
  })

  const hostile = [
    '',
    'first line\nsecond line\n\n### Fake heading\n```js\ncode\n```\ntail',
    'y'.repeat(5000),
    '### starts with a heading',
    '```starts with a fence',
  ]
  for (const [index, description] of hostile.entries()) {
    it(`Proves C2: a hostile description (case ${index}) stays one block and counts its true cost`, () => {
      const { text } = mcpSection({ name: 'mcp__h__run', description })
      const lines = text.split('\n')
      assert.ok(lines[0]?.startsWith('### `'))
      assert.ok(lines.length <= 3, `${lines.length} lines`)
      assert.ok(lines.slice(1).every(line => !line.startsWith('#') && !line.startsWith('```')))
      const cost = Math.ceil(text.length / 4)
      assert.ok(renderSections([mcpSection({ name: 'mcp__h__run', description })], cost).includes(text))
      assert.ok(!renderSections([mcpSection({ name: 'mcp__h__run', description })], cost - 1).includes(text))
    })
  }
})

describe('the model-facing description keeps its text', () => {
  it('Proves C2: it is byte-identical to the snapshot', () => {
    assert.equal(describeCodemode(), DESCRIPTION_SNAPSHOT)
  })

  it('Proves C2: the code parameter description with the four built-ins is byte-identical to the snapshot', () => {
    assert.equal(codeDescription(), CODE_SNAPSHOT)
  })
})

describe('the described tool arguments come from the declared ones', () => {
  const described = (args: string): string[] => [...args.matchAll(/`(\w+)`/g)].map(match => match[1] ?? '')

  for (const name of EXPOSED_TOOLS) {
    it(`Proves C2: ${name} is described with exactly the properties it declares`, () => {
      const spec = TOOL_SPECS[name]
      const declared = Object.keys((inputSchemaOf(spec).properties ?? {}) as Record<string, unknown>)
      const doc = toolDocs().find(candidate => candidate.name === name)
      assert.deepEqual(described(doc?.args ?? ''), declared)
    })
  }

  it('Proves C2: an argument added to a source shows up in the description and the schema', () => {
    const specs = {
      Read: { ...TOOL_SPECS.Read, args: { ...TOOL_SPECS.Read.args, encoding: { type: 'string', isRequired: false } } },
    } satisfies Record<string, ToolSpec>
    const [doc] = toolDocs(specs, ['Read'])
    assert.match(doc?.args ?? '', /`encoding`/)
    assert.ok('encoding' in ((inputSchemaOf(specs.Read).properties ?? {}) as object))
  })
})

describe('the sections are a function of the set of tools', () => {
  const sec = (name: string, server: string | undefined, tokens: number): Section => ({
    name,
    server,
    text: 'x'.repeat(tokens * 4 - 3),
  })
  const shownNames = (sections: Section[], budget: number): string[] =>
    selectSections(sections, budget).flatMap(group => group.shown.map(section => section.name))

  it('Proves C1: toIdentifier equals the identifier function of pi-codemode', () => {
    const names = ['', '1abc', 'my-tool', 'a.b', 'a b', 'café', '$_x$', 'mcp__fake-srv__ping']
    for (const name of names) assert.equal(toIdentifier(name), toCodemodeIdentifier(name), JSON.stringify(name))
  })

  it('Proves C2: two groups compete for a budget, one section each before a second of either', () => {
    const sections = [sec('b1', undefined, 2), sec('b2', undefined, 2), sec('s1', 's', 2)]
    assert.deepEqual(shownNames(sections, 4), ['b1', 's1'])
  })

  it('Proves C3: equal costs in two input orders show the same section, the name deciding', () => {
    const one = [sec('b', 's', 2), sec('a', 's', 2)]
    assert.deepEqual(shownNames(one, 2), ['a'])
    assert.deepEqual(shownNames([...one].reverse(), 2), ['a'])
  })

  it('Proves C3: different costs in two input orders, the cost still decides what is shown', () => {
    const one = [sec('a', 's', 3), sec('b', 's', 1), sec('c', 's', 2)]
    assert.deepEqual(shownNames(one, 3), ['b', 'c'])
    assert.deepEqual(shownNames([...one].reverse(), 3), ['b', 'c'])
  })

  it('Proves C3: two servers in swapped input order render the same code text', () => {
    const tools = [
      { name: 'mcp__b__two', description: 'Two.' },
      { name: 'mcp__a__one', description: 'One.' },
      { name: 'mcp__b__one', description: 'One.' },
      { name: 'mcp__a__two', description: 'Two.' },
    ]
    const text = codeDescription(tools)
    assert.equal(codeDescription([...tools].reverse()), text)
    assert.equal(codeDescription([...tools.slice(2), ...tools.slice(0, 2)]), text)
  })
})
