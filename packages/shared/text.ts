/**
 * Name normalisation, shared by the index builder and the search engine.
 *
 * WHY IT LIVES IN shared/: the pipeline normalises names when building the places index, and
 * the engine normalises the query when searching it. If those two ever differ by a single
 * character class, every affected name becomes unfindable and NOTHING reports an error: the
 * index looks full, the query looks reasonable, and the result list is empty. One
 * implementation, reachable by both, is the only way that class of bug cannot occur.
 * `packages/CLAUDE.md` forbids the pipeline importing the engine, so shared/ is the only
 * place both can reach. Separate from index.ts, which is THE CONTRACT and holds types.
 */

/**
 * Lowercase, strip Latin diacritics, drop punctuation, collapse whitespace.
 *
 * DEVANAGARI IS DELIBERATELY LEFT ALONE beyond the combining-mark strip being scoped to the
 * Latin range. It has no case to fold. Applying NFD and then removing all combining marks
 * would strip its matras, turning कासना into कसन, which does not match anything a person would
 * type and silently corrupts every Hindi name in the index.
 */
export function normalise(s: string): string {
  return (
    s
      .normalize('NFD')
      // U+0300..U+036F only: the Latin combining block. Devanagari marks live at U+0900..U+097F
      // and must survive.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function hasDevanagari(s: string): boolean {
  return /[ऀ-ॿ]/.test(s);
}

/** Whitespace-separated tokens of a normalised string. */
export function tokens(s: string): string[] {
  const n = normalise(s);
  return n === '' ? [] : n.split(' ');
}

/**
 * Damerau-Levenshtein distance, capped: returns `max + 1` as soon as it is certain the true
 * distance exceeds `max`, so a scan over a large index does not pay full O(n*m) per candidate.
 *
 * TRANSPOSITION MATTERS HERE. Plain Levenshtein charges 2 for swapped adjacent letters, which
 * is the single most common typing error, so a one-swap typo would fall outside a distance-1
 * budget and the fuzzy path would miss exactly the mistakes it exists to catch.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prevPrev = new Int32Array(m + 1);
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0] as number;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, (prevPrev[j - 2] as number) + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every later row is monotonically non-decreasing in this bound, so once the best cell in a
    // row exceeds the budget the answer cannot come back under it.
    if (rowMin > max) return max + 1;
    const spare = prevPrev;
    prevPrev = prev;
    prev = curr;
    curr = spare;
  }
  const d = prev[m] as number;
  return d > max ? max + 1 : d;
}
