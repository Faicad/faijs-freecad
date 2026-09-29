/**
 * A1 (2026-09-29 plan) — Draft drawing rebuild tests.
 *
 * Three rebuild strategies were tried on this pipeline and only the third is
 * correct, so this file pins the failure modes of the first two as much as it
 * pins the current one:
 *
 * 1. `wireframe().edgeGroups` is NOT a traversal order → chaining consecutive
 *    entries shattered wires (pinned below).
 * 2. The continuity tolerance must clear the `Float32Array` noise floor of the
 *    tessellated fallback (pinned below).
 * 3. The rebuild must keep ANALYTIC geometry analytic: reading a Draft object's
 *    `.brp`, tessellating every curve and emitting one polyline turned 168
 *    analytic edges of `Sprocket ANSI simplex 1¾x1¼ z21` into 7010 points, and
 *    OCC never finished the wire. The pure helpers below (circumcircle /
 *    arcSegment / reverseSegment / snapContour) are the parts of that fix that
 *    can be verified without wasm; the end-to-end half lives in
 *    `draft-analytic-e2e.test.ts` and `scripts/probe-draw-analytic.ts`.
 * 4. Closure decides the run-time SHAPE, so it has to be right: a closed contour
 *    is a profile (`cad.sketchOnPlane` → face) and an open one is a path (a
 *    `cad.sweep` spine), and OCCT refuses to build a face from an open wire. The
 *    `chainDraftEdges` cases at the end of this file pin the three ways that went
 *    wrong (edge-count closure test, endpoint-span extent guard, and the
 *    superseded form's habit of closing every contour); the emission split is
 *    pinned in `codegen.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  arcSegment,
  chainDraftEdges,
  circumcircle,
  draftTolerance,
  isDraft2DObject,
  lineSegment,
  reverseSegment,
  segmentEnd,
  segmentStart,
  snapContour,
  type DraftArcSegment,
  type DraftContour,
  type DraftEdge,
  type DraftSegment,
  type DraftSplineSegment,
  type Point2,
} from './draft-draw.js';
import type { FcstdObject } from './document.js';

function draftObj(type = 'Part::Part2DObjectPython'): FcstdObject {
  return { name: 'Wire045', type, properties: new Map() } as unknown as FcstdObject;
}

/**
 * One edge whose geometry is a straight run through `points` — the shape a
 * tessellated (fallback) edge has. The chaining tests are about the WALK, so
 * straight runs keep them about the walk.
 */
function piece(points: Point2[]): DraftEdge {
  return {
    a: points[0]!,
    b: points[points.length - 1]!,
    segments: points.slice(1).map((p, i) => lineSegment(points[i]!, p)),
  };
}

/**
 * The corner list a contour describes: first start, then every segment's end.
 *
 * GOTCHA: the old contour model folded a closed loop's duplicate tail away (it
 * stored points, so the returning point had to be dropped or `polyline(…, true)`
 * would emit a degenerate side — a square would come out with 5 corners). A
 * segment loop carries closure implicitly, so the duplicate is still THERE and
 * has to be folded here, or every closed-cycle assertion gains a phantom corner.
 */
function contourPoints(c: DraftContour): Point2[] {
  const pts = [segmentStart(c.segments[0]!), ...c.segments.map(segmentEnd)];
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const returns = first[0] === last[0] && first[1] === last[1];
  return c.closed && pts.length > 1 && returns ? pts.slice(0, -1) : pts;
}

/**
 * The geometric midpoint of an arc, computed exactly the way
 * `profileSegToCurve` computes it (sweep normalization included) — so an
 * assertion here pins what the RUN TIME will actually build, not a convenient
 * re-derivation of our own.
 */
function arcMidpoint(s: DraftArcSegment): Point2 {
  let sweep = s.ccw ? s.endAngle - s.startAngle : s.startAngle - s.endAngle;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  const mid = s.ccw ? s.startAngle + sweep / 2 : s.startAngle - sweep / 2;
  return [s.cx + s.radius * Math.cos(mid), s.cy + s.radius * Math.sin(mid)];
}

