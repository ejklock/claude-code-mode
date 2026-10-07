import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { modeOf, readExposure } from '../../hooks/exposure.ts'
import type { ExposureMode } from '../../hooks/exposure.ts'

type Lists = {
  mcpCodemode?: string[]
  mcpDeferred?: string[]
  mcpDirect?: string[]
  mcpHidden?: string[]
}

const modeFor = (lists: Lists, tool: string): ExposureMode | undefined => modeOf(readExposure(lists), tool)

describe('modeOf', () => {
  it('Proves C1: no list set gives no mode', () => {
    assert.equal(modeFor({}, 'mcp__codegraph__codegraph_status'), undefined)
    assert.equal(modeFor({ mcpCodemode: [], mcpHidden: [] }, 'mcp__codegraph__codegraph_status'), undefined)
  })

  it('Proves C1: a bare server covers its tools only', () => {
    const lists = { mcpCodemode: ['codegraph'] }
    assert.equal(modeFor(lists, 'mcp__codegraph__codegraph_status'), 'codemode')
    assert.equal(modeFor(lists, 'mcp__other__x'), undefined)
    assert.equal(modeFor(lists, 'Read'), undefined)
    assert.equal(modeFor(lists, 'mcp__codegraph2__x'), undefined)
  })

  it('Proves C1: a leading mcp__ on an entry is accepted', () => {
    assert.equal(modeFor({ mcpCodemode: ['mcp__codegraph'] }, 'mcp__codegraph__codegraph_status'), 'codemode')
  })

  it('Proves C1: the codemode tool itself never has a mode', () => {
    assert.equal(modeFor({ mcpCodemode: ['codemode'] }, 'mcp__codemode__codemode'), undefined)
    assert.equal(modeFor({ mcpHidden: ['codemode__*'] }, 'mcp__codemode__codemode'), undefined)
  })

  it('Proves C1: regex metacharacters match themselves', () => {
    assert.equal(modeFor({ mcpCodemode: ['a.b__x'] }, 'mcp__aXb__x'), undefined)
    assert.equal(modeFor({ mcpCodemode: ['a.b__x'] }, 'mcp__a.b__x'), 'codemode')
  })

  it('Proves C1: matching is case-sensitive', () => {
    assert.equal(modeFor({ mcpCodemode: ['CodeGraph'] }, 'mcp__codegraph__codegraph_status'), undefined)
  })
})

describe('modeOf precedence', () => {
  it('Proves C2: an exact tool beats a bare server', () => {
    const lists = { mcpDeferred: ['s'], mcpDirect: ['s__t'] }
    assert.equal(modeFor(lists, 'mcp__s__t'), 'direct')
    assert.equal(modeFor(lists, 'mcp__s__u'), 'deferred')
  })

  it('Proves C2: an exact tool beats a pattern, a pattern beats the server', () => {
    const lists = { mcpHidden: ['s__t*'], mcpDirect: ['s__t'] }
    assert.equal(modeFor(lists, 'mcp__s__t'), 'direct')
    assert.equal(modeFor(lists, 'mcp__s__tx'), 'hidden')
    assert.equal(modeFor({ mcpDirect: ['s'], mcpHidden: ['s__t*'] }, 'mcp__s__tx'), 'hidden')
  })

  it('Proves C2: patterns are read hidden first', () => {
    const lists = { mcpDirect: ['s__*'], mcpHidden: ['s__t*'] }
    assert.equal(modeFor(lists, 'mcp__s__tx'), 'hidden')
    assert.equal(modeFor(lists, 'mcp__s__u'), 'direct')
  })

  it('Proves C2: patterns of one list are read in written order', () => {
    assert.equal(modeFor({ mcpCodemode: ['s__a*', 's__*'] }, 'mcp__s__ab'), 'codemode')
    assert.equal(modeFor({ mcpCodemode: ['s__*'], mcpDeferred: ['s__a*'] }, 'mcp__s__ab'), 'codemode')
  })

  it('Proves C2: a star matches any run, including none', () => {
    const lists = { mcpCodemode: ['s__*_x'] }
    assert.equal(modeFor(lists, 'mcp__s___x'), 'codemode')
    assert.equal(modeFor(lists, 'mcp__s__ab_x'), 'codemode')
    assert.equal(modeFor(lists, 'mcp__s__ab_y'), undefined)
  })
})

