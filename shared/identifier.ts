/**
 * The identifier a codemode script uses for a tool name: each character outside
 * A-Za-z0-9_$ becomes `_`, a leading digit too, and an empty name becomes `_`.
 * A copy of `toCodemodeIdentifier` from @earendil-works/pi-codemode, because the
 * hooks loader allows only relative imports; test/node/identifier.spec.ts checks it.
 */
export function toScriptIdentifier(name: string): string {
  let identifier = ''
  for (const char of name) {
    const valid = identifier === '' ? /^[A-Za-z_$]$/.test(char) : /^[A-Za-z0-9_$]$/.test(char)
    identifier += valid ? char : '_'
  }
  return identifier === '' ? '_' : identifier
}
