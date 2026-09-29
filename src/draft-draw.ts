/**
 * draft-draw — A1 (2026-09-29 plan): Draft 2D objects → ANALYTIC 2D contours.
 *
 * Draft 2D objects (`Part::Part2DObjectPython` — Wire/Circle/… proxies) store
 * their geometry ONLY in the frozen `Shape` .brp member (probe 2026-09-28,
 * Bathroom_cabinet_sink: the XML properties carry attachment/expression data, no
 * point lists). The drawing is therefore REBUILT from that .brp.
 *
 * ⚠️ Two rebuild strategies were tried and only the third is correct. Both
 * failures are pinned here because both looked plausible:
 *
 * 1. **Fragments.** The first pass chained `wireframe().edgeGroups` consecutive
 *    entries. That array is `TopExp::MapShapes` order over the whole shape, NOT a
 *    traversal order (measured on `Clone2D.Shape.brp`: 3 of 14 consecutive pairs
 *    share an endpoint, the rest sit up to 3.43 mm apart). It shattered every
 *    wire into per-edge fragments — 8 products' 145 objects became 781 "contours",
 *    95 % of them geometrically open. Fixed by walking `getSubShapes(shape,
 *    'wire')` and ordering each wire's edges by ENDPOINT MATCHING.
 *
 * 2. **Tessellation.** The second pass re-derived the drawing from
 *    `wireframe(handle, DRAFT_DEFLECTION)` — a pure mesh sampling — and emitted
 *    ONE `pen.polyline([…])` per contour. That threw away the analytic curves the
 *    source actually stores. Measured on `Sprocket ANSI simplex 1¾x1¼ z21`
 *    (`PartShape1.brp` = 1 wire / 168 edges = **126 circle + 42 line**, every one
 *    analytic): 7010 emitted points, and OCC never finished wire + pad — 420 s,
 *    no STEP. The hang was representational, not a scale limit.
 *
 * 3. **This one.** Read each edge's curve KIND from the kernel
 *    (`curveType`/`curveParameters`/`curvePointAtParam`/`curveIsClosed`) and emit
 *    the analytic `ProfileSeg` (`line` / `arc`) for the kinds the platform can
 *    express. FreeCAD and this project are both OCCT kernels: what the source
 *    stores analytically, this pipeline keeps analytically. Tessellation is now a
 *    per-EDGE fallback for the individual kinds the platform cannot express yet
 *    (`bspline`, `ellipse`, …) — never a per-object one.
 *
 * The walk also records whether each contour CLOSES (`DraftContour.closed`), and
 * that flag decides the run-time shape:
 *
 *   · closed  → a profile. `cad.sketchOnPlane` builds a planar face, which is
 *     what `cad.extrude` needs.
 *   · open    → a path. An open wire can never bound a face — OCCT's
 *     `BRepBuilderAPI_MakeFace::IsDone()` is false and the op surfaces
 *     `CONSTRUCTION_FAILED: makeFace: construction failed` — so it travels as a
 *     1D curve (`as:'wire'`), which is exactly what `cad.sweep` takes as its
 *     spine.
 *
 * Both kinds occur in one real document: Kitchen_cabinet_base extrudes its closed
 * `Clone2D005/006/…` and sweeps along its open `Clone2D004/010/017`. The
 * superseded form could not tell them apart: `BlueprintSketcher.close()` appended
 * a closing segment to EVERY contour, so an open spine became a loop.
 *
 * Emission target is the platform's `ProfileLoop` (`{segments: […]}`), which
 * `cad.sketchOnPlane` and `cad.profile` both consume (same form the solved-sketch
 * path already emits). One object-literal argument, so it cannot hit the parser's
 * AST depth cap of 100 — the reason the polyline form had to be a single call, and
 * the reason a per-segment `pen.lineTo(…)` member chain is not an option.
 *
 * Units mm; contours live in the object's OWN 2D frame (the frozen .brp carries
 * LOCAL coordinates and the object's Placement is applied on top by the placement
 * pass, same two-frame rule as sketches).
 */
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';
import { memberText, type FcstdArchive } from './unpack.js';
import type { FcstdObject } from './document.js';
import { shapeBrpFile } from './external-geo.js';

