import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as allowRules from '../../scripts/allow-rules.ts'

const { answerOrNo, FIXED_RULES, globbedServers, mergeAllow, serverRules, writeAllow } = allowRules

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'allow-rules.ts')

const NOW = new Date('2026-11-27T21:10:19Z')

const merged = (text: string | undefined, rules: readonly string[]) => {
  const result = mergeAllow(text, rules)
  if (!result.ok) assert.fail(result.reason)
  return { added: result.added, settings: JSON.parse(result.text) as Record<string, unknown> }
}

describe('FIXED_RULES', () => {
  it('Proves the fixed rules: the read-only built-ins and the resource tools', () => {
    assert.deepEqual(
      [...FIXED_RULES],
      ['Read', 'Glob', 'Grep', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'WebSearch'],
    )
  })
})

describe('serverRules', () => {
  it('Proves a list of servers becomes one wildcard rule per server', () => {
    assert.deepEqual(serverRules(['codegraph', 'claude_ai_Gmail']), ['mcp__codegraph__*', 'mcp__claude_ai_Gmail__*'])
  })

  it('Proves a comma string with spaces reads like a list', () => {
    assert.deepEqual(serverRules('codegraph,  claude_ai_Gmail , '), ['mcp__codegraph__*', 'mcp__claude_ai_Gmail__*'])
  })

  it('Proves an absent or empty setting gives no rule', () => {
    assert.deepEqual(serverRules(undefined), [])
    assert.deepEqual(serverRules(''), [])
    assert.deepEqual(serverRules([]), [])
  })

  it('Proves a server and tool entry becomes that one tool', () => {
    assert.deepEqual(serverRules(['claude_ai_Gmail__trash_message']), ['mcp__claude_ai_Gmail__trash_message'])
  })

  it('Proves a server and prefix entry keeps its prefix wildcard', () => {
    assert.deepEqual(serverRules(['claude_ai_Gmail__get_*']), ['mcp__claude_ai_Gmail__get_*'])
  })

  it('Proves the three entry shapes mix and a leading mcp__ is accepted', () => {
    assert.deepEqual(serverRules('mcp__a, b__t, c__p*'), ['mcp__a__*', 'mcp__b__t', 'mcp__c__p*'])
  })

  it('Proves characters Claude Code turns into underscores are written that way', () => {
    assert.deepEqual(serverRules(['my.server', 'my server__x']), ['mcp__my_server__*', 'mcp__my_server__x'])
  })

  it('Proves a duplicate entry gives one rule', () => {
    assert.deepEqual(serverRules(['a', 'a']), ['mcp__a__*'])
  })

  it('Proves a value that is neither a list nor a string gives no rule', () => {
    assert.deepEqual(serverRules(42), [])
    assert.deepEqual(serverRules([1, 'a']), [])
  })
})

describe('globbed servers', () => {
  it('Proves a glob in the server segment gives no rule and is named', () => {
    const value = ['*', 'claude_ai_*', '__x', 'mcp__', '']
    assert.deepEqual(serverRules(value), [])
    assert.deepEqual(globbedServers(value), ['*', 'claude_ai_*'])
  })

  it('Proves a mix of a plain and a globbed server keeps the rule and names the glob', () => {
    const value = 'codegraph, claude_ai_*'
    assert.deepEqual(serverRules(value), ['mcp__codegraph__*'])
    assert.deepEqual(globbedServers(value), ['claude_ai_*'])
  })

  it('Proves a glob after the server name is not a globbed server', () => {
    assert.deepEqual(globbedServers(['mail__get_*', 'mcp__a__b*']), [])
  })
})

describe('answerOrNo', () => {
  it('Proves an aborted question counts as an empty answer', async () => {
    const abort = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })
    assert.equal(await answerOrNo(() => Promise.reject(abort)), '')
  })

  it('Proves the answer is passed through', async () => {
    assert.equal(await answerOrNo(() => Promise.resolve('y')), 'y')
  })

  it('Proves any other error is raised', async () => {
    await assert.rejects(answerOrNo(() => Promise.reject(new Error('boom'))), /boom/)
  })
})

