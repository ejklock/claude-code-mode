import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OUTPUT_BUDGET, withinBudget } from '../../shared/budget.ts'

const PATH = '/tmp/codemode-output-x/output.txt'

function saved(): { persist: (whole: string) => string; wholes: string[] } {
  const wholes: string[] = []
  return {
    wholes,
    persist: whole => {
      wholes.push(whole)
      return PATH
    },
  }
}

/** Distinct characters so a head or tail taken from the wrong place shows. */
function numbered(length: number): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')
}

/** Emoji straddling both the head's end and the tail's start for the default budget. */
const STRADDLING = 'a'.repeat(10_239) + '😀' + 'm'.repeat(1_000) + '😀' + 'b'.repeat(10_239)

describe('the output budget', () => {
  it('Proves C1: an empty output and one exactly at the budget come back unchanged without saving', () => {
    for (const output of ['', numbered(20_480)]) {
      const fake = saved()
      assert.equal(withinBudget(output, OUTPUT_BUDGET, fake.persist), output)
      assert.deepEqual(fake.wholes, [])
    }
  })

  it('Proves C1: one character over and far over are cut to head, marker, tail', () => {
    for (const length of [20_481, 100_000]) {
      const output = numbered(length)
      const fake = saved()
      const lines = withinBudget(output, OUTPUT_BUDGET, fake.persist).split('\n')
      assert.equal(lines.length, 3)
      const [head, marker, tail] = lines as [string, string, string]
      assert.ok(output.startsWith(head))
      assert.ok(output.endsWith(tail))
      assert.ok(Math.abs(head.length - tail.length) <= 1)
      const removed = length - head.length - tail.length
      assert.ok(marker.includes(`${removed.toLocaleString('en-US')} characters removed`), marker)
      assert.ok(marker.includes(PATH), marker)
      assert.ok(head.length + tail.length <= OUTPUT_BUDGET)
      assert.deepEqual(fake.wholes, [output])
    }
  })

  it('Proves C2: a surrogate pair straddling the head end or the tail start is never split', () => {
    const result = withinBudget(STRADDLING, OUTPUT_BUDGET, saved().persist)
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    assert.doesNotMatch(result, lone, 'the result holds a lone surrogate')
    assert.ok(result.length < STRADDLING.length)
  })

  it('Proves C2: the removed count is the output length minus head minus tail', () => {
    const [head, marker, tail] = withinBudget(STRADDLING, OUTPUT_BUDGET, saved().persist).split('\n') as [string, string, string]
    assert.ok(marker !== undefined, 'the result holds no marker line')
    const removed = STRADDLING.length - head.length - tail.length
    assert.ok(marker.includes(`${removed.toLocaleString('en-US')} characters removed`), marker)
  })

  it('Proves C2: a persister that throws still cuts, says so with its message, and names no path', () => {
    const output = numbered(30_000)
    const result = withinBudget(output, OUTPUT_BUDGET, () => {
      throw new Error('disk is full')
    })
    const [head, marker, tail] = result.split('\n') as [string, string, string]
    assert.ok(output.startsWith(head) && output.endsWith(tail))
    assert.ok(marker.includes('could not be saved'), marker)
    assert.ok(marker.includes('disk is full'), marker)
    assert.ok(!marker.includes('/'), marker)
  })

  it('Proves C4: a multi-line output over the budget keeps its first and last halves around one marker', () => {
    const output = Array.from({ length: 3_000 }, (_, i) => `${String(i).padStart(9, '0')}x\n`).join('')
    assert.equal(output.length, 33_000)
    const result = withinBudget(output, OUTPUT_BUDGET, saved().persist)
    const markers = [...result.matchAll(/^\[… ([\d,]+) characters removed.*\]$/gm)]
    assert.equal(markers.length, 1)
    const found = markers[0] as RegExpMatchArray & { index: number }
    const head = result.slice(0, found.index - 1)
    const tail = result.slice(found.index + found[0].length + 1)
    assert.equal(result[found.index - 1], '\n')
    assert.equal(head, output.slice(0, 10_240))
    assert.equal(tail, output.slice(output.length - 10_240))
    const removed = output.length - head.length - tail.length
    assert.equal(found[1], removed.toLocaleString('en-US'))
  })

  it('Proves C4: a multi-line output of exactly the budget comes back unchanged', () => {
    const output = Array.from({ length: 2_048 }, () => 'abcdefghi\n').join('')
    assert.equal(output.length, 20_480)
    const fake = saved()
    assert.equal(withinBudget(output, OUTPUT_BUDGET, fake.persist), output)
    assert.deepEqual(fake.wholes, [])
  })

  it('Proves C5: both cut points moving in one call shorten head and tail by one each', () => {
    const { head, tail, removed } = parts(STRADDLING)
    assert.equal(head.length, 10_239)
    assert.equal(tail.length, 10_239)
    assert.equal(head.length + tail.length, OUTPUT_BUDGET - 2)
    assert.equal(removed, (STRADDLING.length - 20_478).toLocaleString('en-US'))
  })

  it('Proves C5: only the head end straddling a pair leaves the tail at its exact half', () => {
    const output = 'a'.repeat(10_239) + '😀' + 'm'.repeat(1_000) + 'b'.repeat(10_240)
    const { head, tail, removed } = parts(output)
    assert.equal(head.length, 10_239)
    assert.equal(tail.length, 10_240)
    assert.equal(removed, (output.length - 20_479).toLocaleString('en-US'))
  })

  it('Proves C5: only the tail start straddling a pair leaves the head at its exact half', () => {
    const output = 'a'.repeat(10_240) + 'm'.repeat(1_000) + '😀' + 'b'.repeat(10_239)
    const { head, tail, removed } = parts(output)
    assert.equal(head.length, 10_240)
    assert.equal(tail.length, 10_239)
    assert.equal(removed, (output.length - 20_479).toLocaleString('en-US'))
  })
})

/** Splits a cut result at its single marker line without assuming the halves hold no newline. */
function parts(output: string): { head: string; tail: string; removed: string } {
  const result = withinBudget(output, OUTPUT_BUDGET, saved().persist)
  const found = /^\[… ([\d,]+) characters removed.*\]$/m.exec(result)
  assert.ok(found?.index !== undefined, 'the result holds no marker line')
  return {
    head: result.slice(0, found.index - 1),
    tail: result.slice(found.index + found[0].length + 1),
    removed: found[1] as string,
  }
}