/** Tessellation deflection (mm) for the per-edge fallback path. */
const DRAFT_DEFLECTION = 0.01;

/**
 * Emitted-precision quantum (mm). Endpoint coordinates, circle centers and radii
 * are rounded to this; ANGLES are not, because 1e-6 rad at r = 100 mm is 1e-4 mm
 * of arc — quantizing angles would move geometry, quantizing lengths does not.
 */
const DRAFT_QUANTUM = 1e-6;

/** `1 / DRAFT_QUANTUM`. Round-then-DIVIDE: dividing yields the nearest double to
 * the decimal, multiplying gives `123457 * 1e-6 = 0.12345700000000001`. */
const DRAFT_QUANTUM_SCALE = 1e6;

/** A 2D point in the drawing's own frame. */
export type Point2 = [number, number];

/** Straight segment, absolute endpoints (`ProfileLineSeg`-compatible). */
export interface DraftLineSegment {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Circular arc segment (`ProfileArcSeg`-compatible). `startAngle`/`endAngle` are
 * radians in the DRAWING frame around `(cx, cy)`; `ccw` is geometry, not metadata
 * — `profileSegToCurve` derives the sweep from it, and getting it wrong turns a
 * 65° arc into its 294° complement (pinned by `sketch-arc-ccw-gotcha`).
 */
export interface DraftArcSegment {
  kind: 'arc';
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  ccw: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** One emitted 2D contour segment. */
export type DraftSegment = DraftLineSegment | DraftArcSegment;

/**
 * One wire edge as the extractor reads it: exact 2D endpoints plus the segments
 * that draw it from `a` to `b`. Analytic edges carry one segment; a tessellated
 * fallback edge carries a run of `line` segments.
 */
export interface DraftEdge {
  a: Point2;
  b: Point2;
  segments: DraftSegment[];
}

/** One rebuilt drawing contour: head-to-tail segments in the object's own frame. */
export interface DraftContour {
  segments: DraftSegment[];
  /**
   * true when the emitted run returns to the contour's own first point (decided
   * on the SNAPPED segments — see {@link chainDraftEdges}).
   *
   * This is NOT informational: it selects the run-time shape. A closed contour is
   * a profile and `cad.sketchOnPlane` builds a face from it (what `cad.extrude`
   * consumes); an OPEN contour is a path — a Draft outline used as a `cad.sweep`
   * spine — and can never bound a face. Measured on Kitchen_cabinet_base: the
   * extruded `Clone2D005/006/008/009/014/015/018` are all closed, while the
   * sweeps' spines `Clone2D004/010/017` are all open. The superseded A4 form
   * closed every contour as a side effect of `BlueprintSketcher.close()` and so
   * silently turned those spines into loops.
   */
  closed: boolean;
}

/** The rebuilt drawing of one Draft object: one contour per wire. */
export interface DraftDrawing {
  contours: DraftContour[];
}

/** The kernel surface this module reads (declared structurally: occt-wasm types are heavy). */
interface DraftKernel {
  fromBREP: (s: string) => number;
  getSubShapes: (s: number, t: string) => number[];
  curveType: (e: number) => string;
  curveParameters: (e: number) => { first: number; last: number };
  curvePointAtParam: (e: number, p: number) => { x: number; y: number; z: number };
  curveIsClosed: (e: number) => boolean;
  wireframe: (s: number, d: number) => { points: Float32Array; edgeGroups: number[] };
  release: (s: number) => void;
}

// ── pure geometry helpers (no kernel; unit-tested directly) ──

/** Round to the emitted-precision quantum. */
function q(n: number): number {
  return Math.round(n * DRAFT_QUANTUM_SCALE) / DRAFT_QUANTUM_SCALE;
}

/** Point on a circle, by angle. */
function arcPoint(cx: number, cy: number, radius: number, angle: number): Point2 {
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

/** Wrap an angle into `[0, 2π)`. `%` is wrong here: it maps 2π to 0. */
function norm2pi(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a;
}

/** Perpendicular distance from `p` to the line through `a`–`b` (0 when degenerate). */
function sagittaOf(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/**
 * Circle through three 2D points.
 * @param p0 - first point.
 * @param pm - second point.
 * @param p1 - third point.
 * @returns the circumcenter and radius, or undefined when the points are
 *   collinear or the result is not a finite circle.
 */
export function circumcircle(
  p0: Point2,
  pm: Point2,
  p1: Point2,
): { cx: number; cy: number; radius: number } | undefined {
  const d = 2 * (p0[0] * (pm[1] - p1[1]) + pm[0] * (p1[1] - p0[1]) + p1[0] * (p0[1] - pm[1]));
  if (d === 0 || !Number.isFinite(d)) return undefined;
  const s0 = p0[0] * p0[0] + p0[1] * p0[1];
  const s1 = pm[0] * pm[0] + pm[1] * pm[1];
  const s2 = p1[0] * p1[0] + p1[1] * p1[1];
  const cx = (s0 * (pm[1] - p1[1]) + s1 * (p1[1] - p0[1]) + s2 * (p0[1] - pm[1])) / d;
  const cy = (s0 * (p1[0] - pm[0]) + s1 * (p0[0] - p1[0]) + s2 * (pm[0] - p0[0])) / d;
  const radius = Math.hypot(p0[0] - cx, p0[1] - cy);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius <= 0) {
    return undefined;
  }
  return { cx, cy, radius };
}

/**
 * Analytic arc through `start` → `mid` → `end`.
 *
 * Returns undefined when the three points do NOT determine an arc worth emitting:
 * collinear (no circle) or sagitta at or below {@link DRAFT_QUANTUM}. The second
 * case matters: `profileSegToCurve` re-derives an arc's endpoints from
 * `(cx, cy, radius, angle)`, so emitting a near-straight "arc" would move both
 * endpoints off the curve the source actually has. Such a curve IS a line at the
 * emitted precision — say so, and emit a line.
 *
 * @param start - the arc's first point.
 * @param mid - a point the arc passes through (fixes direction and sweep).
 * @param end - the arc's last point.
 * @returns the arc segment (with `x1,y1,x2,y2` filled in) or undefined.
 */
export function arcSegment(start: Point2, mid: Point2, end: Point2): DraftArcSegment | undefined {
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) <= 0) return undefined;
  if (sagittaOf(mid, start, end) <= DRAFT_QUANTUM) return undefined;
  const c = circumcircle(start, mid, end);
  if (!c) return undefined;
  const a0 = Math.atan2(start[1] - c.cy, start[0] - c.cx);
  const am = Math.atan2(mid[1] - c.cy, mid[0] - c.cx);
  const a1 = Math.atan2(end[1] - c.cy, end[0] - c.cx);
  // `mid` lies on the CCW path from `start` iff its swept angle is the smaller of
  // the two candidates. A full circle (a0 === a1) is NOT decidable this way and
  // is not built here — the extractor builds full circles explicitly.
  const ccw = norm2pi(am - a0) < norm2pi(a1 - a0);
  return {
    kind: 'arc', cx: c.cx, cy: c.cy, radius: c.radius,
    startAngle: a0, endAngle: a1, ccw,
    x1: start[0], y1: start[1], x2: end[0], y2: end[1],
  };
}

/**
 * Straight segment.
 * @param a - the segment's first point.
 * @param b - the segment's last point.
 * @returns the line segment, with absolute endpoints.
 */
export function lineSegment(a: Point2, b: Point2): DraftLineSegment {
  return { kind: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
}

/**
 * Where a segment starts — for an arc this is DERIVED from `(cx, cy, radius,
 * startAngle)`, because that is what `profileSegToCurve` will do with it. Reading
 * `x1, y1` instead would misreport the geometry whenever the two disagree.
 * @param s - the segment.
 * @returns its first point.
 */
export function segmentStart(s: DraftSegment): Point2 {
  return s.kind === 'line' ? [s.x1, s.y1] : arcPoint(s.cx, s.cy, s.radius, s.startAngle);
}

/**
 * Where a segment ends (derived for arcs — see {@link segmentStart}).
 * @param s - the segment.
 * @returns its last point.
 */
export function segmentEnd(s: DraftSegment): Point2 {
  return s.kind === 'line' ? [s.x2, s.y2] : arcPoint(s.cx, s.cy, s.radius, s.endAngle);
}

/**
 * The same segment traversed backwards.
 * @param s - the segment to reverse.
 * @returns the reversed segment; an arc keeps its center and radius, swaps its
 *   angles and flips `ccw` (see the `sketch-arc-ccw-gotcha` note above).
 */
export function reverseSegment(s: DraftSegment): DraftSegment {
  if (s.kind === 'line') return { kind: 'line', x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 };
  return {
    kind: 'arc', cx: s.cx, cy: s.cy, radius: s.radius,
    startAngle: s.endAngle, endAngle: s.startAngle, ccw: !s.ccw,
    x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1,
  };
}

/** A full circle has `startAngle === endAngle` and must STAY full through snapping. */
function isFullCircle(s: DraftArcSegment): boolean {
  return s.startAngle === s.endAngle;
}

/**
 * The arc's swept angle in radians, in the direction `ccw` selects.
 *
 * Mirrors the run-time normalisation in `geometry2d/adapt.ts`'s
 * `profileSegToCurve` exactly — `while`-shifting rather than `%`, because `%`
 * maps a full 2π sweep to 0 and would read a whole circle as degenerate. Used
 * here only to measure a contour's length (see {@link chainDraftEdges}), but the
 * two must not drift: a disagreement would misjudge whether a contour exists.
 *
 * @param s - the arc segment.
 * @returns the sweep in `(0, 2π]`.
 */
function arcSweep(s: DraftArcSegment): number {
  let sweep = s.ccw ? s.endAngle - s.startAngle : s.startAngle - s.endAngle;
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  return sweep;
}

/**
 * Quantize one segment and snap its start onto `prevEnd` when the two were
 * already coincident.
 *
 * Why snap at all: `profileSegToCurve` rebuilds each arc's endpoints from its own
 * quantized `(cx, cy, radius, angle)`, and each line's endpoints from its own
 * quantized coordinates. Two neighbours that were joined exactly therefore drift
 * apart by up to one quantum — and OCC's wire builder sews vertices at
 * `Precision::Confusion` (1e-7), which is BELOW our 1e-6 emission quantum, so the
 * wire silently comes out disconnected. Snapping makes the shared vertex one
 * number again, computed the same way on both sides.
 *
 * @param raw - the segment to quantize.
 * @param prevEnd - the previous segment's effective end, or undefined for the first.
 * @param tol - coincidence tolerance (the chain tolerance).
 * @returns the quantized, snapped segment.
 */
function quantizeAndSnap(raw: DraftSegment, prevEnd: Point2 | undefined, tol: number): DraftSegment {
  if (raw.kind === 'line') {
    const start = prevEnd ? nearest(prevEnd, [q(raw.x1), q(raw.y1)], tol) : ([q(raw.x1), q(raw.y1)] as Point2);
    return { kind: 'line', x1: start[0], y1: start[1], x2: q(raw.x2), y2: q(raw.y2) };
  }
  const cx = q(raw.cx);
  const cy = q(raw.cy);
  const radius = q(raw.radius);
  let startAngle = raw.startAngle;
  if (prevEnd) {
    const own = arcPoint(cx, cy, radius, startAngle);
    if (Math.hypot(own[0] - prevEnd[0], own[1] - prevEnd[1]) <= tol) {
      startAngle = Math.atan2(prevEnd[1] - cy, prevEnd[0] - cx);
    }
  }
  const endAngle = isFullCircle(raw) ? startAngle : raw.endAngle;
  const s = arcPoint(cx, cy, radius, startAngle);
  const e = arcPoint(cx, cy, radius, endAngle);
  return { kind: 'arc', cx, cy, radius, startAngle, endAngle, ccw: raw.ccw, x1: s[0], y1: s[1], x2: e[0], y2: e[1] };
}

/** `own` when it is within `tol` of `target`, else `target` (the seam is real → unify). */
function nearest(target: Point2, own: Point2, tol: number): Point2 {
  return Math.hypot(own[0] - target[0], own[1] - target[1]) <= tol ? target : own;
}

/**
 * Quantize a whole contour and unify every shared vertex.
 * @param segments - the contour's segments, head to tail.
 * @param closed - whether the walk returned to the first point.
 * @param tol - coincidence tolerance (see {@link draftTolerance}).
 * @returns the emitted-precision segments.
 */
export function snapContour(segments: readonly DraftSegment[], closed: boolean, tol: number): DraftSegment[] {
  const out: DraftSegment[] = [];
  let prevEnd: Point2 | undefined;
  for (const raw of segments) {
    const seg = quantizeAndSnap(raw, prevEnd, tol);
    out.push(seg);
    prevEnd = segmentEnd(seg);
  }
  if (closed && out.length > 0) {
    const anchor = segmentStart(out[0]!);
    const last = out[out.length - 1]!;
    const end = segmentEnd(last);
    if (Math.hypot(end[0] - anchor[0], end[1] - anchor[1]) <= tol) {
      out[out.length - 1] = forceEndTo(last, anchor);
    }
  }
  return out;
}

/** Re-aim a segment's end at `target`, preserving a full circle's fullness. */
function forceEndTo(seg: DraftSegment, target: Point2): DraftSegment {
  if (seg.kind === 'line') return { kind: 'line', x1: seg.x1, y1: seg.y1, x2: target[0], y2: target[1] };
  if (isFullCircle(seg)) return seg;
  const endAngle = Math.atan2(target[1] - seg.cy, target[0] - seg.cx);
  const e = arcPoint(seg.cx, seg.cy, seg.radius, endAngle);
  return { kind: 'arc', cx: seg.cx, cy: seg.cy, radius: seg.radius, startAngle: seg.startAngle, endAngle, ccw: seg.ccw, x1: seg.x1, y1: seg.y1, x2: e[0], y2: e[1] };
}

/**
 * Endpoint-match tolerance for {@link chainDraftEdges}, derived from the data.
 *
 * The fallback (tessellated) edges hand back `Float32Array` samples, so two
 * independently tessellated edges that end on the SAME topological vertex can
 * disagree by ~1 ulp of the coordinate magnitude (ulp = 2^(ceil(log2 m) − 23);
 * measured 6.1e-5 at m ≈ 300). `1e-5·m` clears that worst case by ~25× while
 * staying ~1000× under the millimetre gaps between genuinely distinct vertices
 * (measured 3.43 mm max on `Clone2D.Shape.brp`). Analytic edges agree exactly, so
 * this bound costs them nothing.
 *
 * @param edges - the wire's edges (all endpoints considered).
 * @returns the absolute tolerance in mm (never below 1e-9).
 */
export function draftTolerance(edges: readonly DraftEdge[]): number {
  let magnitude = 0;
  for (const e of edges) {
    magnitude = Math.max(magnitude, Math.abs(e.a[0]), Math.abs(e.a[1]), Math.abs(e.b[0]), Math.abs(e.b[1]));
  }
  return Math.max(1e-9, 1e-5 * magnitude);
}

/** The same edge traversed backwards. */
function reverseEdge(e: DraftEdge): DraftEdge {
  return { a: e.b, b: e.a, segments: e.segments.map(reverseSegment).reverse() };
}

/**
 * Order one wire's edges into contours by matching shared endpoints, then
 * quantize + seam-snap each contour.
 *
 * Rationale in the module header: the kernel hands edges back in
 * `TopExp::MapShapes` order, which is not a traversal order, so the only reliable
 * way to reassemble a wire is to join edges that share an endpoint. A wire is
 * connected by construction, but the walk degrades honestly: it restarts on any
 * leftover edge, so a wire whose matching fails yields several contours rather
 * than silently dropping edges.
 *
 * @param edges - the wire's edges.
 * @param tol - endpoint-match tolerance in mm (see {@link draftTolerance}).
 * @returns the rebuilt contours, each already quantized and seam-snapped.
 */
export function chainDraftEdges(edges: readonly DraftEdge[], tol: number): DraftContour[] {
  const near = (p: Point2, r: Point2): boolean => Math.hypot(p[0] - r[0], p[1] - r[1]) <= tol;

  const used = new Array<boolean>(edges.length).fill(false);
  const contours: DraftContour[] = [];

  for (let seed = 0; seed < edges.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;
    let chain: DraftEdge[] = [edges[seed]!];

    // Grow both ends until the chain stops matching — a seed inside a loop must
    // extend forwards AND backwards, which a tail-only walk would miss.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < edges.length; i++) {
        if (used[i]) continue;
        const e = edges[i]!;
        const head = chain[0]!.a;
        const tail = chain[chain.length - 1]!.b;
        // Four ways an unused edge can join the chain. The prepend cases walk the
        // edge in whichever direction ENDS on the chain's head — swapping them
        // silently reorders the wire (caught by the "seed in the middle" case).
        if (near(e.a, tail)) chain = chain.concat(e);
        else if (near(e.b, tail)) chain = chain.concat(reverseEdge(e));
        else if (near(e.b, head)) chain = [e, ...chain];
        else if (near(e.a, head)) chain = [reverseEdge(e), ...chain];
        else continue;
        used[i] = true;
        progressed = true;
        break;
      }
    }

    const raw = chain.flatMap((e) => e.segments);
    if (raw.length === 0) continue;
    // A contour with no LENGTH is not a contour: emitting it would hand the wire
    // builder a degenerate run and `makeFace` a wire it cannot close.
    // GOTCHA: measure LENGTH, not endpoint span. A full circle's start and end
    // points COINCIDE, so a span test reads 0 and would silently drop every Draft
    // `Circle` object (a one-edge, one-segment contour) — the object would then
    // rebuild to nothing and fall back to a dead shape-asset import.
    let length = 0;
    for (const s of raw) length += s.kind === 'line' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) : s.radius * arcSweep(s);
    if (length <= tol) continue;
    // Closure is a property of the EMITTED geometry, NOT of how many edges the
    // walk happened to visit. Two measured counter-examples killed the original
    // edge-count rule (`chain.length > 1 && near(a, b)`):
    //   · Kitchen_cabinet_base `Clone2D001` is a closed B-spline outline stored as
    //     ONE edge — 629 segments, first point === last point exactly — and the
    //     `> 1` guard reported it open;
    //   · the same file's `Clone2D017` is a two-segment sliver (a→b→a), a
    //     legitimate closed loop the old rule also called open.
    // Decide from the snapped run's own endpoints instead, then force the tail
    // onto the anchor so the run the run time actually builds is closed.
    const hinted = near(segmentStart(raw[0]!), segmentEnd(raw[raw.length - 1]!));
    const snapped = snapContour(raw, hinted, tol);
    const anchor = segmentStart(snapped[0]!);
    const tail = segmentEnd(snapped[snapped.length - 1]!);
    const closed = near(anchor, tail);
    if (closed && (anchor[0] !== tail[0] || anchor[1] !== tail[1])) {
      snapped[snapped.length - 1] = forceEndTo(snapped[snapped.length - 1]!, anchor);
    }
    contours.push({ segments: snapped, closed });
  }
  return contours;
}