describe('mergeAllow', () => {
  it('Proves no settings file gives only permissions.allow', () => {
    const { added, settings } = merged(undefined, ['Read', 'Glob'])
    assert.deepEqual(settings, { permissions: { allow: ['Read', 'Glob'] } })
    assert.deepEqual(added, ['Read', 'Glob'])
  })

  it('Proves an existing allow list keeps its order and gets the new rules after it', () => {
    const { added, settings } = merged('{"permissions":{"allow":["Bash(ls)","Read"]}}', ['Read', 'Glob', 'Grep'])
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)', 'Read', 'Glob', 'Grep'] })
    assert.deepEqual(added, ['Glob', 'Grep'])
  })

  it('Proves a rule given twice is added once', () => {
    const { settings } = merged('{}', ['Read', 'Read'])
    assert.deepEqual(settings.permissions, { allow: ['Read'] })
  })

  it('Proves every rule already present adds nothing', () => {
    const { added } = merged('{"permissions":{"allow":["Read"]}}', ['Read'])
    assert.deepEqual(added, [])
  })

  it('Proves the other keys are left as they were', () => {
    const rest = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "é"' }] }] },
      pluginConfigs: { codemode: { options: { mcpCodemode: ['a', 'b'] } } },
      model: 'opus',
    }
    const before = { ...rest, permissions: { deny: ['Bash(rm *)'], ask: ['Edit'], allow: ['Read'] } }
    const { settings } = merged(JSON.stringify(before, null, 4), ['Glob'])
    const { permissions, ...others } = settings
    assert.equal(JSON.stringify(others), JSON.stringify(rest))
    assert.deepEqual(permissions, { deny: ['Bash(rm *)'], ask: ['Edit'], allow: ['Read', 'Glob'] })
  })

  it('Proves a malformed file is refused with a reason', () => {
    const result = mergeAllow('{"permissions": ', ['Read'])
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /not valid JSON/)
  })

  it('Proves a file whose allow is not a list is refused', () => {
    const result = mergeAllow('{"permissions":{"allow":"Read"}}', ['Glob'])
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /permissions\.allow/)
  })

  it('Proves a file whose top level is not an object is refused', () => {
    assert.equal(mergeAllow('[]', ['Read']).ok, false)
    assert.equal(mergeAllow('null', ['Read']).ok, false)
  })
})

describe('writeAllow', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'allow-rules-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('Proves a missing file is created with only permissions.allow and no backup', () => {
    const path = join(dir, 'sub', 'settings.json')
    const result = writeAllow(path, ['Read'], NOW)
    assert.deepEqual(result, { ok: true, added: ['Read'], backup: undefined })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { permissions: { allow: ['Read'] } })
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['settings.json'])
  })

  it('Proves a backup with a timestamp is written before the change', () => {
    const path = join(dir, 'settings.json')
    const original = '{\n  "model": "opus"\n}\n'
    writeFileSync(path, original)
    const result = writeAllow(path, ['Read'], NOW)
    assert.equal(result.ok, true)
    const backup = result.ok ? result.backup : undefined
    assert.equal(backup, `${path}.bak-20261127T211019Z`)
    assert.equal(readFileSync(backup ?? '', 'utf8'), original)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'opus', permissions: { allow: ['Read'] } })
  })

  it('Proves nothing is written and no backup made when every rule is present', () => {
    const path = join(dir, 'settings.json')
    const original = '{"permissions":{"allow":["Read"]}}'
    writeFileSync(path, original)
    const result = writeAllow(path, ['Read'], NOW)
    assert.deepEqual(result, { ok: true, added: [], backup: undefined })
    assert.equal(readFileSync(path, 'utf8'), original)
    assert.deepEqual(readdirSync(dir), ['settings.json'])
  })

  it('Proves a malformed file is refused, untouched, with no backup', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{ nope')
    const result = writeAllow(path, ['Read'], NOW)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /not valid JSON/)
    assert.equal(readFileSync(path, 'utf8'), '{ nope')
    assert.deepEqual(readdirSync(dir), ['settings.json'])
  })

  it('Proves a symlinked settings file is refused and nothing it points to changes', () => {
    const target = join(dir, 'real.json')
    writeFileSync(target, '{}')
    const path = join(dir, 'settings.json')
    symlinkSync(target, path)
    const result = writeAllow(path, ['Read'], NOW)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /symlink/)
    assert.equal(readFileSync(target, 'utf8'), '{}')
    assert.deepEqual(readdirSync(dir).sort(), ['real.json', 'settings.json'])
  })

  it('Proves a symlink planted at the temporary name is refused and its target left alone', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    const target = join(dir, 'victim.txt')
    writeFileSync(target, 'keep')
    symlinkSync(target, `${path}.tmp-${process.pid}`)
    const result = writeAllow(path, ['Read'], NOW)
    assert.equal(result.ok, false)
    assert.equal(readFileSync(target, 'utf8'), 'keep')
    assert.equal(readFileSync(path, 'utf8'), '{}')
    assert.equal(lstatSync(path).isFile(), true)
    assert.equal(lstatSync(`${path}.tmp-${process.pid}`).isSymbolicLink(), true)
    assert.deepEqual(readdirSync(dir).filter(name => name.includes('.bak-')), [])
  })

  it('Proves a regular file planted at the temporary name is refused and kept', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    writeFileSync(`${path}.tmp-${process.pid}`, 'planted')
    const result = writeAllow(path, ['Read'], NOW)
    assert.equal(result.ok, false)
    assert.equal(readFileSync(path, 'utf8'), '{}')
    assert.equal(readFileSync(`${path}.tmp-${process.pid}`, 'utf8'), 'planted')
  })

  it('Proves the file mode is kept after the write', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o640)
    assert.equal(writeAllow(path, ['Read'], NOW).ok, true)
    assert.equal(lstatSync(path).mode & 0o777, 0o640)
  })

  it('Proves the exact file mode is kept whatever the umask', () => {
    const previous = process.umask(0o077)
    try {
      for (const mode of [0o640, 0o664]) {
        const path = join(dir, `settings-${mode.toString(8)}.json`)
        writeFileSync(path, '{}')
        chmodSync(path, mode)
        assert.equal(writeAllow(path, ['Read'], NOW).ok, true)
        assert.equal(lstatSync(path).mode & 0o777, mode)
      }
    } finally {
      process.umask(previous)
    }
  })

  it('Proves a permissions value that is not an object is refused and untouched', () => {
    for (const original of ['{"permissions":[]}', '{"permissions":"x"}']) {
      const path = join(dir, 'settings.json')
      writeFileSync(path, original)
      const result = writeAllow(path, ['Read'], NOW)
      assert.equal(result.ok, false)
      assert.match(result.ok ? '' : result.reason, /permissions/)
      assert.equal(readFileSync(path, 'utf8'), original)
      assert.deepEqual(readdirSync(dir), ['settings.json'])
    }
  })

  it('Proves a backup name already taken is refused, the original untouched and no temporary file left', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    writeFileSync(`${path}.bak-20261127T211019Z`, 'taken')
    const result = writeAllow(path, ['Read'], NOW)
    assert.equal(result.ok, false)
    const reason = result.ok ? '' : result.reason
    assert.match(reason, /\.bak-20261127T211019Z already exists/)
    assert.doesNotMatch(reason, /settings\.json already exists/)
    assert.equal(readFileSync(path, 'utf8'), '{}')
    assert.equal(readFileSync(`${path}.bak-20261127T211019Z`, 'utf8'), 'taken')
    assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-')), [])
  })
})

