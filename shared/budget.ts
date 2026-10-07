/** Characters of script output the mod receives before the middle is cut out. */
export const OUTPUT_BUDGET = 20_480

/**
 * Returns `output` unchanged within `budget` characters; past it, the first and last
 * half around one marker line. `persist` stores the whole text and returns its path,
 * or throws, in which case the marker says the text could not be saved.
 */
export function withinBudget(output: string, budget: number, persist: (whole: string) => string): string {
  if (output.length <= budget) return output
  const headLength = wholePairsEnd(output, Math.floor(budget / 2))
  const tailStart = wholePairsStart(output, output.length - (budget - Math.floor(budget / 2)))
  const removed = tailStart - headLength
  return `${output.slice(0, headLength)}\n${marker(removed, output, persist)}\n${output.slice(tailStart)}`
}

/** Moves a cut point back when it would fall between the two halves of a surrogate pair. */
function wholePairsEnd(text: string, end: number): number {
  const last = text.charCodeAt(end - 1)
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end
}

/** Moves a cut point forward when it would fall between the two halves of a surrogate pair. */
function wholePairsStart(text: string, start: number): number {
  const first = text.charCodeAt(start)
  return first >= 0xdc00 && first <= 0xdfff ? start + 1 : start
}

function marker(removed: number, whole: string, persist: (whole: string) => string): string {
  const count = `${removed.toLocaleString('en-US')} characters removed`
  try {
    const path = persist(whole)
    return `[… ${count}; the whole output is in ${path} — Read it with offset and limit, or search it]`
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return `[… ${count}; the whole output could not be saved: ${reason}]`
  }
}
