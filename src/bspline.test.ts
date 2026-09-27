/**
 * P4 — B-spline sketch geometry tests (Mannequin corpus, Sketch061 et al.).
 *
 * GOTCHA: FreeCAD stores BSplineCurve poles/knots as CHILD ELEMENTS
 * (<Pole X= Y=/>, <Knot Value= Mult=/>), not attributes — the counts
 * (PolesCount/KnotsCount) are attributes. Reading attributes for poles
 * returns NaN, which used to cascade into `unsupported-geometry` and bake
 * 75 features across the Mannequin file (13 Revolution + 26 Groove + ...).
 *
 * GOTCHA 2 (2026-09-27): the knot multiplicity attribute is `Mult`, NOT
 * `Multiplicity`. A 500-file / 3190-`<Knot>` corpus scan found `Mult`
 * exclusively; reading the wrong name silently collapsed every knot vector to
 * its distinct values. See the `Knot` fixtures below (they must use `Mult`).
 */
import { describe, expect, it } from 'vitest';
import { evalBSpline, sampleBSpline, bsplineToSegments, type BSplineCurveData } from '@faicad/faijs-sketch';
import { parseGeometryList } from './sketch-parse.js';
import { extractContours } from '@faicad/faijs-sketch';
import { anchorPoints } from '@faicad/faijs-sketch';
import type { FcstdProperty } from './document.js';

// ── helpers ──

function quadBezierCtl(): BSplineCurveData {
  // degree-2 "quadratic Bézier" as a B-spline: 3 poles, clamped knots
  // [0,0,0,1,1,1] — evaluation must hit the poles at t=0/1 and midpoint
  // (0.25,0.5) at t=0.5 for poles (0,0),(0,1),(1,1).
  return {
    poles: [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    knots: [0, 0, 0, 1, 1, 1],
    degree: 2,
    periodic: false,
  };
}

// ── bspline.ts evaluation ──

/**
 * A MULTI-SPAN cubic (5 poles, degree 3, 2 spans). The existing fixtures are
 * all single-span (`poles.length === degree + 1`), where the last span index is
 * `degree` — the value the old span search defaulted to — so they could not
 * detect the right-boundary bug (see the regression test below).
 */
function cubicMultiSpan(): BSplineCurveData {
  return {
    poles: [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 2 },
      { x: 4, y: 0 },
    ],
    // clamped, len 9 === poles(5) + degree(3) + 1 → spans k = 3 and k = 4
    knots: [0, 0, 0, 0, 0.5, 1, 1, 1, 1],
    degree: 3,
    periodic: false,
  };
}

describe('evalBSpline (Cox–de Boor)', () => {
  it('GOTCHA: clamped spline interpolates first/last poles exactly', () => {
    const d = quadBezierCtl();
    expect(evalBSpline(d, 0)).toEqual({ x: 0, y: 0 });
    expect(evalBSpline(d, 1)).toEqual({ x: 1, y: 1 });
  });

  it('GOTCHA: right boundary of a MULTI-SPAN spline is the last pole', () => {
    // Regression (2026-09-27): the span search tested `u < knots[i+1]`, which
    // never matches at `u === hi`, so the loop fell through to its `k = degree`
    // default — the FIRST span — and `evalBSpline(hi)` extrapolated off the
    // leading control polygon (here it returned (4,-1) instead of (4,0)).
    // `sampleBSpline` samples t = hi exactly, so every spline's proxy END
    // jumped, line+spline chains in `extractContours` stopped closing, and
    // 15 sketches in the Mannequin file gapped `sketch-solved-no-closed-loop`.
    const d = cubicMultiSpan();
    expect(evalBSpline(d, 1)).toEqual({ x: 4, y: 0 });
    expect(evalBSpline(d, 0)).toEqual({ x: 0, y: 0 });
  });

  it('midpoint of a quadratic Bézier spline is the Bernstein point', () => {
    const d = quadBezierCtl();
    const m = evalBSpline(d, 0.5);
    expect(m.x).toBeCloseTo(0.25, 10);
    expect(m.y).toBeCloseTo(0.75, 10);
  });

  it('parameter outside domain is clamped (no NaN)', () => {
    const d = quadBezierCtl();
    expect(evalBSpline(d, -5)).toEqual({ x: 0, y: 0 });
    expect(evalBSpline(d, 5)).toEqual({ x: 1, y: 1 });
  });
});

