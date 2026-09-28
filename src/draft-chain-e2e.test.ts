/**
 * A4 Draft drawing chain — end to end, and by EXECUTION.
 *
 * The standing rule for this pipeline is that a gap-free conversion summary proves
 * nothing: the product itself must run. Before this fix, 11 of 15 converted corpus
 * drawings could not execute at all, 10 of them with
 * `[parser] AST nesting depth exceeds 100` — a `cad.draw` pen *member chain* nests
 * one AST level per segment, and Draft contours carry hundreds to thousands of
 * tessellated points. The eleventh raised `cad.draw is not a function` because the
 * emitted drawing had never once been executed.
 *
 * This file pins the whole chain on real documents:
 *   draft .brp  →  one `cad.draw` per wire (`pen.polyline([…])`)  →  `cad.sketchOnPlane`
 *   (the object's own Placement as the lift frame)  →  a Shape the rest of the
 *   document consumes via `cad.extrude` / `cad.sweep`.
 *
 * Corpus-dependent like the sibling e2e files: the FreeCAD library lives in the
 * sibling checkout, so this SKIPS (never fails) when it is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '@faicad/faijs-draw';
import { convertFcstdFile } from './convert.js';
import { openContainer } from './container-read.js';

installSketchSolver(createNodePlanegcsSolver);

// The host a real `.fai.zip` consumer must provide: platform + sketch + draw. The
// Draft emission needs `draw` specifically, which is why `@faicad/faijs-fcstd`
// declares it as a runtime dependency.
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/fcstd → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');

const CASES = [
  {
    name: 'Kitchen_cabinet_base (17 Draft objects / 60 contours)',
    rel: join('Architectural Parts', 'Kitchen', 'Kitchen_cabinet_base.FCStd'),
    // The drawing chain itself is correct here, but the document ALSO sweeps with
    // FreeCAD's `Transition` = Transformed/Round, which `cad.sweep` deliberately
    // rejects (`SWEEP_TRANSITION_UNSUPPORTED`, sweepFns.ts — "not supported after
    // selfhosting (only 'right' default)"). That is a separate capability gap, so
    // this document's execution is pinned with `it.fails` below.
    expectRun: false,
  },
  {
    name: 'Chair (2 Draft objects / 80 contours)',
    rel: join('Architectural Parts', 'Living room', 'Chair.FCStd'),
    expectRun: true,
  },
];

/** The emitted main module source, for shape assertions on the drawing chain. */
function mainSource(zip: Uint8Array): string {
  const members = unzipSync(zip);
  const entry = Object.keys(members).find((n) => n.endsWith('main.fai.js'));
  return entry ? strFromU8(members[entry]!) : '';
}

/** Materialise the product into a scratch project and execute every model. */
async function runProduct(zip: Uint8Array): Promise<string | undefined> {
  const { manifest, loader, assets } = openContainer(zip);
  const scratch = mkdtempSync(join(tmpdir(), 'fai-draft-'));
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

describe.skipIf(!existsSync(CORPUS))('A4 Draft drawing chain (real FreeCAD documents)', () => {
  for (const c of CASES) {
    describe.skipIf(!existsSync(join(CORPUS, c.rel)))(c.name, () => {
      it('emits one draw call per wire plus a sketchOnPlane placement', async () => {
        const summary = await convertFcstdFile(join(CORPUS, c.rel));
        expect(summary.ok, `gaps: ${JSON.stringify(summary.gaps)}`).toBe(true);
        expect(summary.zip).toBeDefined();
        const src = mainSource(summary.zip!);
        // GOTCHA: the original emission chained `pen.moveTo(…).lineTo(…)` — an API
        // that does not exist (`moveTo` is `movePointerTo`) and a shape that trips
        // the AST depth cap. Assert the broken form is GONE, not just that the new
        // one is present, or a regression could reintroduce it alongside.
        expect(src).not.toMatch(/\bpen\.moveTo\(/);
        expect(src).not.toMatch(/pen\.lineTo\(/);
        expect(src).toMatch(/cad\.draw\(\(pen\) => pen\.polyline\(\[/);
        // The drawn contours are useless until something turns them into a Shape.
        expect(src).toMatch(/cad\.sketchOnPlane\(\{ contours: \[/);
        // GOTCHA (Chair, 2026-09-28): the raw drawn contours carry NO BREP handle,
        // so they must never leak into the root `cad.compound` aggregate — the
        // placement call declares them in `inputs` (with `noPositionalArgs`) to
        // keep them consumed. Leaking them produced
        // `E_BREP_UNSUPPORTED: compound members are not all on the BREP chain`.
        expect(src).not.toMatch(/cad\.compound\(\{ members: \[[^\]]*__draw/);
      }, 600_000);

      const runName = c.expectRun
        ? 'runs the product end to end'
        : 'KNOWN BLOCKER: cannot run yet (unrelated sweep transitionMode gap)';
      const runFn = async () => {
        const summary = await convertFcstdFile(join(CORPUS, c.rel));
        expect(summary.zip).toBeDefined();
        const err = await runProduct(summary.zip!);
        expect(err, String(err ?? '')).toBeUndefined();
      };
      if (c.expectRun) {
        it(runName, runFn, 600_000);
      } else {
        it.fails(runName, runFn, 600_000);
      }
    });
  }
});
