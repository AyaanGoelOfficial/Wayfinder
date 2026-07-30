# packages/pipeline/clip — clip to BUILD_AREA, merge the two extracts, cache the result

Turns 572 MB across two overlapping extracts into one deduped in-area subset, and caches it
so no later pass re-pays the ~190 s decode. Everything downstream (graph, places, spot
checks) reads the cache, never the extracts.

- **TWO PASSES, and the second one is not optional.** A way is kept when ANY of its nodes is
  inside `BUILD_AREA`, and a kept way needs ALL its node coordinates including the ones just
  outside. Nodes precede ways in the file, so the outside-but-needed set is only knowable
  after the ways are read. Deleting pass 2 truncates every boundary-crossing road, which is
  exactly the severing the 3 km buffer exists to prevent, and it surfaces much later as a
  stranded SCC rather than as an error here.
- **Pass 2 stops at the first way, on purpose.** A type-sorted PBF puts all nodes first, so
  once a way appears the file has no more nodes to offer. Reading on would stream hundreds of
  MB for nothing. If a file is ever NOT type-sorted this breaks silently, which is why
  `probe-extract.ts` counts and reports out-of-order transitions.
- **DEDUPE IS FIRST-WRITE-WINS, BY ELEMENT ID, and the count is load-bearing.** The
  Central/Northern seam crosses the western edge of the area, so overlapping elements are
  guaranteed. `hard-rules.md`: **a duplicate count of zero is a bug, not a clean run.**
- **Duplicates are counted among KEPT elements, not across all 91.5M nodes.** Counting the
  latter needs an id set over both entire extracts, roughly 1.5 GB, to answer a question
  nothing downstream asks. The seam figure that matters is `seamOverlapNodes`: summed per-file
  in-area count minus the deduped union.
- **RELATIONS ARE FILTERED SPATIALLY, not only by tag.** A tag-only filter kept every named
  relation in BOTH entire zone extracts, so rivers in Punjab and towns in central India were
  loaded into a Gautam Buddha Nagar build and would have gone straight into the places index and
  its ranking. Relations come last in a type-sorted file, so by the time they are read the
  kept-way and in-area-node sets are complete and membership is decidable. A relation held
  together ONLY by nested relation members cannot be decided this way; those are dropped and
  counted as `nestedRelationMembers`, never silently swallowed.
- **The cache key is a hash of `BUILD_AREA` + both extract md5s + the format version.** That
  is what makes staleness impossible rather than merely unlikely. Bump
  `CLIP_FORMAT_VERSION` on any layout change; old caches then miss and rebuild instead of
  being misread.
- **A cache that fails to read is a rebuild, never an error.** `data/` is git-ignored and
  regenerable by definition, so a corrupt or foreign cache must never be able to fail a build.
- **Intern every string BEFORE writing the string table.** Interning lazily during
  serialization appends to a table that has already been written, so the cache references
  indices past its own table and fails to parse on the NEXT run, not this one. Guarded by an
  explicit check that throws.
- **`IdSet` / `IdMap` exist because `Set<number>` costs 50 to 80 bytes an entry in V8.** At a
  few million ids that is hundreds of MB of overhead for 8 bytes of key. Float64Array keys,
  linear probing, load factor held under 0.5. Id 0 is the empty sentinel and storing it throws.
- **Coordinates are stored as integers scaled by 1e7**, which is OSM's own precision, so this
  loses nothing real and halves the node arrays against float64.
- **`binio.ts` decodes varints with multiplication, never bit shifts.** Same reason as the PBF
  reader: `<<` and `>>>` are 32-bit in JS and OSM ids reach ~1.3e10.
- **Imports:** `config/`, `../pbf/`, Node built-ins. Never `engine/`, never `server/`.
