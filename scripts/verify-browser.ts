/**
 * THE BROWSER GATE. `npm run verify:browser`.
 *
 * Five GPS scenarios, console hygiene, network assertions and a throttled performance pass, driven
 * against the real running client and printed as one pass/fail table with each precision charter
 * item mapped to the check that covers it.
 *
 * NO PUPPETEER, NO NEW DEPENDENCY. It speaks the Chrome DevTools Protocol directly over the
 * WebSocket client built into Node 22 and later. That is consistent with a project that writes its
 * own router and its own tiles, and it keeps the gate honest: everything it asserts is something
 * it asked the browser for and read back.
 *
 * THE SCENARIOS ARE SCRIPTED, NOT SIMULATED, and that distinction is the whole reason this gate is
 * trustworthy. Fixes are pushed through `window.__tracking` with exact timestamps and the frame
 * clock is supplied by the gate, so a scenario is a pure function of its trace. Driving the real
 * simulator instead would assert against whatever the machine's timers did, and the gate 0
 * measurement is why that is unacceptable: under 4x CPU throttle a requested 100 ms interval fired
 * at 188, 315, 253 and 117 ms.
 *
 * EVERY NEGATIVE CLAIM CARRIES A POSITIVE CONTROL, per `hard-rules.md`. A scenario that asserts
 * "the matcher did not cross to the opposing carriageway" also proves the opposing carriageway was
 * reachable, because otherwise a matcher that can see only one road passes it trivially.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRACKING } from '../config/city.ts';
import { DIVIDED_ROADS, DRIVE_ROUTE } from '../config/fixtures/tracking.ts';

const CLIENT = process.env['CLIENT_URL'] ?? 'http://localhost:5173';
const SERVER = process.env['API_TARGET'] ?? 'http://localhost:8080';
const PORT = 9333;

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

interface Check {
  readonly scenario: string;
  readonly claim: string;
  /** Charter items this check covers. Empty when it is hygiene rather than a charter item. */
  readonly charter: readonly number[];
  /**
   * `null` means REPORTED WITHOUT A VERDICT: NOTE, a deliberate third state rather than a quiet
   * pass. It counts toward neither total.
   *
   * ⛔ A NOTE EXISTS ONLY WITH A POSITIVE ATTRIBUTION ARGUMENT, per `hard-rules.md` § Measurement:
   * specific evidence, produced by THIS run, that the cause is outside the code under test.
   * Run-to-run variance is never one, and "the machine was busy" is a hypothesis. That is why
   * `note()` is the only way to create one and why it refuses an empty argument.
   */
  readonly pass: boolean | null;
  readonly evidence: string;
  /** Present exactly when `pass` is null, and printed beside the number. */
  readonly attribution: string | null;
}
const checks: Check[] = [];
function record(
  scenario: string,
  claim: string,
  charter: readonly number[],
  pass: boolean,
  evidence: string,
): void {
  checks.push({ scenario, claim, charter, pass, evidence, attribution: null });
}
function note(
  scenario: string,
  claim: string,
  charter: readonly number[],
  evidence: string,
  attribution: string,
): void {
  if (attribution.trim() === '') {
    throw new Error(`A NOTE without an attribution argument is a gate defect: ${scenario}, ${claim}`);
  }
  checks.push({ scenario, claim, charter, pass: null, evidence, attribution });
}

// ---------------------------------------------------------------------------
// Chrome, found rather than assumed
// ---------------------------------------------------------------------------

function findChrome(): string {
  const fromEnv = process.env['CHROME_PATH'];
  if (typeof fromEnv === 'string' && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env['LOCALAPPDATA'] ?? ''}/Google/Chrome/Application/chrome.exe`,
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (c !== '' && existsSync(c)) return c;
  throw new Error(
    'Chrome not found. Set CHROME_PATH to the executable, or install Google Chrome.',
  );
}

// ---------------------------------------------------------------------------
// A minimal CDP client
// ---------------------------------------------------------------------------

/** One Chrome trace event, only the fields the attribution reads. `ts` and `dur` are microseconds. */
interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
}

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  readonly requests: { url: string; status: number }[] = [];
  private traceEvents: TraceEvent[] = [];
  private traceDone: (() => void) | null = null;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    const client = new Cdp(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP socket failed to open')), { once: true });
    });
    ws.addEventListener('message', (ev) => client.onMessage(String(ev.data)));
    return client;
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p === undefined) return;
      if (msg.error !== undefined) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params as { type?: string; args?: { value?: unknown }[] } | undefined;
      if (p?.type === 'error' || p?.type === 'warning') {
        this.consoleErrors.push(`${p.type}: ${p.args?.map((a) => String(a.value)).join(' ') ?? ''}`);
      }
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const p = msg.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
      this.pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown');
    }
    if (msg.method === 'Network.responseReceived') {
      const p = msg.params as { response?: { url?: string; status?: number } };
      if (p.response?.url !== undefined && p.response.status !== undefined) {
        this.requests.push({ url: p.response.url, status: p.response.status });
      }
    }
    if (msg.method === 'Tracing.dataCollected') {
      // A loop, not a spread: a trace chunk can hold more events than a call accepts arguments.
      for (const e of (msg.params as { value?: TraceEvent[] }).value ?? []) this.traceEvents.push(e);
    }
    if (msg.method === 'Tracing.tracingComplete') {
      this.traceDone?.();
      this.traceDone = null;
    }
  }

  /** Run `body` under a Chrome trace of `categories` and return what the trace saw beside it. */
  async traced<T>(categories: readonly string[], body: () => Promise<T>): Promise<{ result: T; events: TraceEvent[] }> {
    this.traceEvents = [];
    await this.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: categories },
    });
    const result = await body();
    const complete = new Promise<void>((resolve) => {
      this.traceDone = resolve;
    });
    await this.send('Tracing.end');
    await complete;
    const events = this.traceEvents;
    this.traceEvents = [];
    return { result, events };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout on ${method}`));
      }, 60_000);
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * `awaitPromise` is on, so a scenario can await a fetch inside the page. A thrown exception is
   * re-thrown here rather than returned as undefined: a silently swallowed page error is how a
   * gate reports green on a scenario that never ran.
   */
  async eval<T>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } };
    if (res.exceptionDetails !== undefined) {
      throw new Error(res.exceptionDetails.exception?.description ?? 'page exception');
    }
    return res.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function preflight(): Promise<void> {
  for (const [name, url] of [
    ['server', `${SERVER}/health`],
    ['client', CLIENT],
  ] as const) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      throw new Error(
        `The ${name} is not answering at ${url} (${err instanceof Error ? err.message : String(err)}). ` +
          `Start it with \`npm run serve\` and \`npm run dev\` before running this gate.`,
      );
    }
  }
}

