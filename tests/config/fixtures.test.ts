import { describe, it, expect } from 'vitest';
import {
  BUILD_AREA,
  RELATION_BBOX,
  BUFFER_KM,
  BOUNDARY_RELATION,
  EXTRACTS,
  SNAP_TRACKING_M,
  SNAP_DESTINATION_M,
} from '@config/city.ts';
import { ROUTING_FIXTURES } from '@config/fixtures/routing.ts';
import { SEARCH_FIXTURES, SEARCH_BUDGET_MS } from '@config/fixtures/search.ts';

const KM_PER_DEG_LAT = 111.32;

function inBuildArea(lat: number, lon: number): boolean {
  return (
    lat >= BUILD_AREA.minLat &&
    lat <= BUILD_AREA.maxLat &&
    lon >= BUILD_AREA.minLon &&
    lon <= BUILD_AREA.maxLon
  );
}

describe('BUILD_AREA is genuinely derived, not hand-written', () => {
  it('equals RELATION_BBOX buffered by BUFFER_KM', () => {
    const dLat = BUFFER_KM / KM_PER_DEG_LAT;
    const midLat = (RELATION_BBOX.minLat + RELATION_BBOX.maxLat) / 2;
    const dLon = BUFFER_KM / (KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180));

    // 1e-5 deg is about 1 m. Tight enough to catch a hand edit, loose enough for rounding.
    expect(BUILD_AREA.minLat).toBeCloseTo(RELATION_BBOX.minLat - dLat, 5);
    expect(BUILD_AREA.maxLat).toBeCloseTo(RELATION_BBOX.maxLat + dLat, 5);
    expect(BUILD_AREA.minLon).toBeCloseTo(RELATION_BBOX.minLon - dLon, 5);
    expect(BUILD_AREA.maxLon).toBeCloseTo(RELATION_BBOX.maxLon + dLon, 5);
  });

  it('carries provenance for the relation it came from', () => {
    expect(BOUNDARY_RELATION.id).toBe(1958053);
    expect(BOUNDARY_RELATION.adminLevel).toBe(5);
    expect(BOUNDARY_RELATION.fetchedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is a non-degenerate box', () => {
    expect(BUILD_AREA.maxLat).toBeGreaterThan(BUILD_AREA.minLat);
    expect(BUILD_AREA.maxLon).toBeGreaterThan(BUILD_AREA.minLon);
  });
});

describe('snap radii are distinct and correctly ordered', () => {
  it('tracking is far tighter than destination', () => {
    expect(SNAP_TRACKING_M).toBeLessThan(SNAP_DESTINATION_M);
  });

  it('tracking stays tight enough to catch a wrong match', () => {
    // A fix matched more than ~50 m from any road is a matcher bug, not a driver in a
    // field. If this ever needs raising, the matcher is what should change.
    expect(SNAP_TRACKING_M).toBeLessThanOrEqual(50);
  });
});

describe('routing fixtures', () => {
  it('all lie inside BUILD_AREA', () => {
    for (const f of ROUTING_FIXTURES) {
      expect(inBuildArea(f.lat, f.lon), `${f.id} outside build area`).toBe(true);
    }
  });

  it('have unique ids', () => {
    const ids = ROUTING_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each state the class of bug they catch, and their provenance', () => {
    for (const f of ROUTING_FIXTURES) {
      expect(f.covers.length, `${f.id} has no covers`).toBeGreaterThan(20);
      expect(f.source.length, `${f.id} has no source`).toBeGreaterThan(10);
    }
  });

  it('retain the two fixtures that exist to catch specific classes of bug', () => {
    const ids = ROUTING_FIXTURES.map((f) => f.id);
    // gaur-city is the permanent charter item 3 wrong-side site.
    expect(ids).toContain('gaur-city');
    // gautam-buddha-university is the access-rule case, not an exception.
    expect(ids).toContain('gautam-buddha-university');
  });

  it('keep dadri between the two radii, which is the point of that fixture', () => {
    const dadri = ROUTING_FIXTURES.find((f) => f.id === 'dadri');
    expect(dadri).toBeDefined();
    // Its asserts must name both radii, so the intent survives a careless edit.
    const text = (dadri?.asserts ?? []).join(' ');
    expect(text).toContain('SNAP_DESTINATION_M');
    expect(text).toContain('SNAP_TRACKING_M');
  });
});

describe('search fixtures', () => {
  it('all reference a point inside BUILD_AREA', () => {
    for (const f of SEARCH_FIXTURES) {
      expect(inBuildArea(f.nearLat, f.nearLon), `${f.query} outside build area`).toBe(true);
    }
  });

  it('have unique queries', () => {
    const qs = SEARCH_FIXTURES.map((f) => f.query);
    expect(new Set(qs).size).toBe(qs.length);
  });

  it('each record what OSM actually holds, and expect a kind rather than a string', () => {
    for (const f of SEARCH_FIXTURES) {
      expect(f.osmReality.length, `${f.query} has no osmReality`).toBeGreaterThan(20);
      expect(f.expectKind.length, `${f.query} expects no kind`).toBeGreaterThan(0);
      expect(f.expectWithinM, `${f.query} has no radius`).toBeGreaterThan(0);
    }
  });

  it('keep the Kasna fuzzy case, spelled as a person would type it', () => {
    const kasna = SEARCH_FIXTURES.find((f) => f.query === 'Kasna');
    expect(kasna, 'the Kasna fixture was removed').toBeDefined();
    // Typed "Kasna" vs mapped "Kasana": one inserted character. If someone "fixes" the
    // query to match OSM spelling, the fuzzy path stops being tested at all.
    expect(kasna?.query).toBe('Kasna');
    expect(kasna?.osmReality).toContain('Kasana');
    expect(kasna?.expectKind).toContain('highway');
  });

  it('hold the search budget at the spec target', () => {
    expect(SEARCH_BUDGET_MS).toBeLessThanOrEqual(5);
  });
});

describe('extract sources', () => {
  it('name both zones, because one fails the coverage gate', () => {
    const names = EXTRACTS.map((e) => e.name);
    expect(names).toContain('central-zone');
    expect(names).toContain('northern-zone');
  });

  it('carry a poly url for the coverage gate and an md5 for provenance', () => {
    for (const e of EXTRACTS) {
      expect(e.url).toMatch(/^https:\/\/.+\.osm\.pbf$/);
      expect(e.polyUrl).toMatch(/^https:\/\/.+\.poly$/);
      expect(e.observedMd5).toMatch(/^[0-9a-f]{32}$/);
      expect(e.observedBytes).toBeGreaterThan(1_000_000);
    }
  });
});