/**
 * True when the object is a Draft 2D drawing object (A4/A1 target class).
 * @param obj - the FCStd object to test.
 * @returns true when the object is a `Part::Part2DObjectPython` drawing.
 */
export function isDraft2DObject(obj: FcstdObject): boolean {
  return obj.type === 'Part::Part2DObjectPython';
}

/**
 * Read one wireframe payload's edge polylines, dropping degenerate ones.
 *
 * `edgeGroups` is a flat `[pointStart, byteEnd, edgeHash]` triple per edge, in
 * `TopExp::MapShapes` order — NOT a traversal order (see the module header). Only
 * used by the per-edge fallback now.
 *
 * @param wf - the kernel wireframe payload.
 * @returns the edge polylines, each with at least two distinct points.
 */
function edgePolylines(wf: { points: Float32Array; edgeGroups: number[] }): Point2[][] {
  const polylines: Point2[][] = [];
  for (let g = 0; g * 3 + 1 < wf.edgeGroups.length; g++) {
    const g0 = wf.edgeGroups[g * 3]!;
    const n = Math.floor(wf.edgeGroups[g * 3 + 1]! / 3);
    if (n < 2) continue;
    const pts: Point2[] = [];
    for (let p = 0; p < n; p++) pts.push([wf.points[g0 + p * 3]!, wf.points[g0 + p * 3 + 1]!]);
    // Collapse consecutive repeats so a zero-length edge cannot anchor the walk.
    const deduped = pts.filter(
      (pt, i) => i === 0 || Math.hypot(pt[0] - pts[i - 1]![0], pt[1] - pts[i - 1]![1]) > 1e-9,
    );
    if (deduped.length >= 2) polylines.push(deduped);
  }
  return polylines;
}

