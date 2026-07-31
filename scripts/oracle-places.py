"""
Independent oracle for the places index. Run via `npm run gate:oracle`, never on its own.

WHAT THIS IS AND IS NOT. It re-implements the same KEEP POLICY as `packages/pipeline/` using a
completely independent stack: libosmium's C++ PBF decoder instead of our hand-rolled protobuf
reader, Python tag handling instead of ours, and Python's own Unicode normalisation. So it can
catch a decoder bug, a coordinate bug, a dedupe bug, a tag-rule bug, or a name-selection bug.

It CANNOT validate the policy itself. If the rule "a way is kept when any member node is in the
build area" is the wrong rule, both implementations are wrong together. An oracle checks
execution, not intent, and pretending otherwise is how a green cross-validation hides a design
error.

It reads the RAW extracts, not `data/clipped.osm.pbf`. Reading our own clip output would make
the clip stage unfalsifiable: anything the clip wrongly dropped would be invisible to a checker
that starts from the clip.

The extracts are processed in the SAME ORDER as the pipeline, because the keep decision is
order-dependent: relations are resolved against the node and way sets accumulated so far, so a
relation in the first file whose ways live only in the second is dropped. That is a property of
the pipeline being mirrored deliberately, not an accident of this script.

Emits JSON on stdout. Every id set is emitted in full, so the comparison is set difference
rather than a count match: two counts can agree while naming different elements.
"""
import json
import re
import sys
import unicodedata

import osmium

# Mirrors config/city.ts BUILD_AREA, passed in rather than hard-coded so there is still exactly
# one definition of the city. Scaled to 1e7 integers because the pipeline compares scaled
# integers, and a float comparison disagrees at the boundary: node 9942251826 sits 1 ULP above
# maxLat and that is the difference between keeping and dropping it.
COORD_SCALE = 10_000_000

PLACE_RANK = {
    'city': 100, 'town': 90, 'suburb': 80, 'village': 72, 'quarter': 66,
    'neighbourhood': 62, 'hamlet': 55, 'locality': 50, 'isolated_dwelling': 40,
}
MAJOR_POI = {
    'hospital': 48, 'university': 47, 'college': 44, 'bus_station': 44, 'railway_station': 46,
    'airport': 49, 'aerodrome': 49, 'marketplace': 42, 'townhall': 42, 'police': 40,
    'fire_station': 40, 'stadium': 41, 'mall': 43,
}
ROAD_RANK = {
    'motorway': 34, 'trunk': 32, 'primary': 30, 'secondary': 26, 'tertiary': 22,
    'unclassified': 16, 'residential': 14, 'living_street': 12, 'service': 8, 'road': 14,
    'motorway_link': 18, 'trunk_link': 17, 'primary_link': 16, 'secondary_link': 15,
    'tertiary_link': 14,
}

_LATIN_MARKS = re.compile(r'[̀-ͯ]')
_NON_ALNUM = re.compile(r'[^\w\s]', re.UNICODE)
_SPACES = re.compile(r'\s+')
_DEVANAGARI = re.compile(r'[ऀ-ॿ]')


def normalise(s):
    """Mirrors shared/text.ts normalise. Strips Latin combining marks ONLY; Devanagari marks
    live at U+0900 and must survive, which is why the range is not `all combining marks`."""
    d = unicodedata.normalize('NFD', s)
    d = _LATIN_MARKS.sub('', d)
    d = d.lower()
    # `\w` in Python includes underscore, which the JS `[^\p{L}\p{N}\s]` class does not, so
    # underscore is removed explicitly rather than relying on the class.
    d = d.replace('_', ' ')
    d = _NON_ALNUM.sub(' ', d)
    return _SPACES.sub(' ', d).strip()


def name_of(tags):
    """Mirrors places/build.ts nameOf: local name first, English fallback, whitespace collapsed.
    Real names in this extract contain embedded newlines, so collapsing is not cosmetic."""
    for key in ('name', 'name:en'):
        v = tags.get(key)
        if v is None:
            continue
        c = _SPACES.sub(' ', v).strip()
        if c != '':
            return c
    return None


def kind_of(tags):
    """Mirrors places/build.ts kindOf, in the same order. Order matters: an element tagged both
    `place` and `amenity` must resolve the same way in both implementations."""
    place = tags.get('place')
    if place is not None and place in PLACE_RANK:
        return ('place', place, PLACE_RANK[place])
    railway = tags.get('railway')
    if railway in ('station', 'halt'):
        return ('railway', railway, MAJOR_POI['railway_station'])
    amenity = tags.get('amenity')
    if amenity is not None:
        return ('amenity', amenity, MAJOR_POI.get(amenity, 30))
    shop = tags.get('shop')
    if shop is not None:
        return ('shop', shop, 26)
    tourism = tags.get('tourism')
    if tourism is not None:
        return ('tourism', tourism, 28)
    leisure = tags.get('leisure')
    if leisure is not None:
        return ('leisure', leisure, 24)
    office = tags.get('office')
    if office is not None:
        return ('office', office, 22)
    if tags.get('aeroway') == 'aerodrome':
        return ('amenity', 'aerodrome', 49)
    return None


def keep_relation(tags):
    """Mirrors clip.ts keepRelation."""
    t = tags.get('type')
    return t in ('restriction', 'multipolygon', 'boundary') or 'name' in tags


