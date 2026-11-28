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

describe('a Bash command is classified by the shell script it runs inline', () => {
  const positives: Array<[string, string]> = [
    ["bash -c 'ls'", 'shell-c'],
    ['/bin/sh -c x', 'shell-c'],
    ['zsh -lc x', 'shell-c'],
    ['bash -o pipefail -c x', 'shell-c'],
    ["bash <<'EOF'", 'shell-stdin'],
    ['sh -s <<EOF', 'shell-stdin'],
    ['curl x | bash', 'shell-stdin'],
    ['echo x | sh -s', 'shell-stdin'],
    ['for f in *.ts; do wc -l "$f"; done', 'shell-loop'],
    ['while read l; do echo "$l"; done < f', 'shell-loop'],
    ['for ((i=0;i<3;i++)); do :; done', 'shell-loop'],
    ['cd x && for f in a b\ndo echo $f; done', 'shell-loop'],
    ['bash -lc "python3 -c x"', 'python-c'],
    ["bash <<'EOF'\npython3 -c x\nEOF", 'python-c'],
    ['bash -c "for f in a; do :; done"', 'shell-c'],
    ['bash <<EOF\nfor f in a; do :; done\nEOF', 'shell-stdin'],
    ['for f in a; do bash -c x; done', 'shell-c'],
  ]
  for (const [command, kind] of positives) {
    it(`${JSON.stringify(command)} is ${kind}`, () => {
      assert.equal(inlineScriptKind(command), kind)
    })
  }

  const negatives = [
    'ls',
    'git status',
    'bash script.sh',
    'echo x | bash script.sh',
    'a || bash -s',
    'ssh host ls',
    'echo format',
    'npm run fortune',
    'echo "for x in y"',
    'grep while file',
    'for x in y',
  ]
  for (const command of negatives) {
    it(`${JSON.stringify(command)} is none`, () => {
      assert.equal(inlineScriptKind(command), undefined)
    })
  }
})

describe('a heredoc body is data, not commands', () => {
  const cases: Array<[string, string | undefined]> = [
    ['git commit -m "$(cat <<\'EOF\'\nfix: bash -c x\nEOF\n)"', undefined],
    ["cat > x.sh <<'EOF'\nfor f in *; do echo $f; done\nEOF", undefined],
    ['cat > x.sh <<-EOF\n\tfor f in *; do echo $f; done\n\tEOF', undefined],
    ['cat <<EOF\nbash -c x\nEOF\nls', undefined],
    ["bash <<'EOF'\necho x\nEOF", 'shell-stdin'],
    ["python3 - <<'EOF'\nprint(1)\nEOF", 'python-stdin'],
    ['bash <<EOF\nbash -c x\nEOF', 'shell-stdin'],
    ["cat <<'EOF'\nx\nEOF\nbash -c y", 'shell-c'],
    ["cat <<'EOF'\nx\nEOF\nfor f in a; do :; done", 'shell-loop'],
  ]
  for (const [command, kind] of cases) {
    it(`${JSON.stringify(command)} is ${kind ?? 'none'}`, () => {
      assert.equal(inlineScriptKind(command), kind)
    })
  }
})

describe('the documented precedence and limits of the shell kinds', () => {
  const cases: Array<[string, string | undefined]> = [
    ['curl x | bash -c y', 'shell-c'],
    ["echo 'a; for x in y; z; do'", 'shell-loop'],
    ['cmd | python3', undefined],
    ['cmd | bash', 'shell-stdin'],
  ]
  for (const [command, kind] of cases) {
    it(`${JSON.stringify(command)} is ${kind ?? 'none'}`, () => {
      assert.equal(inlineScriptKind(command), kind)
    })
  }
})

describe('a large command is classified in bounded time', () => {
  const timeOf = (command: string): number => {
    const start = performance.now()
    inlineScriptKind(command)
    return performance.now() - start
  }

  it('a 200 KB command without whitespace and with many quotes takes under 100 ms', () => {
    assert.ok(timeOf('"a/'.repeat(70_000)) < 100)
  })

  it('a 220 KB heredoc takes under 100 ms', () => {
    assert.ok(timeOf(`cat <<'EOF'\n${'for x in y; do bash -c z; '.repeat(8_000)}\nEOF`) < 100)
  })

  it('a 96 KB command with many quotes takes under 100 ms', () => {
    assert.ok(timeOf('"a/'.repeat(32_000)) < 100)
  })

  it('a 96 KB command made of shell invocations takes under 100 ms', () => {
    assert.ok(timeOf('"sh/'.repeat(24_000)) < 100)
  })

  it('a 96 KB command made of loops and shell calls takes under 100 ms', () => {
    assert.ok(timeOf('for x in y; do bash -c z; '.repeat(3_700)) < 100)
  })

  it('a 250 KB command is classified as nothing', () => {
    assert.equal(inlineScriptKind(`python3 -c x ${'a'.repeat(250_000)}`), undefined)
  })
})
