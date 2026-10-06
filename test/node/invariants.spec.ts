import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

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
