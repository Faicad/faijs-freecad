/**
 * A4/A1 Draft drawing chain — end to end, and by EXECUTION.
 *
 * The standing rule for this pipeline is that a gap-free conversion summary proves
 * nothing: the product itself must run. The first implementation chained
 * `pen.moveTo(…).lineTo(…)` — an API that does not exist (`moveTo` is
 * `movePointerTo`) and a *member chain* that nests one AST level per segment. Draft
 * contours carry hundreds to thousands of segments, so 11 of 15 converted corpus
 * drawings could not execute at all, 10 of them with
 * `[parser] AST nesting depth exceeds 100`, and the eleventh with
 * `cad.draw is not a function` because the emitted drawing had never once been run.
 *
 * A1 (2026-09-29) then replaced the intermediate form entirely: the contour now
 * travels as the platform's own `ProfileLoop` data (`{segments: […]}`) straight
 * into `cad.sketchOnPlane`, so there is no pen chain, no `cad.draw` session and no
 * local function per contour — and analytic source curves stay analytic instead of
 * being tessellated first (see `draft-analytic-e2e.test.ts` for that half, and
 * `draft-draw.ts` for why the tessellating form hung on every Sprocket).
 *
 * This file pins the whole chain on real documents:
 *   draft .brp  →  one `ProfileLoop` per wire  →  `cad.sketchOnPlane` (the object's
 *   own Placement as the lift frame)  →  a Shape the rest of the document consumes
 *   via `cad.extrude` / `cad.sweep`.
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

// The host a real `.fai.zip` consumer must provide: platform + sketch + draw. Until
// A1 (2026-09-29) the Draft emission called `cad.draw`, which is why
// `@faicad/faijs-freecad` declares `@faicad/faijs-draw` as a runtime dependency; the
// contours now travel as `ProfileLoop` data, so that dependency is worth revisiting
// (kept registered here because it is still declared and the host must match the
// declared surface).
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/faijs-freecad → packages → repo root → D:/Faicad (sibling checkout).
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
  const members = readZipEntries(zip);
  const entry = [...members.keys()].find((n) => n.endsWith('main.fai.js'));
  return entry ? new TextDecoder().decode(members.get(entry)!) : '';
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
      it('emits one ProfileLoop per wire, lifted by a sketchOnPlane placement', async () => {
        const summary = await convertFcstdFile(join(CORPUS, c.rel));
        // H 组 (2026-10-03): an honest translation-time gap
        // (`sweep-transition-unsupported:transformed|round`) makes `ok` false
        // for docs that carry such sweeps — the modules are still emitted and
        // the assertions below are about the DRAW-chain shape, so tolerate a
        // failure whose gap list is exclusively sweep-transition ones.
        const nonSweepGaps = (summary.gaps ?? []).filter(
          (g) =>
            !String(g.reason).startsWith('sweep-transition-unsupported') &&
            // downstream of a baked sweep: the Cut consumed a sweep result
            // that is now a gap — inherited, not an independent regression.
            !(g.reason === 'cut-missing-dependency' &&
              (summary.gaps ?? []).some((s) => String(s.reason).startsWith('sweep-transition-unsupported'))),
        );
        if (!summary.ok) {
          expect(nonSweepGaps, `real gaps: ${JSON.stringify(nonSweepGaps)}`).toEqual([]);
          // a gap-carrier doc produces no container zip — the DRAW-chain
          // assertions below only apply to fully-translated documents.
          expect(summary.zip).toBeUndefined();
          return;
        }
        expect(summary.zip).toBeDefined();
        const src = mainSource(summary.zip!);
        // GOTCHA: assert the superseded forms are GONE, not just that the new one is
        // present, or a regression could reintroduce them alongside. `pen.moveTo` /
        // `pen.lineTo` are the depth-cap failure; `cad.draw` is the tessellating
        // form that hung every Sprocket.
        expect(src).not.toMatch(/\bpen\.moveTo\(/);
        expect(src).not.toMatch(/pen\.lineTo\(/);
        expect(src).not.toMatch(/cad\.draw\(/);
        expect(src).toMatch(/cad\.sketchOnPlane\(\{ contours: \[\{/);
        // GOTCHA (Chair, 2026-09-28): the raw drawn contours carry NO BREP handle,
        // so they must never leak into the root `cad.compound` aggregate. A1 removed
        // the per-contour variable entirely — the loop data lives inside the call's
        // `params` — so pin that no `__draw` variable exists at all.
        expect(src).not.toMatch(/__draw/);
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
