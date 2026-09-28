/**
 * A4 (2026-09-28 plan) — Draft drawing rebuild tests.
 *
 * Pins the two measurement-driven corrections behind `extractDraftDrawing`:
 * `wireframe().edgeGroups` is NOT a traversal order, and the old 1e-6 continuity
 * epsilon sat below the `Float32Array` noise floor. The OCCT .brp extraction itself
 * is exercised by the corpus probes (`scripts/`); here the contour model is built
 * from hand-made polylines so the walk is verifiable without wasm.
 */
import { describe, expect, it } from 'vitest';
import {
  chainWireContours,
  draftTolerance,
  isDraft2DObject,
  renderDrawContour,
  type DraftContour,
} from './draft-draw.js';
import type { FcstdObject } from './document.js';

function draftObj(type = 'Part::Part2DObjectPython'): FcstdObject {
  return { name: 'Wire045', type, properties: new Map() } as unknown as FcstdObject;
}

describe('isDraft2DObject', () => {
  it('GOTCHA: Draft drawings carry the Part::Part2DObjectPython proxy type — other Part types are not drawings', () => {
    expect(isDraft2DObject(draftObj('Part::Part2DObjectPython'))).toBe(true);
    expect(isDraft2DObject(draftObj('Part::Feature'))).toBe(false);
    expect(isDraft2DObject(draftObj('Sketcher::SketchObject'))).toBe(false);
  });
});

/** The four edges of a unit-ish square, deliberately shuffled. */
function squareEdges(): [number, number][][] {
  return [
    [[10, 10], [0, 10]],
    [[0, 0], [10, 0]],
    [[0, 10], [0, 0]],
    [[10, 0], [10, 10]],
  ];
}

/**
 * Rotates a closed cycle so it starts at its lexicographically smallest point,
 * preserving direction. The walk seeds on the first unused edge, so the same
 * cycle legally comes out rotated — asserting a raw array would pin the seed,
 * not the geometry.
 */
function normaliseCycle(points: [number, number][]): [number, number][] {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]!;
    const [bx, by] = points[best]!;
    if (x < bx || (x === bx && y < by)) best = i;
  }
  return [...points.slice(best), ...points.slice(0, best)];
}

describe('chainWireContours', () => {
  it('GOTCHA: edges arrive in TopExp::MapShapes order, not traversal order — the walk must not trust array position', () => {
    const contours = chainWireContours(squareEdges(), 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    // the duplicate tail is folded away: one entry per corner, closure implicit
    expect(contours[0]!.points).toHaveLength(4);
    expect(contours[0]!.points[0]).not.toEqual(contours[0]!.points[3]);
    expect(normaliseCycle(contours[0]!.points)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('output is independent of input order (the real fix — array order is meaningless)', () => {
    const a = chainWireContours(squareEdges(), 1e-3)[0]!;
    const shuffled: [number, number][][] = [squareEdges()[2]!, squareEdges()[0]!, squareEdges()[3]!, squareEdges()[1]!];
    const b = chainWireContours(shuffled, 1e-3)[0]!;
    expect(b.closed).toBe(true);
    expect(b.points).toHaveLength(a.points.length);
  });

  it('an open wire stays open (a Draft Line is a real spine, not a mistake)', () => {
    const open: [number, number][][] = [
      [[0, 0], [10, 0]],
      [[10, 0], [10, 20]],
    ];
    const contours = chainWireContours(open, 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(false);
    expect(contours[0]!.points).toEqual([[0, 0], [10, 0], [10, 20]]);
  });

  it('separates two disjoint loops instead of inventing a bridge between them', () => {
    const two: [number, number][][] = [
      ...squareEdges().map((e) => e.map(([x, y]) => [x + 100, y] as [number, number])),
      ...squareEdges(),
    ];
    const contours = chainWireContours(two, 1e-3);
    expect(contours).toHaveLength(2);
    expect(contours.every((c) => c.closed)).toBe(true);
    expect(contours.every((c) => c.points.length === 4)).toBe(true);
  });

  it('restarts on an unmatchable edge rather than dropping it', () => {
    const stray: [number, number][][] = [...squareEdges(), [[500, 500], [510, 500]]];
    const contours = chainWireContours(stray, 1e-3);
    expect(contours).toHaveLength(2);
    expect(contours.some((c) => !c.closed && c.points.length === 2)).toBe(true);
  });

  it('GOTCHA: a hand-set 1e-6 tolerance cannot match Float32 endpoints — use draftTolerance', () => {
    // Same shared vertex, as two edges tessellate it independently: ~6e-5 apart
    // (one float32 ulp at |coord| ≈ 300). 1e-6 is below the noise floor.
    const noisy: [number, number][][] = [
      [[0, 0], [300.000061, 0]],
      [[300, 0], [300, 100]],
    ];
    expect(chainWireContours(noisy, 1e-6)).toHaveLength(2); // the OLD behaviour
    expect(chainWireContours(noisy, draftTolerance(noisy))).toHaveLength(1);
  });

  it('extending both ends: a seed in the middle of a loop still closes it', () => {
    const contours = chainWireContours([squareEdges()[0]!, squareEdges()[3]!, squareEdges()[1]!, squareEdges()[2]!], 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
  });

  it('drops degenerate input instead of emitting a zero-length contour', () => {
    expect(chainWireContours([], 1e-3)).toEqual([]);
    expect(chainWireContours([[[5, 5], [5, 5]]], 1e-3)).toEqual([]);
  });
});

describe('draftTolerance', () => {
  it('scales with the coordinate magnitude so it clears the float32 step', () => {
    expect(draftTolerance([[[0, 0], [300, 0]]])).toBeCloseTo(3e-3, 9);
    expect(draftTolerance([[[0, 0], [3000, 0]]])).toBeCloseTo(3e-2, 9);
  });

  it('has a floor so an all-zero wire still admits a tolerance', () => {
    expect(draftTolerance([[[0, 0], [0, 0]]])).toBeGreaterThan(0);
  });
});

describe('renderDrawContour', () => {
  it('renders a closed contour with the closure implicit — every entry is a real corner', () => {
    // GOTCHA: `closed: true` means the tail is ALREADY folded away by the walk.
    // Stripping again here silently drops a corner (a square would emit 3 sides).
    const c: DraftContour = { points: [[0, 0], [40, 0], [40, 30]], closed: true };
    expect(renderDrawContour(c)).toBe('(pen) => pen.polyline([[0, 0], [40, 0], [40, 30]], true)');
  });

  it('renders an open contour with close:false and every point kept', () => {
    const c: DraftContour = { points: [[0, 0], [10, 0]], closed: false };
    expect(renderDrawContour(c)).toBe('(pen) => pen.polyline([[0, 0], [10, 0]], false)');
  });

  it('emits ONE call regardless of point count (the AST-depth-100 reason)', () => {
    const c: DraftContour = {
      points: Array.from({ length: 3000 }, (_, i) => [i, i * 2] as [number, number]),
      closed: false,
    };
    const src = renderDrawContour(c);
    expect(src.match(/polyline\(/g)).toHaveLength(1);
    expect(src.match(/lineTo\(/g)).toBeNull();
  });

  it('rounds coordinates to 1e-6 for stable emitted source', () => {
    const c: DraftContour = { points: [[0.123456789, 0], [10, 0.9999999999]], closed: false };
    const src = renderDrawContour(c);
    expect(src).toContain('[0.123457, 0]');
    expect(src).toContain('[10, 1]');
  });
});