async function launchChrome(): Promise<{ proc: ChildProcess; wsUrl: string; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'wayfinder-gate-'));
  const proc = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // A fixed window so the 320 px check is a deliberate emulation rather than an accident.
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl: string };
        return { proc, wsUrl: body.webSocketDebuggerUrl, profile };
      }
    } catch {
      // not up yet
    }
  }
  throw new Error(`Chrome did not expose a debugging port on ${PORT} within 15 s.`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const DRIVE_URL = `${CLIENT}/?from=${DRIVE_ROUTE.from[0]},${DRIVE_ROUTE.from[1]}&to=${DRIVE_ROUTE.to[0]},${DRIVE_ROUTE.to[1]}#15/28.4672/77.4968`;

async function main(): Promise<void> {
  await preflight();
  const { proc, wsUrl, profile } = await launchChrome();
  let cdp: Cdp | null = null;
  try {
    const browser = await Cdp.connect(wsUrl);
    const target = (await browser.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const attached = (await browser.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    browser.close();

    // Reconnect straight to the page target, which keeps the message plumbing trivial.
    const pageWs = `ws://127.0.0.1:${PORT}/devtools/page/${target.targetId}`;
    void attached;
    cdp = await Cdp.connect(pageWs);
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');

    await cdp.send('Page.navigate', { url: DRIVE_URL });
    await waitFor(cdp, 'window.__tracking !== undefined && window.__map !== undefined', 30_000, 'app boot');
    await waitFor(cdp, 'window.__tracking.routeGeometry().length > 2', 30_000, 'route arrival');

    await scenarioCleanDrive(cdp);
    await scenarioNoise(cdp);
    await scenarioDividedRoad(cdp);
    await scenarioDeviation(cdp);
    await scenarioFreeDrive(cdp);
    await scenarioPoorAndDropout(cdp);
    await hygiene(cdp);
    await performance(cdp);
  } finally {
    cdp?.close();
    proc.kill();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A locked profile directory on Windows is not a gate failure.
    }
  }
  report();
}

async function waitFor(cdp: Cdp, expr: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await cdp.eval<boolean>(`(() => { try { return !!(${expr}); } catch { return false; } })()`);
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${expr}`);
    await sleep(200);
  }
}

/**
 * The trace builder, run INSIDE the page.
 *
 * Defined as a string because it is evaluated in the browser. It walks the real route geometry at
 * a given speed, with optional Gaussian noise and a lateral deviation, and pushes each fix with an
 * explicit timestamp. Intervals are deliberately UNEVEN, taken from the gate 0 throttle
 * measurement, so nothing under test can quietly assume a cadence.
 */
const DRIVE_HELPERS = `
window.__gate = window.__gate || {};
window.__gate.UNEVEN = [188, 315, 253, 117, 402, 96, 271, 333, 149, 208];
window.__gate.rng = function (seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
window.__gate.hav = function (aLat, aLon, bLat, bLon) {
  var R = 6371008.8, D = Math.PI / 180;
  var dLat = (bLat - aLat) * D, dLon = (bLon - aLon) * D;
  var s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * D) * Math.cos(bLat * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};
window.__gate.cum = function (g) {
  var c = [0];
  for (var i = 1; i < g.length; i++) c.push(c[i - 1] + window.__gate.hav(g[i - 1][1], g[i - 1][0], g[i][1], g[i][0]));
  return c;
};
window.__gate.at = function (g, c, along) {
  var i = 0;
  while (i < c.length - 2 && c[i + 1] < along) i++;
  var a = g[i], b = g[i + 1];
  var segLen = c[i + 1] - c[i];
  var t = segLen === 0 ? 0 : Math.max(0, Math.min(1, (along - c[i]) / segLen));
  var lat = a[1] + t * (b[1] - a[1]);
  var lon = a[0] + t * (b[0] - a[0]);
  var kx = Math.cos(lat * Math.PI / 180);
  var brg = ((Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180 / Math.PI) + 360) % 360;
  return { lon: lon, lat: lat, bearing: brg };
};
/**
 * Drive the route and return every frame's observations.
 * opts: { speedMps, sigmaM, deviateAfterM, deviateM, dropoutEvery, accuracyM, seed, stepMs }
 */
window.__gate.drive = function (opts) {
  var t = window.__tracking;
  t.beginScripted();
  var g = t.routeGeometry();
  var c = window.__gate.cum(g);
  var total = c[c.length - 1];
  var rnd = window.__gate.rng(opts.seed || 20260731);
  var epoch = 1750000000000;
  var elapsed = 0, along = 0, i = 0;
  var out = { displaySteps: [], offsets: [], instructionIndices: [], qualities: [], phases: [], accepted: 0, rejected: 0, reroutes: 0, maxDisplayStepM: 0, samples: [] };
  var prevDisplay = null;
  var deviated = 0;
  while (along < total - 5 && i < 4000) {
    var dt = window.__gate.UNEVEN[i % window.__gate.UNEVEN.length];
    elapsed += dt;
    along += (opts.speedMps || 14) * (dt / 1000);
    if (along > total) along = total;
    var p = window.__gate.at(g, c, along);
    var latM = 0, lonM = 0;
    if (opts.sigmaM) {
      var u1 = Math.max(1e-9, rnd()), u2 = rnd();
      var mag = opts.sigmaM * Math.sqrt(-2 * Math.log(u1));
      latM = mag * Math.cos(2 * Math.PI * u2);
      lonM = mag * Math.sin(2 * Math.PI * u2);
    }
    if (opts.deviateAfterM && along > opts.deviateAfterM) {
      deviated = Math.min(opts.deviateM || 60, deviated + (opts.speedMps || 14) * (dt / 1000) * 0.45);
      var perp = (p.bearing + 90) * Math.PI / 180;
      latM += deviated * Math.cos(perp);
      lonM += deviated * Math.sin(perp);
    }
    var mLat = 1 / 110540, mLon = 1 / (111320 * Math.cos(p.lat * Math.PI / 180));
    var drop = opts.dropoutEvery && i > 0 && i % opts.dropoutEvery === 0;
    if (!drop) {
      // The 95% radius for the noise actually injected, per the W3C Geolocation definition of
      // accuracy: sigma * sqrt(-2 ln 0.05) = 2.4477 sigma. A trace that injects sigma and then
      // reports sigma is claiming twice the precision it has, and the fix filter is then right to
      // reject it. An explicit accuracyM overrides this, for the scenarios that test the ceiling.
      var reported = opts.accuracyM || Math.max(4, Math.round((opts.sigmaM || 0) * 2.4477)) || 8;
      t.injectFix({
        point: [p.lon + lonM * mLon, p.lat + latM * mLat],
        accuracyM: reported,
        headingDeg: p.bearing,
        speedMps: opts.speedMps || 14,
        timestamp: epoch + elapsed
      });
    }
    // Advance the animation in real display-sized steps between fixes, so the no-teleport bound
    // is measured over frames rather than over fixes.
    var step = opts.stepMs || 16;
    for (var f = 0; f < Math.max(1, Math.round(dt / step)); f++) {
      var s = t.step(epoch + elapsed, step);
      if (s.display && prevDisplay) {
        var d = window.__gate.hav(prevDisplay[1], prevDisplay[0], s.display[1], s.display[0]);
        out.displaySteps.push(d);
        if (d > out.maxDisplayStepM) out.maxDisplayStepM = d;
      }
      if (s.display) prevDisplay = s.display;
      if (s.matched) out.offsets.push(s.matched.offsetM);
      if (s.progress) out.instructionIndices.push(s.progress.instructionIndex);
      out.qualities.push(s.quality);
      out.phases.push(s.phase);
      out.accepted = s.accepted;
      out.rejected = s.rejected.accuracy + s.rejected['implied-speed'] + s.rejected['out-of-order'];
    }
    i++;
  }
  out.reroutes = t.state().reroutes;
  out.finalState = t.state();
  return out;
};
'ready';
`;

async function scenarioCleanDrive(cdp: Cdp): Promise<void> {
  await cdp.eval(DRIVE_HELPERS);
  const r = await cdp.eval<{
    maxDisplayStepM: number;
    offsets: number[];
    instructionIndices: number[];
    accepted: number;
    rejected: number;
    qualities: string[];
  }>(`JSON.parse(JSON.stringify(window.__gate.drive({ speedMps: 14, sigmaM: 0 })))`);

  const advanced = new Set(r.instructionIndices).size;
  const monotonic = r.instructionIndices.every((v, i, a) => i === 0 || v >= (a[i - 1] as number));
  const maxOffset = Math.max(...r.offsets, 0);

  record('1 clean drive', 'every fix accepted', [], r.rejected === 0 && r.accepted > 20, `${r.accepted} accepted, ${r.rejected} rejected`);
  record('1 clean drive', 'matched position stays on the road', [2, 3], maxOffset < 5, `max match offset ${maxOffset.toFixed(2)} m`);
  record('1 clean drive', 'instructions advance, never backwards', [], advanced >= 3 && monotonic, `${advanced} distinct steps reached, monotonic ${String(monotonic)}`);
  record('1 clean drive', 'display never teleports', [4], r.maxDisplayStepM <= TRACKING.maxDisplayStepM + 1e-6, `max frame step ${r.maxDisplayStepM.toFixed(3)} m against a ${TRACKING.maxDisplayStepM} m bound`);
}

async function scenarioNoise(cdp: Cdp): Promise<void> {
  const r = await cdp.eval<{ maxDisplayStepM: number; offsets: number[]; accepted: number; rejected: number }>(
    `JSON.parse(JSON.stringify(window.__gate.drive({ speedMps: 14, sigmaM: 8, seed: 7 })))`,
  );
  const sorted = [...r.offsets].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  record('2 gaussian noise', 'matched position stays on the road under 8 m noise', [3], p95 < TRACKING.offRouteM, `p95 match offset ${p95.toFixed(2)} m, corridor ${TRACKING.offRouteM} m`);
  record('2 gaussian noise', 'display never jumps despite noisy input', [4], r.maxDisplayStepM <= TRACKING.maxDisplayStepM + 1e-6, `max frame step ${r.maxDisplayStepM.toFixed(3)} m`);
  record('2 gaussian noise', 'noise alone does not trigger rejections', [], r.rejected === 0, `${r.rejected} rejected of ${r.accepted + r.rejected}`);
}

/**
 * Wrong-side matching, against a REAL divided carriageway derived by `calibrate:tracking`.
 *
 * Run through `/match` rather than the on-route matcher, because only the server holds both
 * carriageways: the client has just the route polyline, so it could not match the wrong road even
 * if it wanted to, and a test there would prove nothing.
 */
async function scenarioDividedRoad(cdp: Cdp): Promise<void> {
  for (const site of DIVIDED_ROADS) {
    const probe = (bearing: number): string => `
      (async () => {
        var lon = ${site.point[0]}, lat = ${site.point[1]}, hdg = ${bearing};
        var b = hdg * Math.PI / 180, perp = (hdg + 90) * Math.PI / 180;
        var mLat = 1 / 110540, mLon = 1 / (111320 * Math.cos(lat * Math.PI / 180));
        var fixes = [];
        for (var i = 0; i < 5; i++) {
          var d = i * 12, off = 8;
          fixes.push({
            point: [lon + (d * Math.sin(b) + off * Math.sin(perp)) * mLon,
                    lat + (d * Math.cos(b) + off * Math.cos(perp)) * mLat],
            accuracyM: 8, headingDeg: hdg, speedMps: 14, timestamp: 1000 + i * 1000
          });
        }
        var res = await fetch('/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixes }) });
        return await res.json();
      })()`;

    const fwd = await cdp.eval<{ match: { edgeId: number; bearingDeg: number } | null }>(probe(site.travelBearingDeg));
    const rev = await cdp.eval<{ match: { edgeId: number; bearingDeg: number } | null }>(probe(site.opposingBearingDeg));

    const both = fwd.match !== null && rev.match !== null;
    // CONTROL: both directions must resolve to something. If either returned null the comparison
    // below would be vacuous, and "did not match the wrong carriageway" would be true because it
    // matched nothing at all.
    record(`3 divided road ${site.key}`, 'both directions of travel resolve to a road', [], both, both ? `forward edge ${fwd.match?.edgeId}, reverse edge ${rev.match?.edgeId}` : 'one direction returned null');

    if (!both) continue;
    const distinct = fwd.match?.edgeId !== rev.match?.edgeId;
    record(`3 divided road ${site.key}`, 'the two carriageways are DIFFERENT edges', [3], distinct, `${fwd.match?.edgeId} against ${rev.match?.edgeId}, measured ${site.separationM} m apart`);

    const fb = fwd.match?.bearingDeg ?? 0;
    const alignedForward = angleGap(fb, site.travelBearingDeg) <= TRACKING.headingAgreementDeg;
    const rb = rev.match?.bearingDeg ?? 0;
    const alignedReverse = angleGap(rb, site.opposingBearingDeg) <= TRACKING.headingAgreementDeg;
    record(`3 divided road ${site.key}`, 'each match points the way the vehicle is travelling', [3], alignedForward && alignedReverse, `forward ${fb.toFixed(1)} vs ${site.travelBearingDeg}, reverse ${rb.toFixed(1)} vs ${site.opposingBearingDeg}`);
  }
}

function angleGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

async function scenarioDeviation(cdp: Cdp): Promise<void> {
  const r = await cdp.eval<{ reroutes: number; phases: string[]; finalState: { reroutes: number } }>(
    `JSON.parse(JSON.stringify(window.__gate.drive({ speedMps: 14, sigmaM: 2, deviateAfterM: 400, deviateM: 80, seed: 11 })))`,
  );
  const enteredRerouting = r.phases.includes('rerouting');
  record('4 deviation', 'the engine detects the departure and asks for a new route', [6], r.reroutes >= 1, `${r.reroutes} reroutes requested`);
  record('4 deviation', 'the phase reaches rerouting so the UI can say so', [10], enteredRerouting, `phases seen: ${[...new Set(r.phases)].join(', ')}`);

  // CONTROL: the same drive with no deviation must NOT re-route. Without this a matcher that
  // fires constantly would pass the assertion above.
  const control = await cdp.eval<{ reroutes: number }>(
    `JSON.parse(JSON.stringify(window.__gate.drive({ speedMps: 14, sigmaM: 2, seed: 11 })))`,
  );
  record('4 deviation', 'CONTROL: an on-route drive does not re-route', [], control.reroutes === 0, `${control.reroutes} reroutes on the same trace without the deviation`);
}

/**
 * FREE DRIVE, with no active route.
 *
 * The only way to reach this from a gate: the device fix source needs a real receiver and headless
 * Chrome refuses geolocation outright, so the scripted hook runs the engine with a null route and
 * the client's own code path does the rest. What is being checked is the WIRING, that a fix with
 * no route actually reaches `/match` and the answer moves the matched position, because the
 * endpoint passing its own tests says nothing about whether anything calls it.
 */
async function scenarioFreeDrive(cdp: Cdp): Promise<void> {
  const before = cdp.requests.filter((r) => r.url.endsWith('/match')).length;
  const r = await cdp.eval<{ matchedEdgeBearing: number | null; offsetM: number | null; site: number[] }>(`
    (async () => {
      var t = window.__tracking;
      t.beginScripted(true);
      var lon = ${DIVIDED_ROADS[0]?.point[0]}, lat = ${DIVIDED_ROADS[0]?.point[1]};
      var hdg = ${DIVIDED_ROADS[0]?.travelBearingDeg};
      var b = hdg * Math.PI / 180;
      var mLat = 1 / 110540, mLon = 1 / (111320 * Math.cos(lat * Math.PI / 180));
      var epoch = 1750000000000;
      for (var i = 0; i < 6; i++) {
        var d = i * 14;
        t.injectFix({
          point: [lon + d * Math.sin(b) * mLon, lat + d * Math.cos(b) * mLat],
          accuracyM: 8, headingDeg: hdg, speedMps: 14, timestamp: epoch + i * 1000
        });
        t.step(epoch + i * 1000, 16);
      }
      // The match is a round trip, so give it time to land before reading the result.
      await new Promise(function (r) { setTimeout(r, 1500); });
      var s = t.step(epoch + 6000, 16);
      return {
        matchedEdgeBearing: s.matched ? s.matched.bearingDeg : null,
        offsetM: s.matched ? s.matched.offsetM : null,
        site: [lon, lat]
      };
    })()`);

  const calls = cdp.requests.filter((rq) => rq.url.endsWith('/match')).length - before;
  record('6 free drive', 'a fix with no active route reaches the server matcher', [], calls > 0, `${calls} POST /match calls made by the client`);
  record(
    '6 free drive',
    'the answer names a road pointing the way the vehicle is travelling',
    [3],
    r.matchedEdgeBearing !== null && angleGap(r.matchedEdgeBearing, DIVIDED_ROADS[0]?.travelBearingDeg ?? 0) <= TRACKING.headingAgreementDeg,
    r.matchedEdgeBearing === null
      ? 'no matched position after the round trip'
      : `matched bearing ${r.matchedEdgeBearing.toFixed(1)} against travel ${DIVIDED_ROADS[0]?.travelBearingDeg}, offset ${(r.offsetM ?? 0).toFixed(1)} m`,
  );
}

async function scenarioPoorAndDropout(cdp: Cdp): Promise<void> {
  const r = await cdp.eval<{ qualities: string[]; accepted: number; rejected: number }>(
    `JSON.parse(JSON.stringify(window.__gate.drive({ speedMps: 14, sigmaM: 10, accuracyM: ${TRACKING.maxAccuracyM - 2}, dropoutEvery: 3, seed: 13 })))`,
  );
  const seen = new Set(r.qualities);
  record('5 poor and dropouts', 'quality degrades rather than claiming good', [10], seen.has('poor') || seen.has('lost'), `qualities seen: ${[...seen].join(', ')}`);
  record('5 poor and dropouts', 'the dot does not silently keep claiming a position', [10], !(seen.size === 1 && seen.has('good')), `${seen.size} distinct quality states`);

  const rejectAll = await cdp.eval<{ accepted: number; rejected: number }>(
    `JSON.parse(JSON.stringify(window.__gate.drive({ speedMps: 14, accuracyM: ${TRACKING.maxAccuracyM + 20}, seed: 17 })))`,
  );
  record('5 poor and dropouts', 'fixes worse than the accuracy ceiling are all rejected', [3], rejectAll.accepted === 0 && rejectAll.rejected > 10, `${rejectAll.accepted} accepted, ${rejectAll.rejected} rejected at ${TRACKING.maxAccuracyM + 20} m accuracy`);

  /**
   * A SUSTAINED dropout, long enough to reach `lost`.
   *
   * Dropping one fix in three never gets there: at roughly 200 ms intervals the longest gap is
   * about 600 ms, far inside the five second dropout window, so the check above only ever proved
   * that quality was not `good`. The `lost` path was untested. This drives a real signal loss and
   * asserts both directions of it, including the recovery, so a receiver that latches on `lost`
   * fails as loudly as one that never gets there.
   */
  const lost = await cdp.eval<{ before: string; during: string; after: string }>(`
    (() => {
      var t = window.__tracking;
      t.beginScripted();
      var g = t.routeGeometry();
      var c = window.__gate.cum(g);
      var epoch = 1750000000000;
      var p0 = window.__gate.at(g, c, 50);
      t.injectFix({ point: [p0.lon, p0.lat], accuracyM: 8, headingDeg: p0.bearing, speedMps: 14, timestamp: epoch });
      var before = t.step(epoch, 16).quality;
      // Nothing injected while the clock runs well past the dropout window.
      var during = t.step(epoch + 12000, 16).quality;
      var p1 = window.__gate.at(g, c, 60);
      t.injectFix({ point: [p1.lon, p1.lat], accuracyM: 8, headingDeg: p1.bearing, speedMps: 14, timestamp: epoch + 12500 });
      var after = t.step(epoch + 12500, 16).quality;
      return { before: before, during: during, after: after };
    })()`);
  record('5 poor and dropouts', 'a sustained signal loss reads as lost, not as a stationary vehicle', [10], lost.during === 'lost', `quality went ${lost.before} then ${lost.during} after 12 s of silence`);
  record('5 poor and dropouts', 'and it RECOVERS when fixes return', [10], lost.after === 'good', `back to ${lost.after} on the next fix`);
}

async function hygiene(cdp: Cdp): Promise<void> {
  record('hygiene', 'no uncaught page exceptions', [10], cdp.pageErrors.length === 0, cdp.pageErrors.length === 0 ? 'none' : cdp.pageErrors.slice(0, 2).join(' | '));
  record('hygiene', 'no console errors or warnings', [10], cdp.consoleErrors.length === 0, cdp.consoleErrors.length === 0 ? 'none' : cdp.consoleErrors.slice(0, 2).join(' | '));

  const tiles = cdp.requests.filter((r) => r.url.includes('.pmtiles'));
  const partial = tiles.filter((r) => r.status === 206);
  record('hygiene', 'the tile archive is fetched with byte ranges', [], partial.length > 0, `${partial.length} of ${tiles.length} pmtiles responses were 206`);

  const failed = cdp.requests.filter((r) => r.status >= 400);
  record('hygiene', 'no request failed', [10], failed.length === 0, failed.length === 0 ? 'none' : failed.slice(0, 3).map((f) => `${f.status} ${f.url}`).join(' | '));

  // 320 px, by EMULATION. `Emulation.setDeviceMetricsOverride` has no window-width floor, which is
  // why the checklist forbids doing this by resizing: a resized window silently stops at about
  // 500 CSS px and the narrow breakpoint never engages.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const narrow = await cdp.eval<{ innerWidth: number; scrollW: number; clientW: number }>(
    `({ innerWidth: window.innerWidth, scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth })`,
  );
  record('hygiene', 'no horizontal scroll at 320 px', [], narrow.innerWidth === 320 && narrow.scrollW <= narrow.clientW, `innerWidth ${narrow.innerWidth}, scrollWidth ${narrow.scrollW}, clientWidth ${narrow.clientW}`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

/**
 * The throttled pass. A mid-range Android is the target, so the numbers that matter are the ones
 * taken with the CPU slowed down.
 *
 * WHAT IS TIMED: the fix injection (`onFix`, which is the matching) and the frame step (`frame`,
 * then the covered line, the camera and the coarse publish), SEPARATELY, because in the app they
 * are separate tasks: a geolocation callback and an animation frame. Until gate 8 closed the
 * injection sat OUTSIDE the timed region, so the matching path was never measured at all, and the
 * argument that slow frames "never landed on a fix frame" discriminated nothing: the fix frames did
 * no more timed work than any other frame.
 *
 * ⛔ THE ATTRIBUTION IS A REPLAY, NOT A PATTERN. Scripted mode is a pure function of its trace, so
 * the drive is executed twice with identical inputs and frame j does identical work both times. A
 * frame over 50 ms in one execution and under it in the other is not slow work. What else could
 * have made it slow is then CHECKED rather than assumed: a Chrome trace records every garbage
 * collection on the page's main thread, and a collection is the page's own allocation, never an
 * external cause. The GC instrument carries its own positive control, a deliberate allocation
 * burst that must appear in the trace, so "no collection in this frame" is a reading from a live
 * instrument and not the silence of a broken one. Only a slow frame that survives all three,
 * fast on replay, not explained by a collection, instrument proven live, may become a NOTE.
 */
const PERF_FRAMES = 240;
const FIX_EVERY = 60;
/** The spec's long-task line. Every "slow" below means over this. */
const LONG_TASK_MS = 50;
const FRAME_BUDGET_MS = 1000 / 60;
/**
 * The two executions' clocks are aligned to the trace through one mark each, and must agree. One
 * millisecond is fifty times finer than the 50 ms under judgement, so a disagreement larger than
 * that means the windows are not where the gate thinks they are.
 */
const CLOCK_AGREEMENT_MS = 1;
/** Main-thread engine work that belongs to the page itself: V8 and Oilpan collection phases. */
const OWN_COLLECTION = /GC|Scavenge|MarkCompact|Sweep/;
const TRACE_CATEGORIES = ['blink.user_timing', 'devtools.timeline', 'disabled-by-default-v8.gc', 'blink_gc'];

interface PerfRun {
  readonly anchorMs: number;
  readonly frameStart: number[];
  readonly frameMs: number[];
  readonly fixStart: number[];
  readonly fixMs: number[];
}

function perfRunScript(tag: string): string {
  return `
    (async () => {
      var t = window.__tracking;
      t.beginScripted();
      var g = t.routeGeometry();
      var c = window.__gate.cum(g);
      var epoch = 1750000000000, elapsed = 0, along = 0;
      var frameStart = [], frameMs = [], fixStart = [], fixMs = [];
      var anchorMs = performance.mark(${JSON.stringify(tag)}).startTime;
      for (var i = 0; i < ${PERF_FRAMES}; i++) {
        elapsed += 16;
        along += 14 * 0.016;
        var p = window.__gate.at(g, c, along);
        if (i % ${FIX_EVERY} === 0) {
          var f0 = performance.now();
          t.injectFix({ point: [p.lon, p.lat], accuracyM: 8, headingDeg: p.bearing, speedMps: 14, timestamp: epoch + elapsed });
          fixStart.push(f0);
          fixMs.push(performance.now() - f0);
        }
        var t0 = performance.now();
        t.step(epoch + elapsed, 16);
        frameStart.push(t0);
        frameMs.push(performance.now() - t0);
      }
      return { anchorMs: anchorMs, frameStart: frameStart, frameMs: frameMs, fixStart: fixStart, fixMs: fixMs };
    })()`;
}

/** The GC instrument's positive control: an allocation burst no collector can ignore. */
function gcControlScript(tag: string): string {
  return `
    (() => {
      var start = performance.mark(${JSON.stringify(`${tag}-start`)}).startTime;
      // SHORT-LIVED, never retained. A retained burst was tried first and at 6x produced no
      // collection at all: V8 saw every object survive, pretenured the allocation site straight
      // into old space, and never scavenged. Objects written through a small ring escape, so they
      // cannot be optimised away, and die young, so they cannot be pretenured. About 110 MB of
      // them cannot fit in any young generation.
      var ring = new Array(1024), n = 0;
      for (var k = 0; k < 2000000; k++) { ring[k & 1023] = { k: k, pair: [k, k + 1] }; n++; }
      ring = null;
      var end = performance.mark(${JSON.stringify(`${tag}-end`)}).startTime;
      return { start: start, end: end, n: n };
    })()`;
}

function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))] as number;
}

/** Merged [start, end] intervals in trace microseconds, sorted, so overlaps are never counted twice. */
function mergeIntervals(raw: [number, number][]): [number, number][] {
  raw.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [s, e] of raw) {
    const last = out[out.length - 1];
    if (last !== undefined && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Milliseconds of `intervals` falling inside [from, to], both in trace microseconds. */
function overlapMs(intervals: readonly [number, number][], from: number, to: number): number {
  let total = 0;
  for (const [s, e] of intervals) {
    if (e <= from) continue;
    if (s >= to) break;
    total += Math.min(e, to) - Math.max(s, from);
  }
  return total / 1000;
}

async function performance(cdp: Cdp): Promise<void> {
  for (const rate of [4, 6]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await sleep(400);
    const tags = { a: `gate-${rate}x-a`, b: `gate-${rate}x-b`, control: `gate-${rate}x-gc-control` };
    const { result, events } = await cdp.traced(TRACE_CATEGORIES, async () => {
      const a = await cdp.eval<PerfRun>(perfRunScript(tags.a));
      await sleep(300);
      const b = await cdp.eval<PerfRun>(perfRunScript(tags.b));
      await sleep(300);
      const control = await cdp.eval<{ start: number; end: number; n: number }>(gcControlScript(tags.control));
      return { a, b, control };
    });
    judgePerformance(rate, tags, result.a, result.b, result.control, events);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

function judgePerformance(
  rate: number,
  tags: { a: string; b: string; control: string },
  a: PerfRun,
  b: PerfRun,
  control: { start: number; end: number; n: number },
  events: readonly TraceEvent[],
): void {
  const scenario = `performance ${rate}x throttle`;

  // --- Is the instrument live? Every reason it might not be is named, and any one of them means
  // --- no slow frame can be attributed, which fails closed rather than open.
  const problems: string[] = [];
  const anchorA = events.find((e) => e.name === tags.a);
  const anchorB = events.find((e) => e.name === tags.b);
  let offsetUs = 0;
  let gc: [number, number][] = [];
  let controlCollections = 0;
  let collectionNames: string[] = [];
  if (anchorA === undefined || anchorB === undefined) {
    problems.push('the anchor marks never reached the trace, so no frame can be located in it');
  } else {
    offsetUs = anchorA.ts - a.anchorMs * 1000;
    const offsetB = anchorB.ts - b.anchorMs * 1000;
    const driftMs = Math.abs(offsetUs - offsetB) / 1000;
    if (driftMs > CLOCK_AGREEMENT_MS) {
      problems.push(`the two executions align to the trace ${driftMs.toFixed(3)} ms apart, over ${CLOCK_AGREEMENT_MS} ms`);
    }
    // The page's main thread is whichever thread emitted the marks.
    const own = events.filter(
      (e) => e.pid === anchorA.pid && e.tid === anchorA.tid && e.ph === 'X' && (e.dur ?? 0) > 0 && OWN_COLLECTION.test(e.name),
    );
    gc = mergeIntervals(own.map((e) => [e.ts, e.ts + (e.dur ?? 0)]));
    const cFrom = offsetUs + control.start * 1000;
    const cTo = offsetUs + control.end * 1000;
    const inControl = own.filter((e) => e.ts < cTo && e.ts + (e.dur ?? 0) > cFrom);
    controlCollections = inControl.length;
    collectionNames = [...new Set(inControl.map((e) => e.name))].slice(0, 3);
    if (controlCollections === 0) {
      problems.push(
        `the GC instrument saw no collection during a deliberate burst of ${control.n} short-lived objects, so its silence elsewhere proves nothing`,
      );
    }
  }
  const live = problems.length === 0;

  // --- Every task over the line, in either execution, judged against its own replay.
  interface Slow {
    readonly what: string;
    readonly ms: number;
    readonly replayMs: number;
    readonly gcMs: number;
  }
  const slow: Slow[] = [];
  const pairs: [string, PerfRun, PerfRun][] = [
    ['A', a, b],
    ['B', b, a],
  ];
  for (const [label, run, other] of pairs) {
    const scan = (kind: string, starts: number[], durs: number[], replay: number[]): void => {
      for (let j = 0; j < durs.length; j++) {
        const ms = durs[j] as number;
        if (ms <= LONG_TASK_MS) continue;
        const from = offsetUs + (starts[j] as number) * 1000;
        slow.push({
          what: `${kind} ${j} in execution ${label}`,
          ms,
          replayMs: replay[j] as number,
          gcMs: live ? overlapMs(gc, from, from + ms * 1000) : Number.NaN,
        });
      }
    };
    scan('frame', run.frameStart, run.frameMs, other.frameMs);
    scan('fix injection', run.fixStart, run.fixMs, other.fixMs);
  }

  const reasonAgainst = (s: Slow): string | null => {
    if (!live) return `cannot be attributed: ${problems.join('; ')}`;
    if (s.replayMs > LONG_TASK_MS) return `slow AGAIN when re-executed with identical inputs (${s.replayMs.toFixed(1)} ms), so it is the work`;
    if (s.ms - s.gcMs <= LONG_TASK_MS) {
      return `${s.gcMs.toFixed(1)} ms of garbage collection inside it accounts for the crossing, and a collection is the page's own allocation`;
    }
    return null;
  };

  const frames = [...a.frameMs, ...b.frameMs];
  const fixes = [...a.fixMs, ...b.fixMs];
  const numbers =
    `frames: median ${quantile(frames, 0.5).toFixed(3)} ms, p99 ${quantile(frames, 0.99).toFixed(3)} ms, ` +
    `max ${Math.max(...frames).toFixed(3)} ms over 2 executions of ${PERF_FRAMES}. ` +
    `Fix injections: max ${Math.max(...fixes).toFixed(3)} ms over 2 x ${a.fixMs.length}. ` +
    `${slow.length} task(s) over ${LONG_TASK_MS} ms` +
    (slow.length === 0 ? '' : `: ${slow.map((s) => `${s.what} ${s.ms.toFixed(1)} ms`).join(', ')}`);

  const claim = `no frame or fix injection over ${LONG_TASK_MS} ms`;
  const against = slow.map((s) => ({ s, reason: reasonAgainst(s) }));
  const unattributed = against.filter((x) => x.reason !== null);
  if (slow.length === 0) {
    record(scenario, claim, [4], true, numbers);
  } else if (unattributed.length === 0) {
    note(
      scenario,
      `${claim}, reported, NOT judged`,
      [4],
      numbers,
      slow
        .map(
          (s) =>
            `${s.what} took ${s.ms.toFixed(1)} ms; the identical task re-executed with identical inputs took ` +
            `${s.replayMs.toFixed(1)} ms; ${s.gcMs.toFixed(1)} ms of collection inside it, leaving ` +
            `${(s.ms - s.gcMs).toFixed(1)} ms the thread spent on neither the work nor a collection`,
        )
        .join(' | ') +
        `. GC instrument live: ${controlCollections} collection(s) (${collectionNames.join(', ')}) seen in the control burst of ${control.n} short-lived objects`,
    );
  } else {
    record(
      scenario,
      claim,
      [4],
      false,
      `${numbers}. Not attributable: ${unattributed.map((x) => `${x.s.what}, ${x.reason as string}`).join(' | ')}`,
    );
  }

  /**
   * The frame budget carries a verdict at EVERY rate, and there is no attribution argument that
   * could withhold one: the median is the typical frame, not a spike, so there is nothing external
   * to point at. At 6x it sat at 6.6 to 16.2 ms against 16.67 across five runs at gate 8, which
   * is the real finding and is why gate 9 must measure frame time on an actual phone.
   */
  const med = quantile(frames, 0.5);
  record(
    scenario,
    'the tracking step fits inside a 60 fps frame budget',
    [4],
    med < FRAME_BUDGET_MS,
    `median ${med.toFixed(3)} ms (execution A ${quantile(a.frameMs, 0.5).toFixed(3)}, B ${quantile(b.frameMs, 0.5).toFixed(3)}) against ${FRAME_BUDGET_MS.toFixed(2)} ms`,
  );
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

function report(): void {
  const width = Math.max(...checks.map((c) => c.scenario.length));
  console.log('\n=== browser gate ===\n');
  let failed = 0;
  let noted = 0;
  for (const c of checks) {
    if (c.pass === null) noted++;
    else if (!c.pass) failed++;
    const mark = c.pass === null ? 'NOTE' : c.pass ? 'PASS' : 'FAIL';
    const items = c.charter.length === 0 ? '' : `  [charter ${c.charter.join(', ')}]`;
    console.log(`  ${mark}  ${c.scenario.padEnd(width)}  ${c.claim}${items}`);
    console.log(`        ${c.evidence}`);
    // Beside the number, every time. A NOTE whose reason lives only in a comment or a doc is a
    // verdict withheld on trust.
    if (c.attribution !== null) console.log(`        attribution: ${c.attribution}`);
  }

  console.log('\n  charter coverage from this gate');
  const covered = new Map<number, { pass: number; fail: number }>();
  for (const c of checks) {
    // A NOTE counts toward neither: it is a number this machine cannot judge, so it can neither
    // claim coverage of a charter item nor deny it.
    if (c.pass === null) continue;
    for (const item of c.charter) {
      const e = covered.get(item) ?? { pass: 0, fail: 0 };
      if (c.pass) e.pass++;
      else e.fail++;
      covered.set(item, e);
    }
  }
  for (const item of [...covered.keys()].sort((a, b) => a - b)) {
    const e = covered.get(item) as { pass: number; fail: number };
    console.log(`    item ${String(item).padStart(2)}   ${e.pass} passing, ${e.fail} failing`);
  }
  console.log(
    '\n  NOT covered here, and covered elsewhere: items 1, 2, 7, 8, 9 and 11 are headless checks.',
  );
  console.log('    1, 2, 8   gate:equality and the golden routing fixtures');
  console.log('    7, 9      the toy-graph suite and SCC filtering');
  console.log('    11        gate:equality, every rung through every restriction site');

  // A NOTE is subtracted from the pass count deliberately. Folding "we could not judge this" into
  // "this passed" is the quiet lie this third state exists to prevent.
  console.log(
    `\n  ${checks.length - failed - noted} passed, ${failed} failed, ${noted} reported without a verdict`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