class Collector:
    """Driven by `osmium.FileProcessor`, NOT by `osmium.SimpleHandler`.

    MEASURED, both on this machine: FileProcessor sustains about 104,000 objects per second.
    A SimpleHandler version of this same script took 2,877 s for the 91.5M-object raw pair,
    about 32,000 per second, so roughly a third the speed. It ALSO failed to finish the 13.8 MB
    clipped file inside a 300 s limit, which those rates say it should have cleared in about 70 s.
    That discrepancy is NOT diagnosed and is not claimed to be understood; the switch was made
    because the faster API is also the supported one and allows progress reporting.

    Progress goes to stderr on purpose: a silent long job and a hung one look identical from the
    outside, and the first run of this script was misread as hung for exactly that reason.
    """

    def __init__(self, area):
        self.min_lat, self.max_lat, self.min_lon, self.max_lon = area
        self.in_area_nodes = set()
        self.way_ids_seen = set()
        self.rel_ids_seen = set()
        self.node_places = {}
        self.way_places = {}
        self.rel_places = {}
        self.road_ways = {}
        self.dup_nodes = 0
        self.dup_ways = 0
        self.dup_rels = 0
        self.nodes_read = 0
        self.ways_read = 0
        self.rels_read = 0

    def run(self, path):
        """One pass, in file order. PBF is sorted node then way then relation, so the node id set
        is complete before the first way is seen and the way id set before the first relation,
        which is the same ordering the pipeline relies on."""
        for o in osmium.FileProcessor(path):
            t = o.type_str()
            if t == 'n':
                self.node(o)
            elif t == 'w':
                self.way(o)
            elif t == 'r':
                self.relation(o)
            total = self.nodes_read + self.ways_read + self.rels_read
            if total % 2_000_000 == 0:
                print(
                    f'  oracle {path}: {total:,} objects '
                    f'({self.nodes_read:,}n {self.ways_read:,}w {self.rels_read:,}r)',
                    file=sys.stderr, flush=True,
                )

    def node(self, n):
        self.nodes_read += 1
        # `.x` and `.y` are libosmium's own 1e7-scaled integers, so this is an integer comparison
        # on both sides rather than a float one that disagrees at the boundary.
        lat_s, lon_s = n.location.y, n.location.x
        if not (self.min_lat <= lat_s <= self.max_lat and self.min_lon <= lon_s <= self.max_lon):
            return
        if n.id in self.in_area_nodes:
            self.dup_nodes += 1
            return
        self.in_area_nodes.add(n.id)
        tags = {t.k: t.v for t in n.tags}
        name = name_of(tags)
        if name is None:
            return
        k = kind_of(tags)
        if k is None:
            return
        self.node_places[n.id] = {
            'name': name, 'kind': k[0], 'category': k[1], 'importance': k[2],
            'lat': lat_s / COORD_SCALE, 'lon': lon_s / COORD_SCALE,
        }

    def way(self, w):
        self.ways_read += 1
        refs = [nd.ref for nd in w.nodes]
        if not any(r in self.in_area_nodes for r in refs):
            return
        if w.id in self.way_ids_seen:
            self.dup_ways += 1
            return
        self.way_ids_seen.add(w.id)
        tags = {t.k: t.v for t in w.tags}
        name = name_of(tags)
        if name is None:
            return
        highway = tags.get('highway')
        if highway is not None and highway in ROAD_RANK:
            self.road_ways[w.id] = {'name': name, 'normalised': normalise(name), 'category': highway}
            return
        k = kind_of(tags)
        if k is None:
            return
        self.way_places[w.id] = {'name': name, 'kind': k[0], 'category': k[1], 'importance': k[2]}

    def relation(self, r):
        self.rels_read += 1
        tags = {t.k: t.v for t in r.tags}
        if not keep_relation(tags):
            return
        touches = False
        for m in r.members:
            if m.type == 'w' and m.ref in self.way_ids_seen:
                touches = True
                break
            if m.type == 'n' and m.ref in self.in_area_nodes:
                touches = True
                break
        if not touches:
            return
        if r.id in self.rel_ids_seen:
            self.dup_rels += 1
            return
        self.rel_ids_seen.add(r.id)
        name = name_of(tags)
        if name is None:
            return
        k = kind_of(tags)
        if k is None:
            return
        self.rel_places[r.id] = {'name': name, 'kind': k[0], 'category': k[1], 'importance': k[2]}


def main():
    area = json.loads(sys.argv[1])
    paths = sys.argv[2:]
    c = Collector((
        round(area['minLat'] * COORD_SCALE), round(area['maxLat'] * COORD_SCALE),
        round(area['minLon'] * COORD_SCALE), round(area['maxLon'] * COORD_SCALE),
    ))
    for p in paths:
        # No location index. Node positions come from the node pass itself, and the way rule needs
        # node MEMBERSHIP rather than position, which the id set already answers. A location index
        # over 91.5M nodes would want gigabytes on a 7.7 GB machine.
        print(f'  oracle reading {p}', file=sys.stderr, flush=True)
        c.run(p)

    devanagari = sum(
        1 for d in list(c.node_places.values()) + list(c.way_places.values()) + list(c.rel_places.values())
        if _DEVANAGARI.search(d['name'])
    ) + sum(1 for d in c.road_ways.values() if _DEVANAGARI.search(d['name']))

    json.dump({
        'read': {'nodes': c.nodes_read, 'ways': c.ways_read, 'relations': c.rels_read},
        'duplicates': {'nodes': c.dup_nodes, 'ways': c.dup_ways, 'relations': c.dup_rels},
        'nodesInArea': len(c.in_area_nodes),
        'waysKept': len(c.way_ids_seen),
        'relationsKept': len(c.rel_ids_seen),
        'nodePlaces': {str(k): v for k, v in c.node_places.items()},
        'wayPlaces': {str(k): v for k, v in c.way_places.items()},
        'relPlaces': {str(k): v for k, v in c.rel_places.items()},
        'roadWays': {str(k): v for k, v in c.road_ways.items()},
        'distinctRoadNames': sorted({d['normalised'] for d in c.road_ways.values()}),
        'withDevanagariName': devanagari,
    }, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
