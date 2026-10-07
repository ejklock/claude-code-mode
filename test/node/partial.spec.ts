import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { countChecked, listedBeforeRedo, measureLedger, summarizePartial } from '../../scripts/partial.ts'
import type { PartialSample } from '../../scripts/partial.ts'

const EXPECTED = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']

const sample = (over: Partial<PartialSample> = {}): PartialSample => ({
  usedCodemode: true,
  attempted: 7,
  distinct: 6,
  duplicates: 0,
  complete: true,
  turns: 3,
  output: 500,
  cost: 0.1,
  ms: 10_000,
  ...over,
})

describe('measureLedger', () => {
  it('counts no duplicates when each record is created once and the failed attempt is retried', () => {
    const ledger = ['ok\tr1', 'ok\tr2', 'ok\tr3', 'fail\tr4', 'ok\tr4', 'ok\tr5', 'ok\tr6', ''].join('\n')
    assert.deepEqual(measureLedger(ledger, EXPECTED), { attempted: 7, distinct: 6, duplicates: 0, complete: true })
  })

  it('counts one duplicate when a record is created twice', () => {
    const ledger = ['ok\tr1', 'ok\tr2', 'ok\tr3', 'fail\tr4', 'ok\tr1', 'ok\tr2', 'ok\tr3', 'ok\tr4', 'ok\tr5', 'ok\tr6'].join('\n')
    assert.deepEqual(measureLedger(ledger, EXPECTED), { attempted: 10, distinct: 6, duplicates: 3, complete: true })
    const once = ['ok\tr1', 'ok\tr1', 'ok\tr2', 'ok\tr3', 'ok\tr4', 'ok\tr5', 'ok\tr6'].join('\n')
    assert.equal(measureLedger(once, EXPECTED).duplicates, 1)
  })

  it('marks a run incomplete when a record never succeeded', () => {
    const ledger = ['ok\tr1', 'ok\tr2', 'ok\tr3', 'fail\tr4', 'ok\tr5', 'ok\tr6'].join('\n')
    const measure = measureLedger(ledger, EXPECTED)
    assert.equal(measure.complete, false)
    assert.equal(measure.distinct, 5)
  })

  it('reads an empty ledger as nothing created', () => {
    assert.deepEqual(measureLedger('', EXPECTED), { attempted: 0, distinct: 0, duplicates: 0, complete: false })
  })
})

describe('summarizePartial', () => {
  it('takes the median of each metric over the runs that used codemode', () => {
    const summary = summarizePartial([
      sample({ duplicates: 0, output: 100 }),
      sample({ duplicates: 3, output: 300 }),
      sample({ duplicates: 3, output: 200 }),
    ])
    assert.equal(summary.counted, 3)
    assert.equal(summary.median?.duplicates, 3)
    assert.equal(summary.median?.output, 200)
  })

  it('reports a run that never used codemode apart, not averaged in', () => {
    const summary = summarizePartial([sample({ duplicates: 3 }), sample({ usedCodemode: false, duplicates: 0 })])
    assert.equal(summary.counted, 1)
    assert.equal(summary.withoutCodemode, 1)
    assert.equal(summary.median?.duplicates, 3)
  })

  it('counts a run missing a record as incomplete', () => {
    const summary = summarizePartial([sample(), sample({ complete: false })])
    assert.equal(summary.incomplete, 1)
  })

  it('has no median when no run used codemode', () => {
    const summary = summarizePartial([sample({ usedCodemode: false })])
    assert.equal(summary.median, undefined)
  })
})

describe('ambiguous ledger', () => {
  const lost = ['ok\tr1', 'ok\tr2', 'ok\tr3', 'ok\tr4', 'lost\tr4']

  it('counts no duplicate and reads the check when the lost record is listed before it is redone', () => {
    const ledger = [...lost, 'list\t', 'ok\tr5', 'ok\tr6', ''].join('\n')
    assert.deepEqual(measureLedger(ledger, EXPECTED), { attempted: 6, distinct: 6, duplicates: 0, complete: true })
    assert.equal(listedBeforeRedo(ledger), true)
  })

  it('counts one duplicate and no check when the lost record is redone blind', () => {
    const ledger = [...lost, 'ok\tr4', 'ok\tr5', 'ok\tr6'].join('\n')
    assert.deepEqual(measureLedger(ledger, EXPECTED), { attempted: 7, distinct: 6, duplicates: 1, complete: true })
    assert.equal(listedBeforeRedo(ledger), false)
  })

  it('does not credit a list that came after the redo', () => {
    const ledger = [...lost, 'ok\tr4', 'list\t'].join('\n')
    assert.equal(listedBeforeRedo(ledger), false)
  })

  it('does not credit a list that came before the answer was lost', () => {
    const ledger = ['ok\tr1', 'list\t', 'ok\tr2', 'ok\tr3', 'ok\tr4', 'lost\tr4', 'ok\tr4'].join('\n')
    assert.equal(listedBeforeRedo(ledger), false)
  })

  it('has no verdict when no answer was lost', () => {
    assert.equal(listedBeforeRedo(['ok\tr1', 'list\t'].join('\n')), undefined)
  })
})

describe('countChecked', () => {
  it('counts the codemode runs that listed before the redo, apart from runs without codemode', () => {
    const samples = [sample({ checked: true }), sample({ checked: false }), sample({ checked: true, usedCodemode: false })]
    assert.deepEqual(countChecked(samples), { checked: 1, counted: 2 })
  })
})
