import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inlineScriptKind } from '../../scripts/inline-script.ts'

describe('a Bash command is classified by the inline script it runs', () => {
  const positives: Array<[string, string]> = [
    ["python3 - <<'EOF'", 'python-stdin'],
    ['python3 <<EOF', 'python-stdin'],
    ['python3 -c "print(1)"', 'python-c'],
    ["python -c 'x'", 'python-c'],
    ['node -e "1"', 'node-e'],
    ['node -p "1"', 'node-e'],
    ['node <<EOF', 'node-stdin'],
    ['node - <<EOF', 'node-stdin'],
    ['cat f.json | python3 -', 'python-stdin'],
    ['cd x && python3 - <<EOF', 'python-stdin'],
    ['/usr/bin/python3 -c x', 'python-c'],
    ['python3.12 -c x', 'python-c'],
    ['python3 -u -c x', 'python-c'],
    ['bash -lc "python3 -c x"', 'python-c'],
    ["sh -c 'python3 - <<EOF'", 'python-stdin'],
    ['bash -c "node -e 1"', 'node-e'],
  ]
  for (const [command, kind] of positives) {
    it(`Proves C1: ${command} is ${kind}`, () => {
      assert.equal(inlineScriptKind(command), kind)
    })
  }

  const negatives = [
    'python3 script.py',
    'python3 -m pytest',
    'python3 script.py <<EOF',
    'pip install x',
    'grep python file',
    'node script.js',
    'npm test',
    'nodemon -e js',
    '',
  ]
  for (const command of negatives) {
    it(`Proves C1: "${command}" is none`, () => {
      assert.equal(inlineScriptKind(command), undefined)
    })
  }
})