describe('readExposure', () => {
  const refused = (lists: Lists, ...parts: string[]) =>
    assert.throws(
      () => readExposure(lists),
      (error: Error) => parts.every(part => error.message.includes(part)),
    )

  it('Proves C3: the same entry in two lists fails naming the entry and both lists', () => {
    refused({ mcpCodemode: ['codegraph'], mcpHidden: ['codegraph'] }, 'codegraph', 'mcpCodemode', 'mcpHidden')
  })

  it('Proves C3: the same entry after dropping mcp__ fails', () => {
    refused({ mcpCodemode: ['codegraph'], mcpDirect: ['mcp__codegraph'] }, 'codegraph', 'mcpCodemode', 'mcpDirect')
  })

  it('Proves C3: an entry twice in one list fails', () => {
    refused({ mcpDeferred: ['x', 'x'] }, '"x"', 'mcpDeferred')
  })

  it('Proves C3: an empty or blank entry fails', () => {
    refused({ mcpDirect: [''] }, 'mcpDirect')
    refused({ mcpHidden: ['  '] }, 'mcpHidden')
  })

  it('Proves C3: distinct entries in all four lists succeed', () => {
    const exposure = readExposure({ mcpCodemode: ['a'], mcpDeferred: ['b'], mcpDirect: ['c'], mcpHidden: ['d'] })
    assert.equal(modeOf(exposure, 'mcp__d__t'), 'hidden')
  })
})

type Raw = Readonly<Record<string, unknown>>

const modeRaw = (options: Raw, tool: string): ExposureMode | undefined => modeOf(readExposure(options), tool)

const refusedRaw = (options: Raw, ...parts: string[]) =>
  assert.throws(
    () => readExposure(options),
    (error: Error) => parts.every(part => error.message.includes(part)),
  )

describe('readExposure, string settings', () => {
  it('Proves C5: a string is split on commas and each piece trimmed', () => {
    const options = { mcpCodemode: 'codegraph, claude_ai_Gmail' }
    assert.equal(modeRaw(options, 'mcp__codegraph__x'), 'codemode')
    assert.equal(modeRaw(options, 'mcp__claude_ai_Gmail__y'), 'codemode')
    assert.equal(modeRaw(options, 'mcp__other__z'), undefined)
  })

  it('Proves C5: one name with no comma is one entry', () => {
    assert.equal(modeRaw({ mcpCodemode: 'codegraph' }, 'mcp__codegraph__x'), 'codemode')
  })

  it('Proves C5: a trailing comma is no entry', () => {
    assert.equal(modeRaw({ mcpCodemode: 'codegraph,' }, 'mcp__codegraph__x'), 'codemode')
  })

  it('Proves C5: an empty or blank string is no entries', () => {
    assert.equal(modeRaw({ mcpCodemode: '' }, 'mcp__codegraph__x'), undefined)
    assert.equal(modeRaw({ mcpCodemode: '   ' }, 'mcp__codegraph__x'), undefined)
  })

  it('Proves C5: an empty middle piece fails', () => {
    refusedRaw({ mcpCodemode: 'codegraph,,x' }, 'mcpCodemode')
  })

  it('Proves C5: two trailing commas drop one empty piece and refuse the other', () => {
    refusedRaw({ mcpCodemode: 'codegraph,,' }, 'mcpCodemode', 'empty')
  })

  it('Proves C5: the same entry as a string and as an array fails', () => {
    refusedRaw({ mcpCodemode: 'codegraph', mcpHidden: ['codegraph'] }, 'codegraph', 'mcpCodemode', 'mcpHidden')
  })

  it('Proves C5: a number or an array holding a number fails naming the setting', () => {
    refusedRaw({ mcpDirect: 3 }, 'mcpDirect')
    refusedRaw({ mcpDirect: [1] }, 'mcpDirect')
  })
})

describe('readExposure, entries empty after the prefix', () => {
  it('Proves C6: mcp__ alone fails naming the setting', () => {
    refusedRaw({ mcpHidden: ['mcp__'] }, 'mcpHidden')
    refusedRaw({ mcpHidden: [' mcp__ '] }, 'mcpHidden')
  })

  it('Proves C6: mcp__ with a name still loads', () => {
    assert.equal(modeRaw({ mcpCodemode: ['mcp__codegraph'] }, 'mcp__codegraph__x'), 'codemode')
  })

  it('Proves C6: mcp__ as a string setting fails', () => {
    refusedRaw({ mcpDeferred: 'mcp__' }, 'mcpDeferred')
  })
})

describe('modeOf, patterns without a separator', () => {
  it('Proves C7: a pattern with no __ spans servers', () => {
    const options = { mcpHidden: ['code*'] }
    assert.equal(modeRaw(options, 'mcp__codegraph__x'), 'hidden')
    assert.equal(modeRaw(options, 'mcp__codex__y'), 'hidden')
    assert.equal(modeRaw(options, 'mcp__other__z'), undefined)
  })

  it('Proves C7: a lone star covers every tool but the codemode tool and host tools', () => {
    const options = { mcpCodemode: ['*'] }
    assert.equal(modeRaw(options, 'mcp__any__tool'), 'codemode')
    assert.equal(modeRaw(options, 'mcp__codemode__codemode'), undefined)
    assert.equal(modeRaw(options, 'Read'), undefined)
  })
})

describe('Exposure is opaque', () => {
  it('Proves C8: a caller cannot read its fields', () => {
    const exposure = readExposure({})
    // @ts-expect-error the representation is private to hooks/exposure.ts
    assert.equal(exposure.exact, undefined)
  })
})
