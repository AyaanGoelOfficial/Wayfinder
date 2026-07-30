/**
 * The places index: the third derivative, built from the same clipped bytes as the graph and
 * the tiles.
 *
 * WHAT GOES IN: anything a person would type into a search box and expect to travel to.
 * Settlements and localities, major POIs, and NAMED ROADS. Roads matter more here than they
 * do in a generic gazetteer, because in Greater Noida people navigate by road and sector name
 * far more than by POI, and because the Kasna fixture depends on it: "Kasna" exists in OSM only
 * as `Old Kasana Road` and `Kasana Nursing Home`, so a places index that indexes settlements
 * only would return nothing for a real locality that people use daily.
 *
 * ONE ROAD IS ONE PLACE. OSM splits a road into many ways wherever a tag changes, so
 * `Old Kasana Road` is several ways. Emitting one hit per way would flood the result list with
 * near-identical entries and bury everything else. Ways sharing a normalised name are clustered
 * by proximity, so two unrelated "Main Road"s in different towns stay separate while one road
 * split into eleven ways becomes one place.
 *
 * IMPORTANCE IS NOT POPULARITY. There is no click data and never will be, so ranking is
 * structural: settlement rank first, then POI significance, then road class. It is stated in
 * one table rather than tuned per query.
 */
import { haversineM } from '../../shared/geo.ts';
import { hasDevanagari, normalise } from '../../shared/text.ts';
import type { Clipped } from '../clip/clip.ts';
import type { Place, PlaceKind } from '../../shared/index.ts';

const COORD_SCALE = 1e7;

/**
 * Settlement ranks. A city must outrank a neighbourhood of the same name, or searching a
 * district capital returns a suburb three towns away.
 */
const PLACE_RANK: Readonly<Record<string, number>> = {
  city: 100, town: 90, suburb: 80, village: 72, quarter: 66,
  neighbourhood: 62, hamlet: 55, locality: 50, isolated_dwelling: 40,
};

/** POIs people actually navigate to. Everything else lands on the generic amenity rank. */
const MAJOR_POI: Readonly<Record<string, number>> = {
  hospital: 48, university: 47, college: 44, bus_station: 44, railway_station: 46,
  airport: 49, aerodrome: 49, marketplace: 42, townhall: 42, police: 40, fire_station: 40,
  stadium: 41, mall: 43,
};

/** Named roads, by class. A trunk road named X should outrank a service road named X. */
const ROAD_RANK: Readonly<Record<string, number>> = {
  motorway: 34, trunk: 32, primary: 30, secondary: 26, tertiary: 22,
  unclassified: 16, residential: 14, living_street: 12, service: 8, road: 14,
  motorway_link: 18, trunk_link: 17, primary_link: 16, secondary_link: 15, tertiary_link: 14,
};

/** Two ways with the same name further apart than this are different roads, not one. */
const ROAD_CLUSTER_RADIUS_M = 6_000;

export interface PlacesStats {
  readonly total: number;
  readonly fromNodes: number;
  readonly fromWays: number;
  readonly fromRelations: number;
  readonly namedRoads: number;
  readonly roadWaysCollapsed: number;
  readonly settlements: number;
  readonly pois: number;
  readonly withDevanagariName: number;
  readonly distinctNormalisedNames: number;
  readonly buildSeconds: number;
}

export interface PlacesIndex {
  readonly places: readonly Place[];
  readonly stats: PlacesStats;
}

function kindOf(tags: ReadonlyMap<string, string>): { kind: PlaceKind; category: string; rank: number } | null {
  const place = tags.get('place');
  if (place !== undefined && PLACE_RANK[place] !== undefined) {
    return { kind: 'place', category: place, rank: PLACE_RANK[place] as number };
  }
  const railway = tags.get('railway');
  if (railway === 'station' || railway === 'halt') {
    return { kind: 'railway', category: railway, rank: MAJOR_POI['railway_station'] as number };
  }
  const amenity = tags.get('amenity');
  if (amenity !== undefined) {
    return { kind: 'amenity', category: amenity, rank: MAJOR_POI[amenity] ?? 30 };
  }
  const shop = tags.get('shop');
  if (shop !== undefined) return { kind: 'shop', category: shop, rank: 26 };
  const tourism = tags.get('tourism');
  if (tourism !== undefined) return { kind: 'tourism', category: tourism, rank: 28 };
  const leisure = tags.get('leisure');
  if (leisure !== undefined) return { kind: 'leisure', category: leisure, rank: 24 };
  const office = tags.get('office');
  if (office !== undefined) return { kind: 'office', category: office, rank: 22 };
  const aeroway = tags.get('aeroway');
  if (aeroway === 'aerodrome') return { kind: 'amenity', category: 'aerodrome', rank: 49 };
  return null;
}

/** Prefers the local name; falls back to English. Never invents one. */
function nameOf(tags: ReadonlyMap<string, string>): string | undefined {
  const n = tags.get('name');
  if (n !== undefined && n.trim() !== '') return n.trim();
  const en = tags.get('name:en');
  if (en !== undefined && en.trim() !== '') return en.trim();
  return undefined;
}

interface RoadCluster {
  readonly name: string;
  readonly normalised: string;
  readonly category: string;
  rank: number;
  sumLat: number;
  sumLon: number;
  count: number;
  wayIds: number[];
}