describe('isDraft2DObject', () => {
  it('GOTCHA: Draft drawings carry the Part::Part2DObjectPython proxy type — other Part types are not drawings', () => {
    expect(isDraft2DObject(draftObj('Part::Part2DObjectPython'))).toBe(true);
    expect(isDraft2DObject(draftObj('Part::Feature'))).toBe(false);
    expect(isDraft2DObject(draftObj('Sketcher::SketchObject'))).toBe(false);
  });
});

/** The four edges of a unit-ish square, deliberately shuffled. */
function squareEdges(): DraftEdge[] {
  return [
    piece([[10, 10], [0, 10]]),
    piece([[0, 0], [10, 0]]),
    piece([[0, 10], [0, 0]]),
    piece([[10, 0], [10, 10]]),
  ];
}

/**
 * Rotates a closed cycle so it starts at its lexicographically smallest point,
 * preserving direction. The walk seeds on the first unused edge, so the same
 * cycle legally comes out rotated — asserting a raw array would pin the seed,
 * not the geometry.
 */
function normaliseCycle(points: Point2[]): Point2[] {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i]!;
    const [bx, by] = points[best]!;
    if (x < bx || (x === bx && y < by)) best = i;
  }
  return [...points.slice(best), ...points.slice(0, best)];
}

describe('chainDraftEdges', () => {
  it('GOTCHA: edges arrive in TopExp::MapShapes order, not traversal order — the walk must not trust array position', () => {
    const contours = chainDraftEdges(squareEdges(), 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    // One segment per edge and NO folded duplicate tail: closure is implicit in a
    // segment loop, so a square is 4 segments (the polyline form needed 4 points
    // plus the flag).
    expect(contours[0]!.segments).toHaveLength(4);
    expect(normaliseCycle(contourPoints(contours[0]!))).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });

  it('output is independent of input order (the real fix — array order is meaningless)', () => {
    const a = chainDraftEdges(squareEdges(), 1e-3)[0]!;
    const shuffled: DraftEdge[] = [squareEdges()[2]!, squareEdges()[0]!, squareEdges()[3]!, squareEdges()[1]!];
    const b = chainDraftEdges(shuffled, 1e-3)[0]!;
    expect(b.closed).toBe(true);
    expect(b.segments).toHaveLength(a.segments.length);
  });

  it('an open wire stays open (a Draft Line is a real spine, not a mistake)', () => {
    const open: DraftEdge[] = [piece([[0, 0], [10, 0]]), piece([[10, 0], [10, 20]])];
    const contours = chainDraftEdges(open, 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(false);
    expect(contourPoints(contours[0]!)).toEqual([[0, 0], [10, 0], [10, 20]]);
  });

  // A1 follow-up (2026-09-29): closure is a property of the EMITTED geometry, not
  // of how many edges the walk happened to visit. The first rule also required
  // `chain.length > 1`, which misreported two real contours of
  // Kitchen_cabinet_base as open — one of them a closed outline, one a sliver.
  it('GOTCHA: a closed loop stored as ONE edge still closes (Kitchen_cabinet_base Clone2D001)', () => {
    // A closed B-spline outline is a single edge; its tessellated fallback is one
    // long run that returns to where it started. `chain.length > 1` called that
    // open, and codegen would then have emitted it as a spine instead of a face.
    const run = piece([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    const contours = chainDraftEdges([run], 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.segments).toHaveLength(4);
    // The closing vertex is ONE number on both sides, or the wire does not sew.
    expect(segmentEnd(contours[0]!.segments.at(-1)!)).toEqual(segmentStart(contours[0]!.segments[0]!));
  });

  it('a single full-circle edge closes (startAngle === endAngle is still a closed run)', () => {
    const a0 = 0.7;
    const full: DraftArcSegment = {
      kind: 'arc', cx: 0, cy: 0, radius: 5, startAngle: a0, endAngle: a0, ccw: true,
      x1: 5 * Math.cos(a0), y1: 5 * Math.sin(a0), x2: 5 * Math.cos(a0), y2: 5 * Math.sin(a0),
    };
    const contours = chainDraftEdges([{ a: [full.x1, full.y1], b: [full.x2, full.y2], segments: [full] }], 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
  });

  it('GOTCHA: a two-segment sliver IS a closed loop (Kitchen_cabinet_base Clone2D017)', () => {
    // The source stores a→b→a: a degenerate but genuinely closed contour. The old
    // rule's `near()` on raws plus the edge-count guard called it open.
    const contours = chainDraftEdges([piece([[0, 0], [10, 0], [0, 0]])], 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.segments).toHaveLength(2);
  });

  it('REGRESSION: an open contour is never silently closed', () => {
    // The superseded A4 form ended every `cad.draw` session with
    // `BlueprintSketcher.close()`, so EVERY contour gained a closing segment and
    // an open sweep spine (Kitchen_cabinet_base `Clone2D004/010`) came out as a
    // loop. A1 keeps it open: codegen is what turns `closed:false` into `as:'wire'`.
    const contours = chainDraftEdges([piece([[0, 0], [10, 0], [10, 20]])], 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(false);
    expect(contours[0]!.segments).toHaveLength(2); // no appended closing segment
    expect(segmentEnd(contours[0]!.segments.at(-1)!)).toEqual([10, 20]);
  });

  it('separates two disjoint loops instead of inventing a bridge between them', () => {
    const two: DraftEdge[] = [
      ...squareEdges().map((e) => piece([[e.a[0] + 100, e.a[1]], [e.b[0] + 100, e.b[1]]])),
      ...squareEdges(),
    ];
    const contours = chainDraftEdges(two, 1e-3);
    expect(contours).toHaveLength(2);
    expect(contours.every((c) => c.closed)).toBe(true);
    expect(contours.every((c) => c.segments.length === 4)).toBe(true);
  });

  it('restarts on an unmatchable edge rather than dropping it', () => {
    const stray: DraftEdge[] = [...squareEdges(), piece([[500, 500], [510, 500]])];
    const contours = chainDraftEdges(stray, 1e-3);
    expect(contours).toHaveLength(2);
    expect(contours.some((c) => !c.closed && contourPoints(c).length === 2)).toBe(true);
  });

  it('GOTCHA: a hand-set 1e-6 tolerance cannot match Float32 endpoints — use draftTolerance', () => {
    // Same shared vertex, as two edges tessellate it independently: ~6e-5 apart
    // (one float32 ulp at |coord| ≈ 300). 1e-6 is below the noise floor.
    const noisy: DraftEdge[] = [piece([[0, 0], [300.000061, 0]]), piece([[300, 0], [300, 100]])];
    expect(chainDraftEdges(noisy, 1e-6)).toHaveLength(2); // the OLD behaviour
    expect(chainDraftEdges(noisy, draftTolerance(noisy))).toHaveLength(1);
  });

  it('extending both ends: a seed in the middle of a loop still closes it', () => {
    const edges = [squareEdges()[0]!, squareEdges()[3]!, squareEdges()[1]!, squareEdges()[2]!];
    const contours = chainDraftEdges(edges, 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
  });

  it('drops degenerate input instead of emitting a zero-length contour', () => {
    expect(chainDraftEdges([], 1e-3)).toEqual([]);
    expect(chainDraftEdges([piece([[5, 5], [5, 5]])], 1e-3)).toEqual([]);
  });

  it('GOTCHA: an edge met tail-first is REVERSED, and reversing an arc must flip `ccw`', () => {
    // The walk enters the straight edge (0,0) → (10,0) first, so the arc — stored
    // from (-10,0) to (10,0), bulging up — joins the chain BACKWARDS. Reversing
    // its endpoints without flipping `ccw` moves the bulge below the chord: a
    // different shape, and the `sketch-arc-ccw-gotcha` hang at run time.
    const arc = arcSegment([-10, 0], [0, 10], [10, 0])!;
    const contours = chainDraftEdges(
      [
        { a: [0, 0], b: [10, 0], segments: [lineSegment([0, 0], [10, 0])] },
        { a: [-10, 0], b: [10, 0], segments: [arc] },
      ],
      1e-6,
    );
    expect(contours).toHaveLength(1);
    const arcSegs = contours[0]!.segments.filter((s): s is DraftArcSegment => s.kind === 'arc');
    expect(arcSegs).toHaveLength(1);
    const seg = arcSegs[0]!;
    expect(seg.ccw).toBe(!arc.ccw);
    const mid = arcMidpoint(seg);
    expect(mid[0]).toBeCloseTo(0, 6);
    expect(mid[1]).toBeCloseTo(10, 6); // still bulging UP, i.e. y ≈ +10
  });
});

describe('draftTolerance', () => {
  it('scales with the coordinate magnitude so it clears the float32 step', () => {
    expect(draftTolerance([piece([[0, 0], [300, 0]])])).toBeCloseTo(3e-3, 9);
    expect(draftTolerance([piece([[0, 0], [3000, 0]])])).toBeCloseTo(3e-2, 9);
  });

  it('has a floor so an all-zero wire still admits a tolerance', () => {
    expect(draftTolerance([piece([[0, 0], [0, 0]])])).toBeGreaterThan(0);
  });
});

describe('circumcircle', () => {
  it('finds the center and radius of the circle through three points', () => {
    const c = circumcircle([10, 0], [0, 10], [-10, 0])!;
    expect(c.cx).toBeCloseTo(0, 9);
    expect(c.cy).toBeCloseTo(0, 9);
    expect(c.radius).toBeCloseTo(10, 9);
  });

  it('returns undefined for collinear points (no circle exists)', () => {
    expect(circumcircle([0, 0], [5, 5], [10, 10])).toBeUndefined();
  });
});

describe('arcSegment', () => {
  it('builds an arc with the center, radius and start/end angles', () => {
    const q = Math.SQRT1_2 * 10;
    const seg = arcSegment([10, 0], [q, q], [0, 10])!;
    expect(seg.cx).toBeCloseTo(0, 9);
    expect(seg.cy).toBeCloseTo(0, 9);
    expect(seg.radius).toBeCloseTo(10, 9);
    expect(seg.startAngle).toBeCloseTo(0, 9);
    expect(seg.endAngle).toBeCloseTo(Math.PI / 2, 6);
    // `ccw` is GEOMETRY, not metadata: this traversal runs counter-clockwise.
    expect(seg.ccw).toBe(true);
  });

  it('GOTCHA: `ccw` follows the traversal, so the same arc reversed is clockwise', () => {
    // Getting this wrong turns a 90° arc into its 270° complement — the
    // `sketch-arc-ccw-gotcha` failure that made `makeArcEdge` sweep through the
    // rotation axis and BRepMesh hang.
    const q = Math.SQRT1_2 * 10;
    expect(arcSegment([10, 0], [q, q], [0, 10])!.ccw).toBe(true);
    expect(arcSegment([0, 10], [q, q], [10, 0])!.ccw).toBe(false);
  });

  it('GOTCHA: a curve whose sagitta is below the emission quantum IS a line — do not emit an arc', () => {
    // `profileSegToCurve` re-derives an arc's endpoints from (cx, cy, radius,
    // angle), so a near-straight "arc" would move both endpoints off the curve the
    // source actually has. The extractor emits a line for this case.
    expect(arcSegment([0, 0], [5, 1e-9], [10, 0])).toBeUndefined();
    expect(arcSegment([0, 0], [5, 1e-4], [10, 0])).toBeDefined();
  });

  it('a full-circle traversal is NOT decidable here — the extractor builds those explicitly', () => {
    // start === end has no chord, so there is no sweep to read a direction from;
    // `readEdge` emits full circles from a 3-sample circumcircle with
    // startAngle === endAngle and lets `profileSegToCurve` normalize the sweep to
    // 2π (its `makeCircle2d` branch).
    expect(arcSegment([10, 0], [0, 10], [10, 0])).toBeUndefined();
  });
});

describe('reverseSegment', () => {
  it('round-trips a line', () => {
    const s = lineSegment([1, 2], [3, 4]);
    expect(reverseSegment(reverseSegment(s))).toEqual(s);
  });

  it("swaps an arc's angles and flips ccw, keeping the same center, radius and bulge", () => {
    const s = arcSegment([10, 0], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [0, 10])!;
    const r = reverseSegment(s);
    expect(r.kind).toBe('arc');
    if (r.kind !== 'arc') throw new Error('reverseSegment changed the segment kind');
    expect(r.startAngle).toBeCloseTo(s.endAngle, 12);
    expect(r.endAngle).toBeCloseTo(s.startAngle, 12);
    expect(r.ccw).toBe(!s.ccw);
    expect(r.radius).toBe(s.radius);
    expect(r.cx).toBe(s.cx);
    expect(arcMidpoint(r)[0]).toBeCloseTo(arcMidpoint(s)[0], 12);
    expect(arcMidpoint(r)[1]).toBeCloseTo(arcMidpoint(s)[1], 12);
  });
});

describe('snapContour', () => {
  it('quantizes to the emission quantum', () => {
    const out = snapContour([lineSegment([0.123456789, 0], [10, 0.9999999999])], false, 1e-3);
    const seg = out[0]!;
    expect(seg.kind).toBe('line');
    if (seg.kind === 'line') {
      expect(seg.x1).toBe(0.123457);
      expect(seg.y2).toBe(1);
    }
  });

  it("GOTCHA: a closed contour's last segment must END on the exact numbers the first one STARTS with", () => {
    // `profileSegToCurve` rebuilds an arc's endpoints from its own quantized
    // (cx, cy, radius, angle) and a line's from its own quantized coordinates, so
    // two neighbours drift apart by up to one quantum — and OCC's wire builder
    // sews vertices at `Precision::Confusion` (1e-7), which is BELOW our 1e-6
    // quantum. Unsnapped, the wire silently comes out disconnected.
    const square: DraftSegment[] = [
      lineSegment([0, 0], [10, 0]),
      lineSegment([10, 0], [10, 10]),
      lineSegment([10, 10], [0.000003, 10]),
      lineSegment([0.000003, 10], [0.000004, 0]),
    ];
    const open = snapContour(square, false, 1e-3);
    expect(segmentEnd(open[3]!)).toEqual([0.000004, 0]); // control: no snap → the gap survives
    const closed = snapContour(square, true, 1e-3);
    expect(segmentStart(closed[0]!)).toEqual([0, 0]);
    expect(segmentEnd(closed[3]!)).toEqual(segmentStart(closed[0]!));
  });

  it("snaps a following segment onto the previous arc's DERIVED endpoint", () => {
    // The arc ends at (6.1e-16, 10) — derived from (cx, cy, radius, angle), not
    // from its `x2,y2` fields. The line claims a start 1e-7 away. After snapping
    // both sides compute the same number.
    const arc = arcSegment([10, 0], [Math.SQRT1_2 * 10, Math.SQRT1_2 * 10], [0, 10])!;
    const out = snapContour([arc, lineSegment([0.0000001, 10], [0, 20])], false, 1e-3);
    expect(segmentStart(out[1]!)).toEqual(segmentEnd(out[0]!));
  });

  it('a full circle stays full (startAngle === endAngle is not a rounding artefact)', () => {
    const cos = Math.cos(1.234);
    const sin = Math.sin(1.234);
    const full: DraftArcSegment = {
      kind: 'arc', cx: 0, cy: 0, radius: 25,
      startAngle: 1.234, endAngle: 1.234, ccw: true,
      x1: 25 * cos, y1: 25 * sin, x2: 25 * cos, y2: 25 * sin,
    };
    const out = snapContour([full], true, 1e-3);
    const seg = out[0] as DraftArcSegment;
    expect(seg.startAngle).toBe(seg.endAngle);
    expect(seg.radius).toBeCloseTo(25, 9);
  });
});

/**
 * A2 (2026-09-29 plan) — the parametric-curve segment. Before A2, every
 * `bezier` / `bspline` Draft edge fell into the per-edge tessellation fallback
 * and reached the wire as a polyline; A2 reads the NURBS control data straight
 * from the kernel and emits a `DraftSplineSegment` carrying it. The exact-curve
 * path is what `draft-parametric-e2e.test.ts` asserts end to end (BY EXECUTION,
 * on real FreeCAD documents) — these cases pin the PURE helpers that path leans
 * on, so a regression in the walk or the reversal shows up without a wasm init.
 */
describe('DraftSplineSegment (A2 exact-curve emission)', () => {
  function spline(over: Partial<DraftSplineSegment> = {}): DraftSplineSegment {
    return {
      kind: 'spline',
      degree: 3,
      poles: [0, 0, 10, 5, 20, 0, 30, -5],
      knots: [0, 0, 0, 0, 1, 1, 1, 1],
      multiplicities: [4, 4],
      periodic: false,
      first: 0,
      last: 1,
      x1: 0, y1: 0,
      x2: 30, y2: -5,
      ...over,
    };
  }

  it('segmentStart/segmentEnd read the exact endpoints, not derived params', () => {
    // For a spline the endpoints are the kernel's own `curvePointAtParam(first/last)`;
    // deriving them from the control polygon (as a line/arc does) would be wrong.
    const s = spline();
    expect(segmentStart(s)).toEqual([0, 0]);
    expect(segmentEnd(s)).toEqual([30, -5]);
  });

  it('GOTCHA: reversing a spline twice returns the SAME curve exactly (no approximation)', () => {
    // A reversed B-spline is still a B-spline: `reverseSplineSegment` reflects the
    // knot vector about the domain midpoint and reverses poles/weights/mults. The
    // chain walk reverses an edge whenever its END meets the tail, so this must
    // round-trip bit-exactly — a spline cannot be snapped back like a line or an arc.
    const s = spline({ weights: [1, 2, 3, 4] });
    const r = reverseSegment(s) as DraftSplineSegment;
    const rr = reverseSegment(r) as DraftSplineSegment;
    expect(rr).toEqual(s);
  });

  it('GOTCHA: a reversed spline keeps its NURBS control data (curve, not a point list)', () => {
    const r = reverseSegment(spline({ weights: [1, 2, 3, 4] })) as DraftSplineSegment;
    expect(r.kind).toBe('spline');
    expect(r.degree).toBe(3);
    expect(r.poles).toHaveLength(8);
    expect(r.weights).toEqual([4, 3, 2, 1]);
  });

  it('GOTCHA: a contour containing a spline is NOT quantized (snapping would leave sub-micron seam gaps)', () => {
    // `snapContour` quantizes the other segments only when every segment can be
    // re-derived from its own rounded params; a spline cannot, so the whole
    // contour passes through exact and the spline reference is returned unchanged.
    const s = spline();
    const out = snapContour([s], false, 1e-3);
    expect(out[0]).toBe(s); // same reference ⇒ unmodified
  });

  it('a mixed contour with a spline keeps all segments and leaves the spline untouched', () => {
    const line0 = lineSegment([0, 0], [10, 0]);
    const s = spline({ x1: 10, y1: 0, x2: 10, y2: 10, poles: [10, 0, 10, 5, 10, 10] });
    const line1 = lineSegment([10, 10], [0, 0]);
    const out = snapContour([line0, s, line1], true, 1e-3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(line0);
    expect(out[1]).toBe(s);
    expect(out[2]).toBe(line1);
  });

  it('chainDraftEdges walks a contour whose seam edge is a spline (segmentStart/End drive the match)', () => {
    // A closed triangle: line → spline → line, head-to-tail. The spline's EXACT
    // endpoints (not derived curve params) are what the walk joins on, and the
    // spline survives the walk as a spline — it is NOT sampled into lines.
    const e0: DraftEdge = { a: [0, 0], b: [10, 0], segments: [lineSegment([0, 0], [10, 0])] };
    const sp: DraftSplineSegment = spline({
      x1: 10, y1: 0, x2: 10, y2: 10,
      poles: [10, 0, 10, 5, 10, 10], knots: [0, 0, 0, 1, 1, 1], multiplicities: [3, 3], degree: 2,
    });
    const e1: DraftEdge = { a: [10, 0], b: [10, 10], segments: [sp] };
    const e2: DraftEdge = { a: [10, 10], b: [0, 0], segments: [lineSegment([10, 10], [0, 0])] };
    const contours = chainDraftEdges([e0, e1, e2], 1e-3);
    expect(contours).toHaveLength(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.segments).toHaveLength(3);
    expect(contours[0]!.segments.filter((s) => s.kind === 'spline')).toHaveLength(1);
  });

  it('GOTCHA: a rational spline carries weights and the trim range is reflected exactly on reversal', () => {
    const s = spline({ first: 0.2, last: 0.8, weights: [1, 1, 2, 1] });
    expect(s.weights).toEqual([1, 1, 2, 1]);
    const r = reverseSegment(s) as DraftSplineSegment;
    // reflect(p) = d1 - (p - d0) with d0 = 0, d1 = 1 ⇒ first↔last swap. 1-0.8 = 0.2, 1-0.2 = 0.8.
    expect(r.first).toBeCloseTo(0.2, 12);
    expect(r.last).toBeCloseTo(0.8, 12);
  });
});
