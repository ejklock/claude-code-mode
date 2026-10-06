import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { measureRun, median, summarizeOverhead } from '../../scripts/overhead.ts'

describe('the median of the measured times', () => {
  it('Proves C1: an odd count is the middle of the sorted values', () => {
    assert.equal(median([30, 10, 20]), 20)
  })

  it('Proves C1: an even count is the mean of the two middle values', () => {
    assert.equal(median([10, 40, 20, 30]), 25)
  })

  it('Proves C1: no values give no median', () => {
    assert.equal(median([]), undefined)
  })
})

describe('the summary of one size', () => {
  it('Proves C1: a failed run is left out of the median, the range and the per-call median, and counted apart', () => {
    const rows = summarizeOverhead([
      { calls: 10, ms: 400, ok: true, spans: [5, 7] },
      { calls: 10, ms: 500, ok: true, spans: [3, 9] },
      { calls: 10, ms: 50, ok: false, spans: [1, 1] },
    ])
    assert.deepEqual(rows, [
      { calls: 10, kept: 2, failed: 1, medianMs: 450, minMs: 400, maxMs: 500, perCallMs: 6 },
    ])
  })

  it('Proves C1: the sizes come ascending, each with only its own runs', () => {
    const rows = summarizeOverhead([
      { calls: 10, ms: 300, ok: true, spans: [] },
      { calls: 1, ms: 40, ok: true, spans: [] },
      { calls: 10, ms: 100, ok: true, spans: [] },
    ])
    assert.deepEqual(rows.map(row => row.calls), [1, 10])
    assert.deepEqual(rows.map(row => row.medianMs), [40, 200])
    assert.deepEqual(rows.map(row => row.failed), [0, 0])
    assert.deepEqual(rows.map(row => row.perCallMs), [undefined, undefined])
  })

  it('Proves C1: a size whose every run failed has no median, no range and no per-call median, only the count', () => {
    const rows = summarizeOverhead([
      { calls: 5, ms: 10, ok: false, spans: [1, 2] },
      { calls: 5, ms: 20, ok: false, spans: [3, 4] },
    ])
    assert.deepEqual(rows, [
      { calls: 5, kept: 0, failed: 2, medianMs: undefined, minMs: undefined, maxMs: undefined, perCallMs: undefined },
    ])
  })
})

describe('the benchmark measures a real run with no model', () => {
  it('Proves C1: a script that reads once and one that reads nothing both end well, measured', async () => {
    const zero = await measureRun(0)
    const one = await measureRun(1)
    assert.equal(zero.ok, true, zero.reason ?? 'the 0-call run failed')
    assert.equal(one.ok, true, one.reason ?? 'the 1-call run failed')
    assert.ok(zero.ms > 0, 'the 0-call run took no time')
    assert.ok(one.ms > 0, 'the 1-call run took no time')
  })

  it('Proves C1: a run of two calls spans one full round trip between their call lines', async () => {
    const two = await measureRun(2)
    assert.equal(two.ok, true, two.reason ?? 'the 2-call run failed')
    assert.equal(two.spans.length, 1)
    const [span] = two.spans
    assert.ok(span !== undefined && span > 0, 'the span took no time')
  })
})
