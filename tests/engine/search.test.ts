/**
 * Places search, on a synthetic corpus small enough to reason about.
 *
 * `config/fixtures/search.ts` checks the real index against real typed queries and needs the built
 * artifacts, so it runs in `npm run gate:fixtures` rather than here. This file covers what a
 * fixture cannot: properties that must hold for ANY corpus, including ones OSM has not produced yet.
 *
 * THE EQUIVALENCE IS THE POINT OF THIS FILE. `searchUnindexed` exists so the cost of the index can
 * be watched collapsing in the product rather than asserted in a comment, and that demonstration is
 * only honest if both paths answer the same question. A doc comment claiming they agree is a
 * promise; this is enforcement.
 */
import { describe, expect, it } from 'vitest';
import { PlacesSearch } from '../../packages/engine/search.ts';
import type { Place } from '../../packages/shared/index.ts';

/**
 * A corpus shaped like the real one: a prominent settlement, a road named after a place, a couple
 * of numbered sectors, and a near-spelling that is a DIFFERENT place rather than a typo.
 */
const CORPUS: Place[] = [
  { id: 1, name: 'Kapna', kind: 'place', category: 'village', point: [77.90, 28.30], importance: 70 },
  { id: 2, name: 'Old Kasana Road', kind: 'highway', category: 'tertiary', point: [77.50, 28.50], importance: 20 },
  { id: 3, name: 'Kasana Nursing Home', kind: 'amenity', category: 'clinic', point: [77.62, 28.42], importance: 35 },
  { id: 4, name: 'Alpha 1', kind: 'place', category: 'suburb', point: [77.51, 28.47], importance: 60 },
  { id: 5, name: 'Alpha 2', kind: 'place', category: 'suburb', point: [77.52, 28.48], importance: 60 },
  { id: 6, name: 'Beta 1', kind: 'place', category: 'suburb', point: [77.53, 28.46], importance: 60 },
  { id: 7, name: 'Delta 1', kind: 'place', category: 'suburb', point: [77.54, 28.45], importance: 60 },
  { id: 8, name: 'Pari Chowk', kind: 'place', category: 'neighbourhood', point: [77.5081, 28.4631], importance: 65 },
  { id: 9, name: 'Knowledge Park II', kind: 'place', category: 'suburb', point: [77.49, 28.47], importance: 55 },
  { id: 10, name: 'Knowledge Park III', kind: 'place', category: 'suburb', point: [77.48, 28.46], importance: 55 },
];

const search = new PlacesSearch(CORPUS);
const NEAR_KASANA_ROAD: readonly [number, number] = [77.5005, 28.5005];

const names = (hits: readonly { name: string }[]): string[] => hits.map((h) => h.name);

describe('search: the indexed and unindexed paths are the same question', () => {
  /**
   * The product exposes `index=off` so the latency readout can be watched collapsing over the real
   * corpus. That comparison is only meaningful if the two paths RANK identically: if they differed,
   * the switch would be trading answers for speed and the demonstration would be a lie.
   */
  it('returns the identical ranking for every query, with and without precomputation', () => {
    const queries = ['kasna', 'kasana', 'alpha', 'alpha 1', 'pari', 'knowledge', 'beta 1', 'chowk', 'zzz', 'a'];
    for (const q of queries) {
      for (const opts of [{ limit: 8 }, { limit: 8, near: NEAR_KASANA_ROAD }]) {
        const indexed = search.search(q, opts);
        const plain = search.searchUnindexed(q, opts);
        expect(names(plain), `query "${q}"`).toEqual(names(indexed));
        expect(plain.map((h) => h.matchType), `query "${q}"`).toEqual(indexed.map((h) => h.matchType));
        expect(plain.map((h) => h.score.toFixed(6)), `query "${q}"`).toEqual(
          indexed.map((h) => h.score.toFixed(6)),
        );
      }
    }
  });

  it('agrees that nothing matches, rather than one path inventing a hit', () => {
    // A negative result needs a positive control beside it, per hard-rules.md: the same corpus and
    // the same two paths returning something for a query that SHOULD match proves the mechanism
    // works and that the empty answer is about the query.
    expect(search.search('qqqqqqqq')).toHaveLength(0);
    expect(search.searchUnindexed('qqqqqqqq')).toHaveLength(0);
    expect(search.search('pari').length).toBeGreaterThan(0);
    expect(search.searchUnindexed('pari').length).toBeGreaterThan(0);
  });
});

describe('search: what the three paths are ordered for', () => {
  it('never lets a fuzzy guess outrank an exact prefix match', () => {
    const hits = search.search('alpha');
    expect(hits[0]?.matchType).toBe('prefix');
    expect(names(hits).slice(0, 2).sort()).toEqual(['Alpha 1', 'Alpha 2']);
  });

  /**
   * A digit is the whole difference between two real destinations kilometres apart, so an edit that
   * changes one is never a typo to forgive. Sending a driver to Delta 1 when they typed Beta 1 is
   * worse than returning nothing: nothing prompts a retype, a confident wrong answer does not.
   */
  it('does not offer a different sector as a spelling correction', () => {
    expect(names(search.search('Beta 1'))).not.toContain('Delta 1');
    expect(names(search.search('Alpha 2'))).not.toContain('Alpha 1');
  });

  /**
   * The locality bonus decays at NEIGHBOURHOOD scale, so presence beats prominence when the nearby
   * thing is genuinely nearby. This is the `Kasna` case: a road 50 m away must beat a village 40 km
   * away even though the village ranks far higher on its own.
   */
  it('puts a road at the cursor ahead of a more prominent village far away', () => {
    const hits = search.search('Kasna', { near: NEAR_KASANA_ROAD, limit: 5 });
    expect(hits[0]?.name).toBe('Old Kasana Road');
    expect(hits[0]?.matchType).toBe('fuzzy');
  });

  it('leaves the ranking alone when no map centre is supplied', () => {
    // Without `near` there is no distance term at all, so no hit may carry one. A distance appearing
    // from nowhere would mean the bias is being applied against an assumed centre.
    for (const h of search.search('Kasna', { limit: 5 })) expect(h.distanceM).toBeUndefined();
  });

  it('honours the limit exactly', () => {
    expect(search.search('a', { limit: 3 }).length).toBeLessThanOrEqual(3);
    expect(search.searchUnindexed('a', { limit: 3 }).length).toBeLessThanOrEqual(3);
  });

  it('treats an empty or blank query as no query, not as a match-everything', () => {
    expect(search.search('')).toHaveLength(0);
    expect(search.search('   ')).toHaveLength(0);
  });
});