describe('sampleBSpline / bsplineToSegments', () => {
  it('returns at least pole-count samples with exact endpoints', () => {
    const d = quadBezierCtl();
    const pts = sampleBSpline(d, 6);
    expect(pts.length).toBeGreaterThanOrEqual(3);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 1, y: 1 });
  });

  it('segments chain head-to-tail (contour junction requirement)', () => {
    const d = quadBezierCtl();
    const segs = bsplineToSegments(d);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.x1).toBeCloseTo(segs[i - 1]!.x2, 10);
      expect(segs[i]!.y1).toBeCloseTo(segs[i - 1]!.y2, 10);
    }
  });

  it('multi-span spline samples end exactly on the last pole', () => {
    // same right-boundary regression, at the sampling layer `extractContours`
    // consumes (its spline proxy endpoints come from bsplineToSegments).
    const d = cubicMultiSpan();
    const pts = sampleBSpline(d, 6);
    expect(pts[pts.length - 1]).toEqual({ x: 4, y: 0 });
    const segs = bsplineToSegments(d, 6);
    expect(segs[segs.length - 1]).toEqual({ x1: segs[segs.length - 1]!.x1, y1: segs[segs.length - 1]!.y1, x2: 4, y2: 0 });
  });

  it('degenerate knots fall back to the control polygon (no crash)', () => {
    const d: BSplineCurveData = { poles: [{ x: 0, y: 0 }, { x: 1, y: 1 }], knots: [], degree: 3, periodic: false };
    const segs = bsplineToSegments(d);
    expect(segs).toEqual([{ x1: 0, y1: 0, x2: 1, y2: 1 }]);
  });
});

// ── sketch-parse.ts BSplineCurve branch ──

function mkChild(tagName: string, attributes: Record<string, string | number>, children: FcstdProperty[] = []): FcstdProperty {
  return { tagName, attributes, children, name: '', type: '' } as unknown as FcstdProperty;
}

