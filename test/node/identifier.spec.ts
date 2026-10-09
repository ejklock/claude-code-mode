import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { toCodemodeIdentifier as oracle } from '@earendil-works/pi-codemode'

import { toScriptIdentifier } from '../../shared/identifier.ts'

const SAMPLES = [
  'mcp__agent-memory__memory_read',
  'mcp__my.server__x',
  'mcp__my server__x',
  '9lives',
  'mcp__a$b__x',
  'mcp__already_valid__x',
  'mcp__café__x',
  'é',
  '😀tool',
  '',
]

describe('toScriptIdentifier', () => {
  for (const name of SAMPLES) {
    it(`Proves C1: matches the package for ${JSON.stringify(name)}`, () => {
      assert.equal(toScriptIdentifier(name), oracle(name))
    })
  }
})
