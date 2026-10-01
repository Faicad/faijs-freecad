/**
 * A2 (2026-09-29 plan) — parametric Draft edges stay parametric, end to end and
 * BY EXECUTION.
 *
 * The gap this file closes: A1 gave the Draft rebuild analytic `line` / `arc`
 * emission, but every `bezier` / `bspline` edge still fell into the per-edge
 * tessellation fallback. A corpus-wide audit (`scripts/audit-draft-kinds.ts`,
 * 3201 documents / 766 Draft objects / 78 795 Draft edges) measured what that
 * costs:
 *
 *   kinds: circle=54837 line=21679 **bezier=1339 bspline=912** ellipse=28
 *   → 2279 parametric Draft edges over 20 documents
 *
 * i.e. ~2.3 k curves were being sampled into polylines. Three documents are
 * pinned here, measured per-kind with `scripts/probe-draft-kinds.ts`:
 *   · `Cloud_shelf`  — Draft `ShapeString`: bezier=76 line=57
 *   · `Batman shelf` — Draft `Shape2DView`:  bspline=8 line=26 circle=1
 *   · `Chair`        — Draft `Shape2DView` ×2: bspline=28 ellipse=6 line=48 circle=16
 *
 * Every case asserts the SAME first fact — one that no green conversion can show:
 * each parametric edge reaches the emitted source as a `spline` SEGMENT carrying
 * its real NURBS control data (poles / knots / multiplicities / degree / weights
 * + the trim), and the sampled-polyline forms are GONE.
 *
 * ── the execution legs, and their exact strength ────────────────────────────────
 * A2's risk is a payload the profile chain cannot actually lift, so the emission
 * assertions alone are not enough: the product has to run. Two of the three
 * documents are blocked DOWNSTREAM of the parametric edges by a pre-existing
 * fillet gap that has nothing to do with A2 — established, not assumed, by
 * `scripts/probe-a2-fillet-baseline.ts`, which re-runs the same product with the
 * spline segments replaced by de Boor-sampled `line` segments (the A1 form) and
 * reaches the identical error:
 *
 *   · `Cloud_shelf`  — `cad.fillet(Cut, …)`: `Cut` is `subtract(imported BREP,
 *     extruded ShapeString)` and edge 1's adjacent face has no role lineage.
 *     Both the A2 and the A1 emission fail here, verbatim.
 *   · `Batman shelf` — the failing edge selectors live in the *imported* Body
 *     modules, and ES imports are evaluated before any main statement: the run
 *     leg never even reaches the Draft statements. Hence it asserts nothing about
 *     A2 and is pinned only as a blocker.
 *
 * Those two are therefore asserted as EXACT expected errors rather than with
 * `it.fails`: `Cloud_shelf`'s error proves everything upstream ran — the spline
 * lift (`cad.sketchOnPlane`), the `cad.extrude` of that profile and the boolean
 * that consumes it — and any earlier failure (i.e. a real A2 regression) changes
 * the message and fails the test. `it.fails` would silently accept it.
 *
 * `Chair` is the honest full-run case: it already ran end to end before A2
 * (`draft-chain-e2e.test.ts`, `expectRun: true`) and still does, with 28 `bspline`
 * edges now travelling as splines. Its .brp holds 34 parametric edges of which
 * 6 are `ellipse` — a kind A2 deliberately does not cover — so the emitted
 * `spline` count is 34 − 6 = 28, which is why the count is asserted as 28 and not
 * as the raw histogram.
 *
 * Corpus-dependent like the sibling e2e files: the FreeCAD library lives in the
 * sibling checkout, so this SKIPS (never fails) when it is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readZipEntries } from '@faicad/faijs/io/zip';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '@faicad/faijs-draw';
import { convertFcstdFile } from './convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';

installSketchSolver(createNodePlanegcsSolver);

const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/fcstd → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');

/** Every emitted model module's source, concatenated. */
function modelSource(zip: Uint8Array): string {
  const members = readZipEntries(zip);
  return [...members]
    .filter(([n]) => n.endsWith('.fai.js'))
    .map(([, b]) => new TextDecoder().decode(b))
    .join('\n');
}

/** Materialise the product into a scratch project and execute every model. */
async function runProduct(zip: Uint8Array): Promise<string | undefined> {
  const { manifest, loader, assets } = openContainer(zip);
  const scratch = mkdtempSync(join(tmpdir(), 'fai-a2-'));
  const assetsDir = join(scratch, 'assets');
  for (const [name, bytes] of Object.entries(assets)) {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
  }
  for (const mk of loader.listModules()) {
    const q = join(scratch, 'model', mk);
    mkdirSync(join(q, '..'), { recursive: true });
    writeFileSync(q, await loader.readSource(mk));
  }
  for (const m of manifest.models) {
    const out = join(scratch, `out-${m.id}.step`);
    const r = await cliRun(join(scratch, m.entry), out, {
      mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS },
    });
    if (!r.ok) return `${m.id} failed: ${String((r as { error?: unknown }).error ?? '')}`;
    const stepBytes = readdirSync(scratch)
      .filter((f) => f.endsWith('.step'))
      .reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
    if (stepBytes === 0) return `${m.id} wrote no STEP`;
  }
  return undefined;
}

