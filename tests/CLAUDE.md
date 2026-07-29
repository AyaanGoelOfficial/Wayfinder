# tests — cross-package suites; unit tests live beside their code

Split by intent, and the split matters:

- **`tests/`** holds suites that span packages or assert on built artifacts: fixture
  integrity, cross-algorithm equality, golden routes, the toy-graph legality suite.
- **`packages/**/*.test.ts`** holds unit tests that sit next to the code they cover.
  Both are picked up by `npm test`; see `vitest.config.ts`.

- **A test that needs `data/` must SKIP with a clear reason when the artifacts are absent,
  never fail.** A fresh clone has no extract, and a red suite that only means "you have not
  run build-city yet" trains everyone to ignore red. Say which command produces the input.
- **Never relax an assertion to make a suite green.** Radii, tolerances and thresholds in
  `config/` encode decisions with stated reasons. If a test fails, the code, the data, or
  the individual fixture is wrong. Changing the threshold is how a precision charter item
  quietly stops being enforced.
- **Cross-algorithm equality is exact, within 1e-6 on cost.** A*, bidirectional and any
  later rung must match plain Dijkstra per pair. A mismatch is release-blocking, never a
  rounding excuse.
- **Timing assertions must not be wall-clock flaky.** Assert on operation counts, settled
  nodes, or generous p95 budgets. This machine has 8 cores and 7.7 GB RAM; CI and a throttled
  browser do not.
- **Imports:** may reach `config/` and any package. Must never reach `tools/` or the network.
  A unit test that hits Overpass or OSRM is not a unit test.
