/**
 * I-group frame probe (2026-10-03) — the `com >= 100` bucket is a TRUTH-side
 * double-apply, not a faijs frame bug. Frozen so the finding cannot regress
 * into a "fix" on the faijs side.
 *
 * Two independent samples, same signature (`bbox` + `com` fail while `volume`
 * and `area` PASS ⇒ the two shapes are congruent and differ only by a rigid
 * motion):
 *
 *   Tapon.FCStd    volume 3211.434185269908 on BOTH sides
 *                  truth bbox [-16,-12.25,-16, 16,0,16]  com [0,-7.6153,0]
 *                  brp RAW bbox [-16,-16,0, 16,16,12.25] com [0,0,7.6153]
 *   Caisson.FCStd  volume 9241518389.31 on BOTH sides
 *                  truth bbox [-1500,0,-1500, 1500,5000,1500] com [0,3632,0]
 *                  brp RAW bbox [-1500,-1500,-5000, 1500,1500,0] com [0,0,-3632]
 *
 * In both files the ROOT feature's Document Placement is a 90° X rotation
 * (Q = 0.7071,0,0,0.7071) and the feature's own `.brp` ALREADY carries that
 * rotation. `export-fcstd-truth.py` applies the Placement on top of the raw
 * read unconditionally, so the truth is the raw shape rotated TWICE. faijs
 * imports the `.brp` as-is (the C3 `sketchCarriesFrame` guard suppresses the
 * M8.3 `cad.place`), which is why the exported STEP matches the RAW values
 * bit-for-bit and the verdict reports com(1.62e4) / com(5.54e4).
 *
 * A SKETCH's `.brp` is the opposite case — `PartShape.brp` reads back in
 * sketch-local coordinates (Tapon: raw bbox [0,0,0, 16,0,12.25], i.e.
 * unrotated) — so applying the Placement there is correct. Both conventions
 * coexist in one document; "apply every root Placement" is only right for the
 * second kind.
 *
 * Numeric proof (OCP, the same interpreter `step-invariants.py` uses):
 *   python tools/_i-group-frame-probe.py <rel>...
 * prints A (raw) / B (raw + placement) / the truth record on disk for each
 * sample; A matches what faijs exports and B matches the recorded truth.
 *
 * GOTCHA (same corpus-skip pattern as c2-root-placement-e2e.test.ts): the
 * samples live in the sibling `FreeCAD-library` checkout; when absent the
 * suite skips.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertFcstdFile } from './convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';

// The generated code calls `cad.sketch`, which only exists once the sketch
// namespace is merged and the GCS solver installed — same wiring as
// scripts/rebased-sweep.ts. Without it every sample fails at statement 0 with
// "__ns.cad.sketch is not a function", which says nothing about the frame.
installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeSketchNamespace(createApiNamespace());

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, '..', '..', '..', '..', 'FreeCAD-library');

const SAMPLES = [
  {
    rel: join('Mechanical Parts', 'Enclosures', 'Waterproof_case', 'Tapon.FCStd'),
    // raw .brp read: the 90°X rotation is ALREADY inside the brp
    raw: { volume: 3211.434185269908, bbox: [-16, -16, 0, 16, 16, 12.25], com: [0, 0, 7.615301189595466] },
    // truth on disk = the same shape rotated a second time
    truth: { volume: 3211.434185269908, bbox: [-16, -12.25, -16, 16, 0, 16], com: [0, -7.615301189595466, 0] },
  },
  {
    rel: join('Generic objects', 'Foundation', 'Caisson.FCStd'),
    raw: { volume: 9241518389.309973, bbox: [-1500, -1500, -5000, 1500, 1500, 0], com: [0, 0, -3632] },
    truth: { volume: 9241518389.309973, bbox: [-1500, 0, -1500, 1500, 5000, 1500], com: [0, 3632, 0] },
  },
] as const;

const available = SAMPLES.filter((s) => existsSync(join(LIB, s.rel)));

/** Run one product end to end and return every exported STEP terminal. */
async function runProduct(rel: string): Promise<{ src: string; steps: string[]; scratch: string }> {
  const summary = await convertFcstdFile(join(LIB, rel));
  expect(summary.ok, `conversion failed: ${JSON.stringify(summary.gaps)}`).toBe(true);
  if (!summary.zip) throw new Error('no product');
  const { loader, assets } = openContainer(summary.zip);
  const src = await loader.readSource('main.fai.js');

  const scratch = mkdtempSync(join(tmpdir(), 'i-frame-e2e-'));
  const assetsDir = join(scratch, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const [name, bytes] of Object.entries(assets)) {
    writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
  }
  for (const moduleKey of loader.listModules()) {
    const p = join(scratch, 'model', moduleKey);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, await loader.readSource(moduleKey));
  }
  const run = await cliRun(
    join(scratch, 'model', 'main.fai.js'),
    join(scratch, 'out.step'),
    { mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS } },
  );
  expect(run.ok, `run failed: ${JSON.stringify((run as { error?: unknown }).error ?? '')}`).toBe(true);
  return { src, steps: readdirSync(scratch).filter((f) => f.endsWith('.step')), scratch };
}

describe.skipIf(available.length === 0)('I-group frame: truth-side double-apply (Tapon / Caisson)', () => {
  for (const sample of available) {
    const name = sample.rel.split(/[/\\]/).pop()!;

    it(`${name}: emits NO cad.place for the root feature (its .brp already carries the frame)`, async () => {
      const { src } = await runProduct(sample.rel);
      // A `cad.place` here would re-apply the 90°X rotation the .brp already
      // holds — exactly the defect the truth reference has.
      expect(src, `unexpected cad.place in:\n${src}`).not.toMatch(/cad\.place\(/);
    });

    it(`${name}: runs end to end and produces a non-empty STEP`, async () => {
      const { steps, scratch } = await runProduct(sample.rel);
      expect(steps.length).toBeGreaterThan(0);
      const bytes = steps.reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
      expect(bytes).toBeGreaterThan(0);
    });
  }

  it('the raw and truth invariants differ ONLY by the 90deg X double rotation', () => {
    // Freeze the claim itself: raw vs truth must be the same solid in two
    // frames, i.e. volume identical and the two boxes a 90deg X rotation apart.
    // If a future corpus change makes them differ in volume, the "congruent,
    // frame-only" reading no longer holds and the triage must be redone.
    //
    // GOTCHA: destructure into plain numbers instead of indexing the arrays.
    // `SAMPLES` is `as const`, so a loop variable's `.bbox` index type collapses
    // and `b[i + 3]` evaluates to NaN at runtime while type-checking clean.
    for (const { raw, truth } of SAMPLES) {
      expect(raw.volume).toBeCloseTo(truth.volume, 6);
      // 90deg X maps (x,y,z) -> (x,-z,y): truth Y extent == raw Z extent and
      // truth Z extent == raw Y extent.
      const [rx0, ry0, rz0, rx1, ry1, rz1] = raw.bbox as readonly number[];
      const [tx0, ty0, tz0, tx1, ty1, tz1] = truth.bbox as readonly number[];
      expect(ty1 - ty0).toBeCloseTo(rz1 - rz0, 6);
      expect(tz1 - tz0).toBeCloseTo(ry1 - ry0, 6);
      // X is the rotation axis and must be untouched.
      expect(tx0).toBeCloseTo(rx0, 6);
      expect(tx1).toBeCloseTo(rx1, 6);
    }
  });
});