describe('the installer run', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'allow-rules-'))
  })
  afterEach(() => {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (mode: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, SCOPE: 'user', CLAUDE_CONFIG_DIR: dir, ALLOW_RULES: mode, ...extra },
    })

  const assertPlainFailure = (stderr: string) => {
    assert.match(stderr, /^allow-rules: .+\n$/)
    assert.equal(stderr.trim().split('\n').length, 1)
    assert.doesNotMatch(stderr, /^ {4}at /m)
    assert.doesNotMatch(stderr, /node:/)
  }

  it('Proves a read-only folder fails with one plain line and leaves nothing behind', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    chmodSync(dir, 0o500)
    const result = run('yes')
    chmodSync(dir, 0o700)
    assert.notEqual(result.status, 0)
    assertPlainFailure(result.stderr)
    assert.equal(readFileSync(path, 'utf8'), '{}')
    assert.deepEqual(readdirSync(dir), ['settings.json'])
  })

  it('Proves a write that fails after the temporary file is opened leaves no temporary file and the original untouched', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{}')
    const result = spawnSync(
      'sh',
      ['-c', 'trap "" XFSZ; ulimit -f 0; exec "$0" "$1"', process.execPath, SCRIPT],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, SCOPE: 'user', CLAUDE_CONFIG_DIR: dir, ALLOW_RULES: 'yes' },
      },
    )
    assert.notEqual(result.status, 0)
    assertPlainFailure(result.stderr)
    assert.equal(readFileSync(path, 'utf8'), '{}')
    assert.deepEqual(readdirSync(dir), ['settings.json'])
  })

  it('Proves a settings folder that cannot be created fails with one plain line', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const result = run('yes', { CLAUDE_CONFIG_DIR: join(blocker, 'inner') })
    assert.notEqual(result.status, 0)
    assertPlainFailure(result.stderr)
  })

  it('Proves a globbed server is named in print and yes mode, with the rules to add by hand', () => {
    const settings = '{"pluginConfigs":{"codemode":{"options":{"mcpCodemode":"codegraph, claude_ai_*"}}}}'
    for (const mode of ['print', 'yes']) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'settings.json'), settings)
      const result = run(mode)
      assert.equal(result.status, 0)
      assert.match(result.stdout, /^ {2}mcp__codegraph__\*$/m)
      assert.match(result.stdout, /claude_ai_\*.*by hand/)
    }
  })
})