export function buildPlaces(clipped: Clipped): PlacesIndex {
  const t0 = performance.now();
  const places: Place[] = [];
  let fromNodes = 0;
  let fromWays = 0;
  let fromRelations = 0;
  let pois = 0;
  let settlements = 0;

  const latOf = (idx: number): number => (clipped.nodeLat[idx] as number) / COORD_SCALE;
  const lonOf = (idx: number): number => (clipped.nodeLon[idx] as number) / COORD_SCALE;

  // ---- Nodes ----
  for (const [nodeId, tags] of clipped.nodeTags) {
    const name = nameOf(tags);
    if (name === undefined) continue;
    const k = kindOf(tags);
    if (k === null) continue;
    const idx = clipped.nodeIndex.get(nodeId);
    if (idx < 0) continue;
    places.push({
      id: nodeId,
      name,
      kind: k.kind,
      category: k.category,
      point: [lonOf(idx), latOf(idx)],
      importance: k.rank,
    });
    fromNodes++;
    if (k.kind === 'place') settlements++;
    else pois++;
  }

  // ---- Ways: named roads get clustered, named areas become single places ----
  const roadClusters = new Map<string, RoadCluster[]>();
  let roadWaysSeen = 0;

  for (const way of clipped.ways) {
    const name = nameOf(way.tags);
    if (name === undefined) continue;

    // Representative point: the way's midpoint by vertex count, which for a road is a point ON
    // the road. A bounding-box centre would sit off the carriageway on any curved road.
    let sumLat = 0;
    let sumLon = 0;
    let n = 0;
    for (const ref of way.refs) {
      const i = clipped.nodeIndex.get(ref);
      if (i < 0) continue;
      sumLat += latOf(i);
      sumLon += lonOf(i);
      n++;
    }
    if (n === 0) continue;
    const lat = sumLat / n;
    const lon = sumLon / n;

    const highway = way.tags.get('highway');
    if (highway !== undefined && ROAD_RANK[highway] !== undefined) {
      roadWaysSeen++;
      const norm = normalise(name);
      const list = roadClusters.get(norm) ?? [];
      // Same name within ROAD_CLUSTER_RADIUS_M is the same road split into several OSM ways.
      // Beyond it, two roads genuinely share a name, which is common for "Main Road".
      let joined = false;
      for (const c of list) {
        if (haversineM(c.sumLat / c.count, c.sumLon / c.count, lat, lon) <= ROAD_CLUSTER_RADIUS_M) {
          c.sumLat += lat;
          c.sumLon += lon;
          c.count++;
          c.wayIds.push(way.id);
          c.rank = Math.max(c.rank, ROAD_RANK[highway] as number);
          joined = true;
          break;
        }
      }
      if (!joined) {
        list.push({
          name, normalised: norm, category: highway,
          rank: ROAD_RANK[highway] as number,
          sumLat: lat, sumLon: lon, count: 1, wayIds: [way.id],
        });
      }
      roadClusters.set(norm, list);
      continue;
    }

    const k = kindOf(way.tags);
    if (k === null) continue;
    places.push({
      id: way.id,
      name,
      kind: k.kind,
      category: k.category,
      point: [lon, lat],
      importance: k.rank,
    });
    fromWays++;
    if (k.kind === 'place') settlements++;
    else pois++;
  }

  let namedRoads = 0;
  for (const list of roadClusters.values()) {
    for (const c of list) {
      places.push({
        // The first way id identifies the cluster. Stable across rebuilds for the same data.
        id: c.wayIds[0] as number,
        name: c.name,
        kind: 'highway',
        category: c.category,
        point: [c.sumLon / c.count, c.sumLat / c.count],
        importance: c.rank,
      });
      namedRoads++;
    }
  }

  // ---- Relations: named multipolygons and boundaries ----
  for (const rel of clipped.relations) {
    const name = nameOf(rel.tags);
    if (name === undefined) continue;
    const k = kindOf(rel.tags);
    if (k === null) continue;
    // A relation's geometry is not assembled here, so its point comes from the mean of its
    // member nodes that the clip holds. Coarse, and honest about being coarse: it is only used
    // to place a label and to rank by distance, never to route to.
    let sumLat = 0;
    let sumLon = 0;
    let n = 0;
    for (const m of rel.members) {
      if (m.type !== 'node') continue;
      const i = clipped.nodeIndex.get(m.ref);
      if (i < 0) continue;
      sumLat += latOf(i);
      sumLon += lonOf(i);
      n++;
    }
    if (n === 0) continue;
    places.push({
      id: rel.id,
      name,
      kind: k.kind,
      category: k.category,
      point: [sumLon / n, sumLat / n],
      importance: k.rank,
    });
    fromRelations++;
    if (k.kind === 'place') settlements++;
    else pois++;
  }

  places.sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name));

  const names = new Set<string>();
  let withDevanagariName = 0;
  for (const p of places) {
    names.add(normalise(p.name));
    if (hasDevanagari(p.name)) withDevanagariName++;
  }

  return {
    places,
    stats: {
      total: places.length,
      fromNodes,
      fromWays,
      fromRelations,
      namedRoads,
      roadWaysCollapsed: roadWaysSeen - namedRoads,
      settlements,
      pois,
      withDevanagariName,
      distinctNormalisedNames: names.size,
      buildSeconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
    },
  };
}