describe('parseSketchGeometry: BSplineCurve (P4)', () => {
  it('GOTCHA: poles/knots are child elements, not attributes', () => {
    // mirrors Sketch061 shape: 7 poles, 5 knots (4 + interior mult-1... use
    // clamped cubic 7 poles → knots [0,0,0,0,1,2,3,3,3,3] = 10 entries)
    const poles = [
      [0, 0], [10, 0], [20, 5], [30, 10], [40, 5], [50, 0], [60, 0],
    ].map(([x, y]) => mkChild('Pole', { X: x, Y: y, Z: 0 }));
    const knotVals: [number, number][] = [[0, 4], [1, 1], [2, 1], [3, 4]];
    // GOTCHA: the real FCStd attribute is `Mult` (see file header). Using
    // `Multiplicity` here is what let the collapse bug ship.
    const knots = knotVals.map(([v, m]) => mkChild('Knot', { Value: v, Mult: m }));
    const geom = mkChild('BSplineCurve', { PolesCount: 7, KnotsCount: 4, Degree: 3, IsPeriodic: 0 }, [
      ...poles,
      ...knots,
    ]);
    const out = parseGeometryList({ tagName: 'Property', name: 'Geometry', type: 'Part::PropertyGeometryList', attributes: {}, children: [mkChild('GeometryList', {}, [mkChild('Geometry', { type: 'Part::GeomBSplineCurve' }, [geom])])] } as unknown as FcstdProperty);
    expect(out.length).toBe(1);
    const g = out[0]!;
    expect(g.kind).toBe('bspline');
    if (g.kind !== 'bspline') return;
    expect(g.poles.length).toBe(7);
    expect(g.degree).toBe(3);
    expect(g.periodic).toBe(false);
    // multiplicity expanded: 4+1+1+4 = 10 knots
    expect(g.knots).toEqual([0, 0, 0, 0, 1, 2, 3, 3, 3, 3]);
    // endpoints = first/last pole
    expect(g.x1).toBe(0);
    expect(g.y1).toBe(0);
    expect(g.x2).toBe(60);
    expect(g.y2).toBe(0);
  });

  it('bspline anchors feed maxPointDistance comparison (verify path)', () => {
    const g = {
      kind: 'bspline' as const, index: 0,
      poles: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      knots: [0, 0, 0, 0, 1, 1, 1, 1], degree: 3, periodic: false,
      x1: 0, y1: 0, z1: 0, x2: 1, y2: 1, z2: 0,
    };
    const anchors = anchorPoints(g);
    expect(anchors).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('accepts the legacy `Multiplicity` attribute as a fallback', () => {
    // `Mult` is the real FCStd name (see the test above); hand-written
    // fixtures used `Multiplicity`, so the fallback is kept for them.
    const poles = [[0, 0], [10, 0], [20, 5], [30, 10], [40, 5], [50, 0], [60, 0]]
      .map(([x, y]) => mkChild('Pole', { X: x, Y: y, Z: 0 }));
    const knots = ([[0, 4], [1, 1], [2, 1], [3, 4]] as [number, number][])
      .map(([v, m]) => mkChild('Knot', { Value: v, Multiplicity: m }));
    const geom = mkChild('BSplineCurve', { PolesCount: 7, KnotsCount: 4, Degree: 3, IsPeriodic: 0 }, [
      ...poles,
      ...knots,
    ]);
    const out = parseGeometryList({ tagName: 'Property', name: 'Geometry', type: 'Part::PropertyGeometryList', attributes: {}, children: [mkChild('GeometryList', {}, [mkChild('Geometry', { type: 'Part::GeomBSplineCurve' }, [geom])])] } as unknown as FcstdProperty);
    const g = out[0]!;
    if (g.kind !== 'bspline') throw new Error('expected bspline');
    expect(g.knots).toEqual([0, 0, 0, 0, 1, 2, 3, 3, 3, 3]);
  });
});

// ── contour.ts spline flattening ──

describe('extractContours: bspline flattening (P4)', () => {
  it('spline interior is preserved in the chained contour (no pseudo-seg loss)', () => {
    // spline along y=x² from (0,0) to (2,4), approximated as a degree-3
    // clamped B-spline via its poles; contour closes back along the bottom edge.
    // Build spline data for y = x² sampled: poles chosen so the curve passes
    // (0,0), (1,1), (2,4): use interpolation-style poles (deg 3 clamped, 4 poles).
    const spline = {
      kind: 'bspline' as const, index: 0,
      // cubic Bézier through those points: poles (0,0),(0,2/3),(4/3,8/3)... —
      // simpler: verify structurally instead of exact math: endpoints + closure.
      poles: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1.5, y: 2.5 }, { x: 2, y: 4 }],
      knots: [0, 0, 0, 0, 1, 1, 1, 1], degree: 3, periodic: false,
      x1: 0, y1: 0, z1: 0, x2: 2, y2: 4, z2: 0,
    };
    const bottom = {
      kind: 'line' as const, index: 1,
      x1: 2, y1: 4, z1: 0, x2: 0, y2: 0, z2: 0,
    };
    const contours = extractContours([spline, bottom]);
    expect(contours.length).toBe(1);
    const segs = contours[0]!.segments;
    // spline contributes MANY sub-segments (not one pseudo line), plus the bottom line
    expect(segs.length).toBeGreaterThan(3);
    // closure: first seg starts at spline start, last seg ends back there
    expect(segs[0]!.x1).toBeCloseTo(0, 10);
    expect(segs[0]!.y1).toBeCloseTo(0, 10);
    const last = segs[segs.length - 1]!;
    expect(last.x2).toBeCloseTo(0, 10);
    expect(last.y2).toBeCloseTo(0, 10);
    // interior preserved: some segment mid-point is off the chord (0,0)-(2,4)
    const chord = (x: number) => 2 * x;
    const interior = segs.slice(0, -1).some((s) => Math.abs((s.y1 + s.y2) / 2 - chord((s.x1 + s.x2) / 2)) > 0.01);
    expect(interior).toBe(true);
  });
});
