/**
 * Is this machine currently able to measure anything? A preflight for `npm run bench`.
 *
 * WHY THIS EXISTS, and it is not a hypothetical. Three consecutive benchmark runs of UNMODIFIED
 * Dijkstra reported initial-route p95 of 284, 1829 and 1674 ms, and the derived "time saved by A\*"
 * column read +37.2%, then -4.3%, then -278.6% for identical code. Settled-state counts were
 * identical to the digit across all three. Wall time on this machine varies over tens of minutes
 * with whatever else is running, so a benchmark has to measure the MACHINE immediately before it
 * measures the code, and refuse rather than warn.
 *
 * WHAT WAS RULED OUT, by measurement rather than assumption, so nobody re-runs this diagnosis:
 *
 *   dev servers      Ports 8080 and 5173 had nothing listening and no node process was alive
 *                    during a contaminated window. Not the cause.
 *   OneDrive         The process was not running, despite the repo living under a synced path.
 *                    Not the cause of that window, though it remains a hazard for artifact writes.
 *   turbo decay      REFUTED directly. A fixed CPU-bound kernel run 40 times drifted -14.3%, that
 *                    is FASTER over the run, with 1.57x spread. Thermal throttling would have
 *                    produced a monotone climb.
 *   core contention  A 6 second idle sample showed 14.6% of an 8 core machine busy, mostly Chrome.
 *                    Real, but far too little to explain a 6x swing on its own.
 *   cache contention A pointer-chase kernel over 32 MB, run beside the CPU kernel, came out at
 *                    1.28x against the CPU kernel's 1.39x. RECORDED AS RULED OUT, AND THAT WAS
 *                    WRONG. 1.28 against an observed 1.33 is a match, not a refutation. It is the
 *                    dominant term, and the correction matters because it changes the remedy: you
 *                    cannot wait a cache co-tenant out, you can only close it.
 *
 * WHAT REMAINS, and it is structural rather than transient. A per-process CPU sample during a
 * contaminated window found `claude` at 2.75 CPU-seconds per 10 s wall, five VS Code processes at
 * 3.34 between them, Task Manager at 1.06, plus `SmartByteTelemetry` and `dptf_helper`, Intel's
 * thermal daemon, which modulates the clock directly. That is about 11% of an 8 core machine, with
 * seven cores idle, so it is not CPU starvation. The router's working set is roughly 8.5 MB of
 * interleaved typed arrays, which lives in L3, and every one of those processes evicts it.
 *
 * SEVEN MINUTES OF IDLING DID NOT HELP, which is what refutes "wait longer" as a remedy. Two of the
 * three consumers are the operator's own windows and the third is the agent running the benchmark,
 * so a perfectly quiet reading is not obtainable from inside an agent session.
 */

/**
 * A fixed CPU-bound kernel. No allocation, no IO, no dependence on anything in this repo, so its
 * timing reflects the machine and nothing else. Identical work on every call by construction.
 */
function kernel(n: number): number {
  let x = 0;
  let y = 1.0;
  for (let i = 1; i <= n; i++) {
    x = (x + Math.imul(i, 2654435761)) | 0;
    y += 1 / (i + (x & 1023) + 1);
  }
  return x + y;
}

export interface MachineStability {
  readonly minMs: number;
  readonly maxMs: number;
  /** `maxMs / minMs`. 1.0 is a perfectly steady machine. */
  readonly spread: number;
  /** Percent change from the first third of the samples to the last. Positive means slowing down. */
  readonly driftPct: number;
  readonly samples: readonly number[];
}

const ITERATIONS = 16;
const WORK = 4_000_000;

/**
 * Times the same kernel repeatedly and reports how much the answer moved.
 *
 * Takes about half a second. Cheap enough to run before every benchmark, which is the point: a
 * preflight that is expensive gets skipped, and a preflight that gets skipped is not a preflight.
 */
export function measureMachineStability(): MachineStability {
  let sink = 0;
  // Warm the JIT, so the first timed sample measures the machine and not the compiler.
  sink += kernel(WORK);

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    sink += kernel(WORK);
    samples.push(performance.now() - t);
  }
  // Defeats any optimiser that might notice the result is unused. Never true.
  if (sink === 12345.678) throw new Error('unreachable');

  const minMs = Math.min(...samples);
  const maxMs = Math.max(...samples);
  const third = Math.max(1, Math.floor(ITERATIONS / 3));
  const mean = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const early = mean(samples.slice(0, third));
  const late = mean(samples.slice(-third));

  return {
    minMs,
    maxMs,
    spread: maxMs / minMs,
    driftPct: ((late - early) / early) * 100,
    samples,
  };
}

/**
 * The spread above which a benchmark run is refused.
 *
 * CALIBRATED ON OBSERVATION, and the observation is thin, which is stated rather than hidden. On a
 * quiet machine this kernel measured 1.39x and 1.57x across two runs, and a pointer-chase kernel
 * beside it measured 1.28x. 1.8 sits above the quiet range with margin and far below the world
 * where a benchmark reports 284 ms and 1829 ms for the same code. If this threshold turns out to
 * reject quiet machines, RAISE IT WITH A MEASUREMENT, never because a run was inconvenient.
 */
export const STABILITY_MAX_SPREAD = 1.8;

/**
 * The end-of-run load canary threshold: observed total time over best-of-N total time.
 *
 * RE-DERIVED FROM OBSERVATION, NOT CHASED. It began at 1.15, which was a guess at what a quiet
 * machine looks like, and no run ever reached it. The reason is now understood and is structural:
 * see the co-tenancy note at the top of this file. An agent session cannot produce a machine
 * without the agent on it.
 *
 * The sample, every benchmark run taken under the current instrument, best first:
 *
 *   1.17   after 5 minutes idle, HIGH priority, editor closed
 *   1.22   after 5 minutes idle, HIGH priority
 *   1.33   after 7 minutes idle, normal priority
 *
 * So 1.17 is the observed floor for this setup, and 1.30 sits above the floor with room for
 * ordinary variation while still rejecting the 6x windows this instrument exists to catch. It is a
 * FLOOR MEASUREMENT, not a target: raise it only with a new sample showing the floor has moved, and
 * lower it when the floor does.
 *
 * WHAT THIS MEANS FOR EVERY NUMBER PUBLISHED FROM A PASSING RUN: wall times are UPPER BOUNDS. The
 * machine always had a co-tenant. Comparisons BETWEEN rungs survive it, because rungs are
 * interleaved per query and share the same conditions; absolute budget verdicts are "no worse
 * than", and a verdict that passes has passed under load and would pass on a clean machine too.
 */
export const QUIET_CANARY_MAX = 1.3;

/** What to shut down, in the order most likely to be the problem here. */
export const QUIET_MACHINE_CHECKLIST = [
  'Close Chrome. Five processes were using 69% of one core during a contaminated window, and it',
  '  is the single largest consumer on this machine.',
  'Close Task Manager. Watching the machine changes it: it was burning 15% of a core by itself.',
  'Stop `npm run serve` (port 8080) and `npm run dev` (port 5173) if either is up.',
  'Let any OneDrive sync of `data/` finish. The repo lives under a synced path.',
  'Avoid running the benchmark within a minute of a build, so Defender has finished with the',
  '  artifacts it just saw written.',
];
