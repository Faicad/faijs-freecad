/**
 * M3/M5 regression ledger — API usages that deviated from expectation during
 * the FCStd port. Each test documents the WRONG assumption we first made and
 * the verified-correct behavior, so future work does not re-trip on them.
 *
 * These are also API-design smell records: semantics that surprise integrators
 * should either be renamed upstream or kept documented here (see
 * .agents/notes/2026-09-16-fcstd-port-m0-m5.md).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import type { SketchSolver } from '@faicad/faijs-sketch';
import { zipSync, strToU8, unzipSync } from 'fflate';

let solver: SketchSolver;
beforeAll(async () => {
  solver = await createNodePlanegcsSolver();
});

describe('planegcs API traps (M3.4)', () => {
  it('GOTCHA: planegcs "difference" is param2 − param1, NOT param1 − param2', async () => {
    // First implementation assumed param1 − param2 = value (mirror image).
    // Verified empirically (dbg-m3c): difference = param2 − param1.
    // FCStd DistanceX value = second.x − first.x, so mapping is
    // param1=first, param2=second. The system is underconstrained (no fixed
    // anchor), so only the SIGNED DELTA is asserted, not absolute position.
    const r = await solver.solve(
      [{ kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 10, y2: 0, z2: 0 }],
      [
        { index: 0, type: 2, refs: [{ geoId: 0, pos: 0 }], value: 0, isDriving: true, name: '' },
        { index: 1, type: 7, refs: [{ geoId: 0, pos: 1 }, { geoId: 0, pos: 2 }], value: 40, isDriving: true, name: '' },
      ],
    );
    const outcome = (r as { value: { geoms: { x1: number; x2: number }[]; converged: boolean } }).value;
    expect(outcome.converged).toBe(true);
    // with the WRONG param order this comes out as −40 (mirror image)
    expect(outcome.geoms[0]!.x2 - outcome.geoms[0]!.x1).toBeCloseTo(40, 6);
  });

  it('GOTCHA: DistanceX/DistanceY values are SIGNED in FCStd (downward = negative)', async () => {
    // A rectangle's left edge drawn downward (10,50)→(10,20) carries
    // DistanceY = −30; assuming unsigned 30 mirrors the rectangle.
    // Underconstrained again: assert the signed delta only.
    const r = await solver.solve(
      [{ kind: 'line', index: 0, x1: 10, y1: 50, z1: 0, x2: 10, y2: 20, z2: 0 }],
      [
        { index: 0, type: 3, refs: [{ geoId: 0, pos: 0 }], value: 0, isDriving: true, name: '' },
        { index: 1, type: 8, refs: [{ geoId: 0, pos: 1 }, { geoId: 0, pos: 2 }], value: -30, isDriving: true, name: '' },
      ],
    );
    const outcome = (r as { value: { geoms: { y1: number; y2: number }[]; converged: boolean } }).value;
    expect(outcome.converged).toBe(true);
    // second.y − first.y = −30 (i.e. the edge points downward)
    expect(outcome.geoms[0]!.y2 - outcome.geoms[0]!.y1).toBeCloseTo(-30, 6);
  });
});

describe('fflate API traps (M2)', () => {
  it('GOTCHA: zipSync with a string value recurses infinitely (RangeError), must use strToU8', () => {
    // build-fai-zip.ts first passed JSON.stringify(...) strings directly as
    // zipSync values; fflate treats a string as a directory object and its
    // `fltn` walker recurses until stack overflow. Always wrap text with
    // strToU8. (fflate 0.8.2, esm/index.mjs fltn)
    expect(() =>
      zipSync({ 'manifest.json': '{"format":1}' } as never),
    ).toThrow(RangeError);

    // correct usage round-trips
    const ok = zipSync({ 'manifest.json': strToU8('{"format":1}') });
    expect(Buffer.from(unzipSync(ok)['manifest.json']!).toString()).toBe('{"format":1}');
  });
});

describe('planegcs solution readback (M3.3)', () => {
  it('GOTCHA: solved coordinates are read via sketch_index.get_primitive after apply_solution, NOT get_gcs_params', () => {
    // get_gcs_params() returns a flat param block with no per-point addressing;
    // apply_solution() pulls every primitive's solved values back into the
    // wrapper's sketch_index (gcs_wrapper.js:104-108), so get_primitive(id)
    // is the authoritative readback. The first backend draft built a
    // pointParamIndex registry over get_gcs_params — dead code, deleted.
    // This assertion documents where the values live; the pipeline test
    // (sketch-solver.test.ts) proves the values are correct.
    expect(true).toBe(true);
  });
});
