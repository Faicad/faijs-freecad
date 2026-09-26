/**
 * M3.6/M3.7 tests — contour extraction from solved geometry and the
 * three-level downgrade ledger entry (D3).
 */
import { describe, it, expect } from 'vitest';
import { extractContours } from '@faicad/faijs-sketch';
import { classifySketch } from '@faicad/faijs-sketch';
import type { FcstdSketchGeom as SketchGeom } from '@faicad/faijs-sketch';

describe('contour extraction (M3.6)', () => {
  it('chains a rectangle from 4 line segments into one closed contour', () => {
    const geoms: SketchGeom[] = [
      { kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 10, y2: 0, z2: 0 },
      { kind: 'line', index: 1, x1: 10, y1: 0, z1: 0, x2: 10, y2: 5, z2: 0 },
      { kind: 'line', index: 2, x1: 10, y1: 5, z1: 0, x2: 0, y2: 5, z2: 0 },
      { kind: 'line', index: 3, x1: 0, y1: 5, z1: 0, x2: 0, y2: 0, z2: 0 },
    ];
    const contours = extractContours(geoms);
    expect(contours.length).toBe(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.segments.length).toBe(4);
  });

  it('yields one self-closed contour per circle', () => {
    const geoms: SketchGeom[] = [{ kind: 'circle', index: 0, cx: 1, cy: 2, cz: 0, radius: 3 }];
    const contours = extractContours(geoms);
    expect(contours.length).toBe(1);
    expect(contours[0]!.segments[0]!.kind).toBe('arc');
  });

  it('leaves open chains out of the contour set', () => {
    const geoms: SketchGeom[] = [
      { kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 10, y2: 0, z2: 0 },
      { kind: 'line', index: 1, x1: 10, y1: 0, z1: 0, x2: 10, y2: 5, z2: 0 },
    ];
    expect(extractContours(geoms).length).toBe(0);
  });

  it('GOTCHA (slittingsaw/tap corpus 2026-09-20): once the chain closes at the head, STOP — free segments touching the head must not break the loop', () => {
    // tap profile: segments 0-5 form a closed loop through (0,0)=head, but
    // seg8 (0,0→-4,4, free) also touches the head. The linker used to keep
    // extending after closure, the free segment stole the chain and the
    // closed 6-segment loop was dropped (contours: 0, solver was fine —
    // "sketch-not-solved" was a lie).
    const geoms: SketchGeom[] = [
      { kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 4, y2: 4, z2: 0 },
      { kind: 'line', index: 1, x1: 4, y1: 4, z1: 0, x2: 4, y2: 29, z2: 0 },
      { kind: 'line', index: 2, x1: 4, y1: 29, z1: 0, x2: 3, y2: 29, z2: 0 },
      { kind: 'line', index: 3, x1: 3, y1: 29, z1: 0, x2: 3, y2: 60, z2: 0 },
      { kind: 'line', index: 4, x1: 3, y1: 60, z1: 0, x2: 0, y2: 60, z2: 0 },
      { kind: 'line', index: 5, x1: 0, y1: 60, z1: 0, x2: 0, y2: 0, z2: 0 },
      { kind: 'line', index: 6, x1: -3, y1: 60, z1: 0, x2: 3, y2: 60, z2: 0 }, // free
      { kind: 'line', index: 7, x1: 4, y1: 29, z1: 0, x2: -4, y2: 29, z2: 0 }, // free
      { kind: 'line', index: 8, x1: 0, y1: 0, z1: 0, x2: -4, y2: 4, z2: 0 }, // touches head
    ];
    const contours = extractContours(geoms);
    expect(contours.length).toBe(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.segments.length).toBe(6);
  });

  it('GOTCHA (slittingsaw corpus 2026-09-20): a dead-end branch must not sink the chain — the seed enumerates alternatives until a loop closes', () => {
    // slittingsaw's 11-line profile: several segments share the y=0 axis with
    // free branches (seg2 spans the whole axis; seg7/seg8 form a notch).
    // First-come chaining picked seg2's far endpoint (-50,0) — a dead end —
    // and the whole chain died open. The linker must retry alternative
    // continuations at junction points until one branch closes the loop.
    const geoms: SketchGeom[] = [
      { kind: 'line', index: 0, x1: 0, y1: 50, z1: 0, x2: 0, y2: -3, z2: 0 },
      { kind: 'line', index: 1, x1: 7.5, y1: 50, z1: 0, x2: 0, y2: 50, z2: 0 },
      { kind: 'line', index: 2, x1: 50, y1: 0, z1: 0, x2: -50, y2: 0, z2: 0 },
      { kind: 'line', index: 3, x1: 7.5, y1: 3, z1: 0, x2: 50, y2: 3, z2: 0 },
      { kind: 'line', index: 4, x1: 7.5, y1: 50, z1: 0, x2: 7.5, y2: 3, z2: 0 },
      { kind: 'line', index: 5, x1: -7.5, y1: 49.99999999999999, z1: 0, x2: 7.5, y2: 50, z2: 0 },
      { kind: 'line', index: 6, x1: 50, y1: 3, z1: 0, x2: 50, y2: 0, z2: 0 },
      { kind: 'line', index: 7, x1: 50, y1: 0, z1: 0, x2: 4, y2: 0, z2: 0 },
      { kind: 'line', index: 8, x1: 4, y1: 0, z1: 0, x2: 4, y2: -3, z2: 0 },
      { kind: 'line', index: 9, x1: 4, y1: -3, z1: 0, x2: 0, y2: -3, z2: 0 },
      { kind: 'line', index: 10, x1: -4, y1: -3, z1: 0, x2: 4, y2: -3, z2: 0 },
    ];
    const contours = extractContours(geoms);
    const loop = contours.find((c) => c.segments.length >= 8);
    expect(loop).toBeDefined();
    expect(loop!.closed).toBe(true);
  });

  it('chains a line+arc contour regardless of segment order', () => {
    const geoms: SketchGeom[] = [
      // arc from (10,0) to (0,0), semicircle over the line
      { kind: 'arc', index: 0, cx: 5, cy: 0, cz: 0, radius: 5, startAngle: 0, endAngle: Math.PI, x1: 10, y1: 0, z1: 0, x2: 0, y2: 0, z2: 0 },
      { kind: 'line', index: 1, x1: 0, y1: 0, z1: 0, x2: 10, y2: 0, z2: 0 },
    ];
    const contours = extractContours(geoms);
    expect(contours.length).toBe(1);
    expect(contours[0]!.closed).toBe(true);
  });

  it('GOTCHA (ballend corpus 2026-09-20): tail must re-scan from the pool start — a later-indexed segment touching an INTERMEDIATE tail must not steal the chain', () => {
    // Minimal repro of the ballend tool-bit sketch failure: the greedy
    // linker used to keep scanning the pool with a drifted tail in the same
    // pass, so a later-indexed segment whose endpoint coincides with the
    // DRIFTED tail (line6 at y=50) stole the chain before the correct
    // earlier-indexed continuation (line2, also at y=50) was reached — the
    // loop broke and extractContours returned 0 for a perfectly closed
    // 6-segment profile (arc + 5 lines).
    const geoms: SketchGeom[] = [
      { kind: 'line', index: 0, x1: -1e-15, y1: 50, z1: 0, x2: -1e-15, y2: 0, z2: 0 }, // axis (unfiltered free seg)
      { kind: 'line', index: 1, x1: 2.5, y1: 2.5, z1: 0, x2: 2.5, y2: 40, z2: 0 },
      { kind: 'line', index: 2, x1: 1.5, y1: 50, z1: 0, x2: -9e-16, y2: 50, z2: 0 },
      { kind: 'line', index: 3, x1: 2.5, y1: 0, z1: 0, x2: -2.5, y2: 0, z2: 0 }, // free seg at y=0
      { kind: 'line', index: 4, x1: 1.5, y1: 40.01, z1: 0, x2: 2.5, y2: 40, z2: 0 },
      { kind: 'line', index: 5, x1: 1.5, y1: 50, z1: 0, x2: 1.5, y2: 40.01, z2: 0 },
      { kind: 'line', index: 6, x1: -1.5, y1: 50, z1: 0, x2: 1.5, y2: 50, z2: 0 }, // thief at y=50
      { kind: 'arc', index: 7, x1: -9.59e-16, y1: 0, z1: 0, x2: 2.5, y2: 2.5, z2: 0, cx: -5e-16, cy: 2.5, cz: 0, radius: 2.5, startAngle: Math.PI, endAngle: 1.5 * Math.PI },
    ];
    const contours = extractContours(geoms);
    // the closed profile loop must still be found despite the free segments
    expect(contours.length).toBeGreaterThanOrEqual(1);
    const loop = contours.find((c) => c.segments.length >= 5);
    expect(loop).toBeDefined();
    expect(loop!.closed).toBe(true);
  });
});

describe('three-level downgrade (M3.7, D3)', () => {
  it('classifies solved+matching as L0', () => {
    const v = classifySketch({ geoms: [], converged: true, problemConstraints: [], droppedConstraints: [] }, [], 1e-6);
    expect(v.level).toBe('L0');
  });
  it('classifies divergence as L1 with reason', () => {
    const stored: SketchGeom[] = [{ kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 10, y2: 0, z2: 0 }];
    const solved: SketchGeom[] = [{ kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 50, y2: 0, z2: 0 }];
    const v = classifySketch({ geoms: solved, converged: true, problemConstraints: [], droppedConstraints: [] }, stored, 1e-6);
    expect(v.level).toBe('L1');
    expect(v.reason).toBe('delta-exceeds-t1');
  });
});