interface Case {
  /** Path under the corpus root. */
  rel: string;
  /** What the document is, for the test name. */
  label: string;
  /** `spline` segments the emitted source must carry — see the header for why it
   *  is the histogram minus the kinds A2 does not cover. */
  paramEdges: number;
  /**
   * Omitted → the product must run and write a STEP.
   * Given → the exact error the product must fail with: a blocker proven
   * downstream of (and independent from) the parametric edges. Asserting the
   * exact message keeps the leg meaningful — see the header.
   */
  expectRunError?: RegExp;
  /** Why the run is blocked (rendered in the test name). */
  runBlocker?: string;
}

const CASES: Case[] = [
  {
    rel: join('Industrial Design', 'Shelf', 'Cloud_shelf.FCStd'),
    label: 'Cloud_shelf — Draft ShapeString, 76 bezier + 57 line',
    paramEdges: 76, // GOTCHA: only bezier/bspline edges emit as spline; the 57 line edges stay as line segments
    // 2026-09-30 promoted from KNOWN BLOCKER to a full-run assertion: the old
    // blocker was `edgeRef: adjacent face ordinal 1 has no role lineage` at s7
    // `cad.fillet(Cut, …)` — `Cut` is `subtract(imported BREP, extruded
    // ShapeString)` and import_brep was a bare async function, so the defineOp
    // wrapper never registered the part-key roleTable and the imported faces
    // had no role lineage. Fixing that (import-brep.ts GOTCHA) unblocked the
    // whole product end to end.
  },
  {
    rel: join('Industrial Design', 'Shelf', 'Batman shelf.FCStd'),
    label: 'Batman shelf — Draft Shape2DView (edge compound), 8 bspline',
    paramEdges: 8,
    // The failing selectors are inside the imported Body modules; ES imports are
    // evaluated before main's first statement, so this leg proves nothing about
    // the Draft splines and is pinned as a blocker only. The error is wrapped
    // with `dependency module failed at line N:` because the fillet callee lives
    // in an imported module — tolerate that wrapping while still pinning the
    // probe-verified A2-independent blocker (`edgeRef: edge ordinal 49 …`).
    expectRunError: /callee: fillet\):(?: dependency module failed at line \d+:)? edgeRef: edge ordinal 49 out of range \[1, 48\]/,
    runBlocker: 'blocked in an imported Body module — rebuilt body has 48 edges, the document asks for Edge49 (A2-independent, probe-verified)',
  },
  {
    rel: join('Architectural Parts', 'Living room', 'Chair.FCStd'),
    label: 'Chair — Draft Shape2DView ×2, 28 bspline (+6 ellipse not covered by A2)',
    paramEdges: 28,
  },
];

describe.skipIf(!existsSync(CORPUS))('A2 parametric Draft edges (real FreeCAD documents)', () => {
  for (const c of CASES) {
    const abs = join(CORPUS, c.rel);
    describe.skipIf(!existsSync(abs))(c.label, () => {
      it('GOTCHA: every parametric edge is emitted as a spline segment with real NURBS data, never sampled', async () => {
        const summary = await convertFcstdFile(abs);
        expect(summary.ok, `gaps: ${JSON.stringify(summary.gaps)} error: ${summary.error}`).toBe(true);
        const src = modelSource(summary.zip!);
        // The superseded shapes must be GONE, not merely outnumbered: a partial
        // regression could reintroduce a sampled contour alongside the good ones.
        expect(src).not.toMatch(/pen\.polyline/);
        expect(src).not.toMatch(/cad\.draw\(/);
        // The count equals the .brp's own parametric-edge histogram (minus the
        // kinds A2 does not cover), so it fails if ANY of them is sampled into a
        // polyline instead (measured per case with `scripts/probe-draft-kinds.ts`).
        expect((src.match(/"kind":"spline"/g) ?? []).length).toBe(c.paramEdges);
        // A spline segment must carry control data, not a point list — the degree,
        // the knot pair and the trim are what make it a curve.
        expect(src).toMatch(/"kind":"spline","degree":\d+,"poles":\[/);
        expect(src).toMatch(/"knots":\[/);
        expect(src).toMatch(/"multiplicities":\[/);
      }, 600_000);

      const runName = c.expectRunError
        ? `KNOWN BLOCKER (unrelated to A2): ${c.runBlocker}`
        : 'runs the product end to end';
      it(runName, async () => {
        const summary = await convertFcstdFile(abs);
        expect(summary.zip).toBeDefined();
        const err = await runProduct(summary.zip!);
        if (c.expectRunError) {
          // Not `it.fails`: the exact message proves how far execution got, so a
          // regression that fails EARLIER (e.g. the spline lift) fails this test.
          expect(err, 'the product is expected to be blocked — if it now runs, promote this case to a full-run assertion').toBeDefined();
          expect(err!).toMatch(c.expectRunError);
        } else {
          expect(err, String(err ?? '')).toBeUndefined();
        }
      }, 600_000);
    });
  }
});