/** Read one edge as an analytic `DraftEdge`, or undefined when it is unreadable. */
function readEdge(kernel: DraftKernel, edge: number): DraftEdge | undefined {
  let kind: string;
  let params: { first: number; last: number };
  let p0: { x: number; y: number };
  let p1: { x: number; y: number };
  let pm: { x: number; y: number };
  try {
    kind = kernel.curveType(edge);
    params = kernel.curveParameters(edge);
    p0 = kernel.curvePointAtParam(edge, params.first);
    p1 = kernel.curvePointAtParam(edge, params.last);
    pm = kernel.curvePointAtParam(edge, (params.first + params.last) / 2);
  } catch {
    return undefined;
  }
  const a: Point2 = [p0.x, p0.y];
  const b: Point2 = [p1.x, p1.y];

  if (kind === 'line') {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= 0) return undefined;
    return { a, b, segments: [lineSegment(a, b)] };
  }

  if (kind === 'circle') {
    let closed = false;
    try {
      closed = kernel.curveIsClosed(edge);
    } catch {
      closed = false;
    }
    if (closed) {
      // Full circle: three samples a third of the sweep apart. A full circle is
      // NOT `arcSegment`'s job — with start === end there is no chord to decide
      // `ccw` from, so build it explicitly (start === end ⇒ sweep 2π ⇒ the wire
      // builder's own two-half-arc split).
      const t1 = kernel.curvePointAtParam(edge, params.first + (params.last - params.first) / 3);
      const t2 = kernel.curvePointAtParam(edge, params.first + (2 * (params.last - params.first)) / 3);
      const circ = circumcircle(a, [t1.x, t1.y], [t2.x, t2.y]);
      if (circ) {
        const a0 = Math.atan2(a[1] - circ.cy, a[0] - circ.cx);
        const s0 = arcPoint(circ.cx, circ.cy, circ.radius, a0);
        return {
          a, b,
          segments: [{
            kind: 'arc', cx: circ.cx, cy: circ.cy, radius: circ.radius,
            startAngle: a0, endAngle: a0, ccw: true,
            x1: s0[0], y1: s0[1], x2: s0[0], y2: s0[1],
          }],
        };
      }
    } else {
      const arc = arcSegment(a, [pm.x, pm.y], b);
      if (arc) return { a, b, segments: [arc] };
      return { a, b, segments: [lineSegment(a, b)] };
    }
  }

  // Kinds the platform cannot express analytically yet (`bspline`, `ellipse`, …):
  // tessellate THIS edge only, never the whole object.
  let segs: DraftSegment[] = [];
  try {
    const polylines = edgePolylines(kernel.wireframe(edge, DRAFT_DEFLECTION));
    const line = polylines[0];
    if (line) {
      // `wireframe` may hand the run back against the curve's own direction.
      const forward = Math.hypot(line[0]![0] - a[0], line[0]![1] - a[1]) <= Math.hypot(line[0]![0] - b[0], line[0]![1] - b[1]);
      const pts = forward ? line : [...line].reverse();
      for (let i = 1; i < pts.length; i++) segs.push(lineSegment(pts[i - 1]!, pts[i]!));
    }
  } catch {
    segs = [];
  }
  if (segs.length === 0) return undefined;
  return { a, b, segments: segs };
}

