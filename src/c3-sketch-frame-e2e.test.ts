/**
 * C3 e2e (2026-10-01) — a profile sketch's plane frame must not be applied twice.
 *
 * `Electrical Parts/Winch/Winch-Model1-Parts/Winch-Model1-Roll-Vertical.fcstd`
 * is a flat legacy PartDesign document: three pads stacked along +Z
 * (Pad 0..10, Pad001 10..72, Pad002 72..82), each built from a sketch that is
 * attached at the previous pad's top face.
 *
 * A3 emits the attachment-resolved Placement as the sketch's explicit plane
 * frame (`plane: { origin: [0,0,10] }` / `[0,0,72]`), so the extruded solid
 * ALREADY stands in the sketch frame. M8.3 then emitted a second
 * `cad.place(<pad>, position: [0,0,10])` from that very same Placement — the
 * frame applied twice.
 *
 * Corpus measurement of the shipped product (before the fix):
 *   bbox z = [0, 154] (= 72 + 82, the second application) vs truth [0, 82]
 *   com z  = 53.185161 vs truth 41.0
 * Both figures are reproduced exactly by "plane origin applied, then place
 * applied again", which is also what the emitted source says.
 *
 * GOTCHA (same corpus-skip pattern as c2-root-placement-e2e.test.ts): the
 * sample lives in the sibling `FreeCAD-library` checkout; when absent it skips.
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
// A2: converted models emit `cad.sketch`, so the run host must merge the sketch
// library into the cad namespace and install the planegcs solver — the same
// assembly container-open-e2e.test.ts uses.
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeSketchNamespace(createApiNamespace());

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(
  here, '..', '..', '..', '..',
  'FreeCAD-library', 'Electrical Parts', 'Winch', 'Winch-Model1-Parts',
  'Winch-Model1-Roll-Vertical.fcstd',
);
const sampleAvailable = existsSync(SAMPLE);

/** Binary-STL bounds (80-byte header, uint32 count, 50 bytes per triangle). */
function stlBounds(buf: Buffer): { min: [number, number, number]; max: [number, number, number] } {
  expect(buf.length).toBeGreaterThan(84);
  const n = buf.readUInt32LE(80);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50;
    for (let v = 0; v < 3; v++) {
      const o = base + 12 + v * 12;
      const x = buf.readFloatLE(o);
      const y = buf.readFloatLE(o + 4);
      const z = buf.readFloatLE(o + 8);
      min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
      min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
      min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
    }
  }
  return { min, max };
}

describe.skipIf(!sampleAvailable)('C3 sketch plane frame is applied once (Winch Roll-Vertical)', () => {
  it('keeps the sketch plane origins and drops the duplicate cad.place', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    expect(summary.ok, `conversion failed: ${JSON.stringify(summary.gaps)}`).toBe(true);
    if (!summary.zip) throw new Error('no product');

    const { loader } = openContainer(summary.zip);
    const src = await loader.readSource('main.fai.js');

    // The attached sketches still carry their (attachment-resolved) origins…
    expect(src).toContain('"origin":[0,0,10]');
    expect(src).toContain('"origin":[0,0,72]');
    // …and the pads are NOT re-placed by the same translation a second time.
    // GOTCHA: asserting "no cad.place at all" is right for THIS document (every
    // frame arrives through a sketch plane), not a universal rule — shape-asset
    // documents legitimately need cad.place (see C2 / HBS_assembly).
    expect(src, `unexpected cad.place:\n${src}`).not.toMatch(/cad\.place\(/);
  });

  it('runs end to end and lands the stack at z = 82 (not 154)', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    if (!summary.zip) throw new Error('no product');
    const { loader, assets } = openContainer(summary.zip);

    const scratch = mkdtempSync(join(tmpdir(), 'c3-winch-e2e-'));
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
      join(scratch, 'out.stl'),
      { mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS } },
    );
    expect(run.ok, `run failed: ${JSON.stringify((run as { error?: unknown }).error ?? '')}`).toBe(true);

    const stls = readdirSync(scratch).filter((f) => f.endsWith('.stl'));
    expect(stls.length).toBeGreaterThan(0);
    const bounds = stls.map((f) => stlBounds(readFileSync(join(scratch, f))));
    const zMin = Math.min(...bounds.map((b) => b.min[2]));
    const zMax = Math.max(...bounds.map((b) => b.max[2]));
    // Truth (freezed `PartShape8.brp`): bbox z [0, 82]; the doubled frame put
    // the top pad at 144..154. Tolerance covers mesh tessellation only.
    expect(zMin).toBeCloseTo(0, 1);
    expect(zMax).toBeCloseTo(82, 1);
  });
});
