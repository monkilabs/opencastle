/**
 * "Did you mean …?" for a word someone typed.
 *
 * Four commands carried their own copy of this, with thresholds that had begun
 * to differ: one always named a candidate, however far off, so `--json` on the
 * viewer was answered with "did you mean --port?". One copy, one rule.
 */

/** Levenshtein distance: the fewest single-character edits from `a` to `b`. */
export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]
}

/**
 * The candidate closest to `word`, or null when none is close enough to be a
 * plausible typo: within two edits, or a third of the word's length for a long
 * one. A suggestion that is not a likely typo sends people the wrong way.
 */
export function nearest(word: string, candidates: readonly string[], opts: { ignoreCase?: boolean } = {}): string | null {
  const norm = (s: string): string => (opts.ignoreCase ? s.toLowerCase() : s)
  let best: string | null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const d = editDistance(norm(word), norm(candidate))
    if (d < bestDistance) [best, bestDistance] = [candidate, d]
  }
  return best !== null && bestDistance <= Math.max(2, Math.floor(word.length / 3)) ? best : null
}