/**
 * Extract the .brp of a Draft object as analytic 2D contours.
 *
 * Contours are grouped by real topology where it exists: one contour set per WIRE
 * (`getSubShapes(shape, 'wire')`). GOTCHA (2026-09-28, `Chair` / `Shape2DView`): a
 * Draft projection object can store an **edge compound with no wires at all**, so
 * a wire-only pass silently produced nothing and the object fell back to a dead
 * `shape-asset` import — the exact regression A4 exists to avoid. When no wires
 * are present the flat edge set is walked instead; `chainDraftEdges` handles it
 * identically (the shape's wires are reconstructed by endpoint matching).
 *
 * GOTCHA (2026-09-29): a wire must NOT be released before its edges are read.
 * `getSubShapes` hands back child handles that borrow the parent's lifetime;
 * releasing the parent first makes every subsequent read fail with
 * `Invalid shape ID` (measured on `PartShape1.brp`).
 *
 * @param obj - the Draft 2D object.
 * @param archive - the FCStd container (to read the .brp member).
 * @returns the rebuilt drawing, or undefined when the object has no readable shape.
 */
export async function extractDraftDrawing(obj: FcstdObject, archive: FcstdArchive): Promise<DraftDrawing | undefined> {
  const brpFile = shapeBrpFile(obj);
  if (!brpFile) return undefined;
  const brp = memberText(archive, brpFile);
  if (!brp) return undefined;
  const kernel = (await initOcctWasm()) as unknown as DraftKernel;
  let shape: number;
  try {
    shape = kernel.fromBREP(brp);
  } catch {
    return undefined;
  }
  const contours: DraftContour[] = [];
  const collect = (handle: number): void => {
    let edges: number[];
    try {
      edges = kernel.getSubShapes(handle, 'edge');
    } catch {
      return;
    }
    const pieces: DraftEdge[] = [];
    for (const edge of edges) {
      try {
        const piece = readEdge(kernel, edge);
        if (piece) pieces.push(piece);
      } catch {
        // One unreadable edge must not lose the object's other contours.
      } finally {
        kernel.release(edge);
      }
    }
    if (pieces.length > 0) contours.push(...chainDraftEdges(pieces, draftTolerance(pieces)));
  };
  try {
    let wires: number[] = [];
    try {
      wires = kernel.getSubShapes(shape, 'wire');
    } catch {
      wires = [];
    }
    if (wires.length > 0) {
      for (const wire of wires) {
        try {
          collect(wire);
        } catch {
          // One unreadable wire must not lose the object's other contours.
        } finally {
          kernel.release(wire);
        }
      }
    } else {
      // Edge compound (a Draft `Shape2DView`): no wire topology to group by.
      try {
        collect(shape);
      } catch {
        /* unreadable shape → no contours */
      }
    }
  } finally {
    kernel.release(shape);
  }
  return contours.length > 0 ? { contours } : undefined;
}
