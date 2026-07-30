# tests/engine — routing correctness on toy graphs

The routing ladder is verified here against hand-built graphs of a handful of nodes. A failure
names the exact rule that broke, which a million-vertex graph never does.

- **EVERY RESTRICTION TEST NEEDS A POSITIVE CONTROL.** Route the same graph twice, once without
  the restriction and once with it, and require the answers to DIFFER. Asserting only that the
  restricted route avoids the banned turn is worthless alone: a router that never found that turn
  passes it trivially. The control proves the short illegal path exists and that the restriction
  is what removed it.
- **A blocked route is as wrong as an illegal one.** When a destination is legally reachable the
  long way round, a restriction test must assert BOTH that the banned manoeuvre is absent AND
  that a route was still returned. Enforcement that turns into "no route found" is a different
  bug wearing the same green tick.
- **Assert the banned TRIPLE, not the banned way.** A via-way restriction forbids one ordered
  sequence through the connector, not the connector itself. Asserting the connector is unused
  over-constrains the router and will fail on a legal crossing.
- **Toy graphs must be strongly connected**, or largest-SCC filtering silently deletes half the
  fixture and the test asserts against an empty graph.
- **Determinism is a requirement, not a nicety.** Equal-cost ties break on the lower edge index.
  Golden routes depend on it, so a test that routes twice and compares belongs here.
- **Imports:** `packages/engine/`, `packages/pipeline/` for graph construction, `config/`. Never
  the network, never `data/`.
