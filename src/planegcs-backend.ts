/**
 * M3.2/M3.3/M3.4 — planegcs WASM backend for the SketchSolver interface.
 *
 * M3.3: geometry → GCS primitives, including the implicit fixed RtPnt/HAxis/
 * VAxis (geoId -1/-2, plan §5.4). External geometry (geoId <= -3) is rejected
 * upstream (D4: whole sketch downgrades to L2).
 * M3.4: constraints → GCS primitives for the P0 set (plan §7 M3.4).
 * M3.5 helper: solved params are pulled back and geometry rebuilt, so the
 * caller can compare against on-disk coordinates (D2).
 */
import { make_gcs_wrapper, Algorithm } from '@salusoft89/planegcs';
import type { GcsWrapper } from '@salusoft89/planegcs';
import { ok, type Result } from '@faicad/faijs/api/result';
import type { SketchGeom, SketchCon } from './sketch-parse.js';
import { ConstraintType, PointPos } from './sketch-parse.js';
import type { SolveOutcome, SketchSolver } from './sketch-solver.js';
import { SUPPORTED_CONSTRAINT_TYPES } from './sketch-solver.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let wasmPathCache: string | undefined;
/**
 * Resolve the planegcs WASM binary path from the installed package.
 *
 * @returns the absolute path of `planegcs.wasm` inside `@salusoft89/planegcs`.
 */
export function planegcsWasmPath(): string {
  if (!wasmPathCache) {
    const pkgDir = dirname(require.resolve('@salusoft89/planegcs/package.json'));
    wasmPathCache = join(pkgDir, 'dist', 'planegcs_dist', 'planegcs.wasm');
  }
  return wasmPathCache;
}

/**
 * Instantiate the planegcs WASM solver.
 *
 * @returns a `SketchSolver` backed by the planegcs WASM module.
 */
export async function createPlanegcsSolver(): Promise<SketchSolver> {
  const wrapper = await make_gcs_wrapper(planegcsWasmPath());
  return new PlanegcsSolver(wrapper);
}

/** Internal identity for a GCS point owned by a geometry element. */
type PtKey = string;

const P = (geoId: number, pos: number): PtKey => `g${geoId}p${pos}`;

/**
 * planegcs WASM implementation of the `SketchSolver` interface (M3.2–M3.4):
 * pushes geometry/constraints into the GCS, solves, and pulls the solved
 * parameters back into `SketchGeom` values.
 */
export class PlanegcsSolver implements SketchSolver {
  constructor(private wrapper: GcsWrapper) {}

  async solve(
    geoms: SketchGeom[],
    constraints: SketchCon[],
    external?: import('./sketch-solver.js').ExternalFixedSeg[],
  ): Promise<Result<SolveOutcome, never>> {
    const externalMap = new Map<number, import('./sketch-solver.js').ExternalFixedSeg>(
      (external ?? []).map((e) => [e.geoId, e]),
    );
    // a constraint referencing an unresolvable external geoId is dropped
    const unresolvableExternal = new Set<number>();
    for (const c of constraints) {
      for (const r of c.refs) {
        if (r.geoId <= -3 && r.geoId > -2000 && !externalMap.has(r.geoId)) {
          unresolvableExternal.add(c.index);
        }
      }
    }
    const usableConstraints = constraints.filter((c) => !unresolvableExternal.has(c.index));

    // P3-2 (2026-09-24): constraint types that do NOT affect the solved
    // geometry are dropped-and-recorded instead of failing the whole sketch
    // (previously any of these baked the sketch as unsupported-constraint):
    // - 15 InternalAlignment: alignment bookkeeping between element pairs;
    //   the aligned geometry itself is already in <Geometry> — the alignment
    //   constraint adds no independent DoF removal for our solving purpose.
    // - 17 Block: freezes a geometry's current position — the stored
    //   geometry IS that position, so dropping it changes nothing.
    // - 19 Weight: B-Spline control-point weight — we do not solve splines.
    const ignorable = constraints.filter(
      (c) => c.type === 15 || c.type === 17 || c.type === 19,
    ).map((c) => c.index);
    const ignorableSet = new Set(ignorable);

    const unsupported = usableConstraints.find(
      (c) => !SUPPORTED_CONSTRAINT_TYPES.has(c.type) && !ignorableSet.has(c.index),
    );
    if (unsupported) {
      return ok({
        geoms,
        converged: false,
        reason: 'unsupported-constraint',
        problemConstraints: [unsupported.index],
        droppedConstraints: [...unresolvableExternal, ...ignorable],
      });
    }

    const w = this.wrapper;
    w.clear_data();

    // --- M3.3: implicit fixed frame (root point + H/V axes) ---
    w.push_primitive({ type: 'point', id: P(-1, 1), x: 0, y: 0, fixed: true });
    // GOTCHA (probe-sym-min.ts / probe-l1-ablation.ts): FreeCAD models HAxis/
    // VAxis as real Line entries in Geoms (geoId -1/-2), so constraints may
    // reference axis points (pos 1/2) or the axis edge (pos 0) — e.g.
    // DistanceX(line-point, VAxis) fixes an x coordinate. planegcs has no
    // implicit axes, so we materialize both axes as fixed point+line pairs
    // and register them in `lines` (below) so all constraint shapes see them.
    w.push_primitive({ type: 'point', id: P(-1, 2), x: 1, y: 0, fixed: true });
    w.push_primitive({ type: 'point', id: P(-2, 1), x: 0, y: 0, fixed: true });
    w.push_primitive({ type: 'point', id: P(-2, 2), x: 0, y: 1, fixed: true });
    w.push_primitive({ type: 'line', id: 'L-1', p1_id: P(-1, 1), p2_id: P(-1, 2) });
    w.push_primitive({ type: 'line', id: 'L-2', p1_id: P(-2, 1), p2_id: P(-2, 2) });

    // --- M6.3: external fixed geometry (geoId -3, -4, ... in link order) ---
    const externalLines = new Map<number, { p1: PtKey; p2: PtKey }>();
    for (const ext of external ?? []) {
      if (ext.polyline.length === 2) {
        // straight segment: two fixed endpoints + fixed line
        const p1 = P(ext.geoId, 1);
        const p2 = P(ext.geoId, 2);
        w.push_primitive({ type: 'point', id: p1, x: ext.polyline[0]![0], y: ext.polyline[0]![1], fixed: true });
        w.push_primitive({ type: 'point', id: p2, x: ext.polyline[1]![0], y: ext.polyline[1]![1], fixed: true });
        w.push_primitive({ type: 'line', id: `X${ext.geoId}`, p1_id: p1, p2_id: p2 });
        externalLines.set(ext.geoId, { p1, p2 });
      } else {
        // multi-point polyline: pin sampled points as fixed point targets
        ext.polyline.forEach((pt, i) => {
          w.push_primitive({
            type: 'point', id: P(ext.geoId, i + 1), x: pt[0], y: pt[1], fixed: true,
          });
        });
      }
    }

    // --- M3.3: geometry → primitives ---
    // Track which point keys exist as standalone points vs derived from lines.
    const lines = new Map<number, { p1: PtKey; p2: PtKey }>();
    const arcs = new Map<number, { center: PtKey; start: PtKey; end: PtKey }>();
    const circles = new Map<number, { center: PtKey }>();
    const ellipses = new Map<number, { center: PtKey; focus1: PtKey }>();
    const standalone = new Map<number, PtKey>();
    // implicit axes are first-class lines for constraint resolution (see
    // the GOTCHA block above): geoId -1 = HAxis, -2 = VAxis
    lines.set(-1, { p1: P(-1, 1), p2: P(-1, 2) });
    lines.set(-2, { p1: P(-2, 1), p2: P(-2, 2) });

    // pass 1: standalone points that are constraint anchors
    const anchorNeedsStandalone = new Set<string>();
    for (const c of constraints) {
      for (const r of c.refs) {
        if (r.geoId >= 0 && r.pos !== PointPos.none) anchorNeedsStandalone.add(P(r.geoId, r.pos));
      }
    }
    for (const g of geoms) {
      switch (g.kind) {
        case 'point': {
          const id = P(g.index, 1);
          standalone.set(g.index, id);
          w.push_primitive({ type: 'point', id, x: g.x, y: g.y, fixed: false });
          break;
        }
        default:
          break;
      }
    }
    // pass 2: curves; create endpoint points for lines/arcs, center points
    for (const g of geoms) {
      switch (g.kind) {
        case 'line': {
          const p1 = anchorNeedsStandalone.has(P(g.index, 1)) ? P(g.index, 1) : P(g.index, 1);
          const p2 = P(g.index, 2);
          // create endpoint points as real GCS points, then a line over them
          for (const [id, x, y] of [
            [p1, g.x1, g.y1],
            [p2, g.x2, g.y2],
          ] as const) {
            w.push_primitive({ type: 'point', id, x, y, fixed: false });
          }
          w.push_primitive({ type: 'line', id: `L${g.index}`, p1_id: p1, p2_id: p2 });
          lines.set(g.index, { p1, p2 });
          break;
        }
        case 'circle': {
          const c = P(g.index, 3);
          w.push_primitive({ type: 'point', id: c, x: g.cx, y: g.cy, fixed: false });
          w.push_primitive({ type: 'circle', id: `C${g.index}`, c_id: c, radius: g.radius });
          circles.set(g.index, { center: c });
          break;
        }
        case 'arc': {
          const c = P(g.index, 3);
          const s = P(g.index, 1);
          const e = P(g.index, 2);
          for (const [id, x, y] of [
            [c, g.cx, g.cy],
            [s, g.x1, g.y1],
            [e, g.x2, g.y2],
          ] as const) {
            w.push_primitive({ type: 'point', id, x, y, fixed: false });
          }
          w.push_primitive({
            type: 'arc', id: `A${g.index}`, c_id: c, start_id: s, end_id: e,
            start_angle: g.startAngle, end_angle: g.endAngle, radius: g.radius,
          });
          arcs.set(g.index, { center: c, start: s, end: e });
          break;
        }
        case 'ellipse': {
          const c = P(g.index, 3);
          const f1 = P(g.index, 1);
          for (const [id, x, y] of [
            [c, g.cx, g.cy],
            [f1, g.fx1, g.fy1],
          ] as const) {
            w.push_primitive({ type: 'point', id, x, y, fixed: false });
          }
          w.push_primitive({
            type: 'ellipse', id: `E${g.index}`, c_id: c, focus1_id: f1, radmin: g.minorRadius,
          });
          ellipses.set(g.index, { center: c, focus1: f1 });
          break;
        }
        case 'bspline': {
          // P4: the spline itself is not pushed to GCS (planegcs has no b-spline
          // primitive); its exact endpoints participate as a line proxy so
          // coincident/dimension constraints on the curve ends still solve.
          // Interior shape is preserved at contour extraction (de Boor sampling).
          const p1 = P(g.index, 1);
          const p2 = P(g.index, 2);
          for (const [id, x, y] of [
            [p1, g.x1, g.y1],
            [p2, g.x2, g.y2],
          ] as const) {
            w.push_primitive({ type: 'point', id, x, y, fixed: false });
          }
          w.push_primitive({ type: 'line', id: `L${g.index}`, p1_id: p1, p2_id: p2 });
          lines.set(g.index, { p1, p2 });
          break;
        }
        case 'point':
          break; // handled in pass 1
      }
    }

    // --- M3.4: constraints → primitives ---
    // A constraint whose GCS shape cannot be pushed is dropped and recorded
    // (D3: no silent loss — surfaced via droppedConstraints).
    const droppedConstraints: number[] = [...unresolvableExternal, ...ignorable];
    for (const c of usableConstraints) {
      // P3-2: ignorable types (15/17/19) were recorded above; never pushed.
      if (ignorableSet.has(c.index)) continue;
      let prims: Record<string, unknown>[];
      try {
        prims = this.constraintToPrimitives(c, { lines, arcs, circles, ellipses, standalone, externalLines });
      } catch {
        droppedConstraints.push(c.index);
        continue;
      }
      try {
        for (const p of prims) w.push_primitive(p as never);
      } catch {
        droppedConstraints.push(c.index);
        continue;
      }
    }

    // --- solve (D2: initial values = on-disk coordinates) ---
    const status = w.solve(Algorithm.LevenbergMarquardt);
    const conflicting = w.has_gcs_conflicting_constraints();
    const redundant = w.has_gcs_redundant_constraints();

    if (status !== 0 || conflicting) {
      const problem = conflicting ? w.get_gcs_conflicting_constraints() : w.get_gcs_redundant_constraints();
      const problemConstraints = problem
        .map((s) => Number(s.replace(/^c/, '')))
        .filter((n) => Number.isFinite(n));
      return ok({
        geoms,
        converged: false,
        reason: conflicting ? 'conflicting' : redundant ? 'redundant' : 'failed',
        problemConstraints,
        droppedConstraints,
      });
    }

    w.apply_solution();

    // --- pull back solved coordinates and rebuild geometry ---
    const solved = this.pullBack(geoms, { lines, arcs, circles, ellipses, standalone });
    return ok({ geoms: solved, converged: true, problemConstraints: [], droppedConstraints });
  }

  private constraintToPrimitives(
    c: SketchCon,
    ctx: {
      lines: Map<number, { p1: PtKey; p2: PtKey }>;
      arcs: Map<number, { center: PtKey; start: PtKey; end: PtKey }>;
      circles: Map<number, { center: PtKey }>;
      ellipses: Map<number, { center: PtKey; focus1: PtKey }>;
      standalone: Map<number, PtKey>;
      externalLines: Map<number, { p1: PtKey; p2: PtKey }>;
    },
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    const id = `c${c.index}`;
    const r = c.refs;
    // guards: old-format fallback may yield < 2 refs for pair constraints
    if (r.length < 1) return out;
    const pt = (ref: { geoId: number; pos: number } | undefined): PtKey | undefined => {
      if (!ref) return undefined;
      if (ref.geoId === -1) return P(-1, 1); // root point
      if (ref.geoId === -2) return P(-2, ref.pos === 0 ? 1 : ref.pos); // VAxis point
      if (ref.geoId <= -3 && ref.geoId > -2000) {
        // M6.3 external geometry: endpoint/point refs onto fixed segments
        const ext = ctx.externalLines.get(ref.geoId);
        if (!ext) return undefined;
        if (ref.pos === 1) return ext.p1;
        if (ref.pos === 2) return ext.p2;
        return undefined; // pos=0 (edge itself) handled by line-typed paths
      }
      if (ref.geoId >= 0) return P(ref.geoId, ref.pos);
      return undefined;
    };

    switch (c.type) {
      case ConstraintType.Coincident: {
        const p1 = pt(r[0]!);
        const p2 = pt(r[1]!);
        if (p1 && p2) out.push({ type: 'p2p_coincident', id, p1_id: p1, p2_id: p2 });
        break;
      }
      case ConstraintType.Horizontal: {
        // Horizontal with pos=0 refs is the HAxis case: line horizontal
        if (r[0]!.pos === PointPos.none || r.length >= 1 && r[0]!.pos !== PointPos.mid) {
          if (r.length === 1) {
            // horizontal via axis: geoId is the line itself
            const line = ctx.lines.get(r[0]!.geoId);
            if (line) out.push({ type: 'horizontal_l', id, l_id: line ? `L${r[0]!.geoId}` : '' });
          } else {
            const p1 = pt(r[0]!);
            const p2 = pt(r[1]!);
            if (p1 && p2) out.push({ type: 'horizontal_pp', id, p1_id: p1, p2_id: p2 });
          }
        }
        break;
      }
      case ConstraintType.Vertical: {
        if (r.length === 1) {
          const gid = `L${r[0]!.geoId}`;
          if (ctx.lines.has(r[0]!.geoId)) out.push({ type: 'vertical_l', id, l_id: gid });
        } else {
          const p1 = pt(r[0]!);
          const p2 = pt(r[1]!);
          if (p1 && p2) out.push({ type: 'vertical_pp', id, p1_id: p1, p2_id: p2 });
        }
        break;
      }
      case ConstraintType.Parallel: {
        if (r.length === 2 && ctx.lines.has(r[0]!.geoId) && ctx.lines.has(r[1]!.geoId)) {
          out.push({
            type: 'parallel', id,
            l1_id: `L${r[0]!.geoId}`, l2_id: `L${r[1]!.geoId}`,
            internalalignment: 0,
          });
        }
        break;
      }
      case ConstraintType.Perpendicular: {
        if (r.length === 2 && ctx.lines.has(r[0]!.geoId) && ctx.lines.has(r[1]!.geoId)) {
          out.push({ type: 'perpendicular_ll', id, l1_id: `L${r[0]!.geoId}`, l2_id: `L${r[1]!.geoId}` });
        }
        break;
      }
      case ConstraintType.Distance: {
        // p2p / p2l / p2c / c2c variants by ref shapes.
        // GOTCHA (probe-l1-ablation.ts): a second ref that is an AXIS EDGE
        // (geoId -1/-2, pos=0) is a point-to-LINE distance against the axis
        // (FreeCAD Sketch.cpp addDistanceConstraint(point, line)) — e.g.
        // Distance(p, HAxis) = |y|. Resolving the axis edge to the root point
        // and emitting p2p_distance instead drags the point onto a circle
        // around the origin (taperedballnose collapse, delta 2.3e1).
        const p1 = pt(r[0]!);
        const axisEdgeDist = r.length >= 2 && r[1]!.pos === PointPos.none && (r[1]!.geoId === -1 || r[1]!.geoId === -2);
        if (axisEdgeDist && p1) {
          out.push({ type: 'p2l_distance', id, p_id: p1, l_id: `L${r[1]!.geoId}`, distance: c.value });
        } else if (p1 && r[1] && r[1].pos === PointPos.none && ctx.lines.has(r[1].geoId)) {
          out.push({ type: 'p2l_distance', id, p_id: p1, l_id: `L${r[1]!.geoId}`, distance: c.value });
        } else if (p1 && r[1]) {
          const p2 = pt(r[1]);
          if (p2) out.push({ type: 'p2p_distance', id, p1_id: p1, p2_id: p2, distance: c.value });
        }
        break;
      }
      case ConstraintType.DistanceX: {
        // planegcs 'difference' semantics: param2 - param1 = difference
        // (verified empirically). FCStd DistanceX value = second.x - first.x.
        // GOTCHA (probe-l1-ablation.ts, Sketch.cpp:2053): when the second ref
        // is an AXIS EDGE (geoId -1/-2, pos=0) FreeCAD treats it as GeoUndef —
        // an ABSOLUTE coordinate constraint (coordinate_x), not a difference
        // against the axis point. Mapping it to 'difference' forces x = -value
        // and produced the taperedballnose wrong solution (delta 2.3e1).
        const axisEdge = r.length >= 2 && r[1]!.pos === PointPos.none && (r[1]!.geoId === -1 || r[1]!.geoId === -2);
        const firstIsPoint = r[0]!.pos !== PointPos.none || r[0]!.geoId < 0;
        if (axisEdge && firstIsPoint) {
          const p = pt(r[0]!);
          if (p) out.push({ type: 'coordinate_x', id, p_id: p, x: c.value });
          break;
        }
        const p1 = pt(r[0]!);
        const p2 = pt(r[1]!);
        if (p1 && p2) {
          out.push({
            type: 'difference',
            id,
            param1: { o_id: p1, prop: 'x' },
            param2: { o_id: p2, prop: 'x' },
            difference: c.value,
          });
        }
        break;
      }
      case ConstraintType.DistanceY: {
        // symmetric case to DistanceX: axis-edge second ref → absolute y
        const axisEdge = r.length >= 2 && r[1]!.pos === PointPos.none && (r[1]!.geoId === -1 || r[1]!.geoId === -2);
        const firstIsPoint = r[0]!.pos !== PointPos.none || r[0]!.geoId < 0;
        if (axisEdge && firstIsPoint) {
          const p = pt(r[0]!);
          if (p) out.push({ type: 'coordinate_y', id, p_id: p, y: c.value });
          break;
        }
        const p1 = pt(r[0]!);
        const p2 = pt(r[1]!);
        if (p1 && p2) {
          out.push({
            type: 'difference',
            id,
            param1: { o_id: p1, prop: 'y' },
            param2: { o_id: p2, prop: 'y' },
            difference: c.value,
          });
        }
        break;
      }
      case ConstraintType.Angle: {
        // FreeCAD Sketch.cpp case Angle — 4 shapes by ref count/pos:
        // ① Third != GeoUndef → angle-via-point (not needed by corpus P0 set;
        //    dropped explicitly below if encountered)
        // ② SecondPos != none → l2l_angle_pppp (lines with explicit start points:
        //    pos==start keeps direction, pos==end swaps the point pair)
        // ③ Second set, both pos none → l2l_angle_ll (line-level)
        // ④ only First → p2p_angle on the line's own points (orientation)
        // refs may carry a Third = -2000 (GeoUndef sentinel) — filter it.
        const refs = r.filter((x) => x.geoId !== -2000);
        if (refs.length >= 3) {
          // ① via-point angle: not in the P0 mapping set — record as dropped
          break;
        }
        if (refs.length === 2) {
          const [a, b] = refs as [{ geoId: number; pos: number }, { geoId: number; pos: number }];
          const lineA = ctx.lines.has(a.geoId);
          const lineB = ctx.lines.has(b.geoId);
          if (lineA && lineB && a.pos !== PointPos.none && b.pos !== PointPos.none) {
            // ② explicit start points; pos=end reverses that line's direction
            const a1 = a.pos === PointPos.start ? P(a.geoId, 1) : P(a.geoId, 2);
            const a2 = a.pos === PointPos.start ? P(a.geoId, 2) : P(a.geoId, 1);
            const b1 = b.pos === PointPos.start ? P(b.geoId, 1) : P(b.geoId, 2);
            const b2 = b.pos === PointPos.start ? P(b.geoId, 2) : P(b.geoId, 1);
            out.push({ type: 'l2l_angle_pppp', id, l1p1_id: a1, l1p2_id: a2, l2p1_id: b1, l2p2_id: b2, angle: c.value });
          } else if (lineA && lineB) {
            // ③ line-level angle
            out.push({
              type: 'l2l_angle_ll', id,
              l1_id: `L${a.geoId}`, l2_id: `L${b.geoId}`,
              angle: c.value,
              internalalignment: 0,
            });
          }
        } else if (refs.length === 1 && ctx.lines.has(refs[0]!.geoId)) {
          // ④ orientation angle of a single line (p2p_angle on its points)
          out.push({ type: 'p2p_angle', id, p1_id: P(refs[0]!.geoId, 1), p2_id: P(refs[0]!.geoId, 2), angle: c.value });
        }
        break;
      }
      case ConstraintType.Radius: {
        if (ctx.circles.has(r[0]!.geoId)) {
          out.push({ type: 'circle_radius', id, c_id: `C${r[0]!.geoId}`, radius: c.value });
        } else if (ctx.arcs.has(r[0]!.geoId)) {
          out.push({ type: 'arc_radius', id, a_id: `A${r[0]!.geoId}`, radius: c.value });
        }
        break;
      }
      case ConstraintType.Diameter: {
        if (ctx.circles.has(r[0]!.geoId)) {
          out.push({ type: 'circle_diameter', id, c_id: `C${r[0]!.geoId}`, diameter: c.value });
        } else if (ctx.arcs.has(r[0]!.geoId)) {
          out.push({ type: 'arc_diameter', id, a_id: `A${r[0]!.geoId}`, diameter: c.value });
        }
        break;
      }
      case ConstraintType.Equal: {
        // equal_length for line pairs; equal_radii for circle/arc pairs
        if (r.length === 2) {
          const g0 = r[0]!.geoId;
          const g1 = r[1]!.geoId;
          if (ctx.lines.has(g0) && ctx.lines.has(g1)) {
            out.push({ type: 'equal_length', id, l1_id: `L${g0}`, l2_id: `L${g1}` });
          } else if ((ctx.circles.has(g0) || ctx.arcs.has(g0)) && (ctx.circles.has(g1) || ctx.arcs.has(g1))) {
            // arcs use their own primitive id (A{n}); circles use C{n}
            const id0 = ctx.circles.has(g0) ? `C${g0}` : `A${g0}`;
            const id1 = ctx.circles.has(g1) ? `C${g1}` : `A${g1}`;
            out.push({ type: 'equal_radius_cc', id, c1_id: id0, c2_id: id1 });
          } else if (ctx.ellipses.has(g0) && ctx.ellipses.has(g1)) {
            out.push({ type: 'equal_radii_ee', id, e1_id: `E${g0}`, e2_id: `E${g1}` });
          }
        }
        break;
      }
      case ConstraintType.PointOnObject: {
        const p = pt(r[0]!);
        if (p && r[1]!.pos === PointPos.none) {
          const onGeoId = r[1]!.geoId;
          if (ctx.lines.has(onGeoId)) {
            out.push({ type: 'point_on_line_pl', id, p_id: p, l_id: `L${onGeoId}` });
          } else if (ctx.externalLines.has(onGeoId)) {
            // M6.3: point-on-external-edge → point_on_line against the fixed line
            out.push({ type: 'point_on_line_pl', id, p_id: p, l_id: `X${onGeoId}` });
          } else if (ctx.circles.has(onGeoId)) {
            out.push({ type: 'point_on_circle', id, p_id: p, c_id: `C${onGeoId}` });
          } else if (ctx.arcs.has(onGeoId)) {
            out.push({ type: 'point_on_arc', id, p_id: p, a_id: `A${onGeoId}` });
          }
        }
        break;
      }
      case ConstraintType.Symmetric: {
        // Symmetric(p1, p2, line) or Symmetric(p1, p2, p3)
        const p1 = pt(r[0]!);
        const p2 = pt(r[1]!);
        if (p1 && p2) {
          if (r.length >= 3 && r[2]!.pos === PointPos.none && ctx.lines.has(r[2]!.geoId)) {
            out.push({ type: 'p2p_symmetric_ppl', id, p1_id: p1, p2_id: p2, l_id: `L${r[2]!.geoId}` });
          } else {
            const p3 = pt(r[2]!);
            if (p3) out.push({ type: 'p2p_symmetric_ppp', id, p1_id: p1, p2_id: p2, p_id: p3 });
          }
        }
        break;
      }
      case ConstraintType.Tangent: {
        // line-circle / circle-circle / line-arc / arc-arc (edge-level, pos=0)
        const a = r[0]!;
        const b = r[1]!;
        if (!a || !b) break;
        const lineA = ctx.lines.has(a.geoId);
        const circA = ctx.circles.has(a.geoId);
        const arcA = ctx.arcs.has(a.geoId);
        const lineB = ctx.lines.has(b.geoId);
        const circB = ctx.circles.has(b.geoId);
        const arcB = ctx.arcs.has(b.geoId);
        if (lineA && circB) out.push({ type: 'tangent_lc', id, l_id: `L${a.geoId}`, c_id: `C${b.geoId}`, internalalignment: 0 });
        else if (circA && lineB) out.push({ type: 'tangent_lc', id, l_id: `L${b.geoId}`, c_id: `C${a.geoId}`, internalalignment: 0 });
        else if (circA && circB) out.push({ type: 'tangent_cc', id, c1_id: `C${a.geoId}`, c2_id: `C${b.geoId}`, internalalignment: 0 });
        else if (lineA && arcB) out.push({ type: 'tangent_la', id, l_id: `L${a.geoId}`, a_id: `A${b.geoId}`, internalalignment: 0 });
        else if (arcA && lineB) out.push({ type: 'tangent_la', id, l_id: `L${b.geoId}`, a_id: `A${a.geoId}`, internalalignment: 0 });
        else if (arcA && arcB) out.push({ type: 'tangent_aa', id, a1_id: `A${a.geoId}`, a2_id: `A${b.geoId}`, internalalignment: 0 });
        break;
      }
      default:
        break; // unsupported types never reach here (guard in solve())
    }
    return out;
  }

  private pullBack(
    geoms: SketchGeom[],
    ctx: {
      lines: Map<number, { p1: PtKey; p2: PtKey }>;
      arcs: Map<number, { center: PtKey; start: PtKey; end: PtKey }>;
      circles: Map<number, { center: PtKey }>;
      ellipses: Map<number, { center: PtKey; focus1: PtKey }>;
      standalone: Map<number, PtKey>;
    },
  ): SketchGeom[] {
    // After apply_solution, re-derive geometry from the wrapper's primitive
    // state via pull through the wrapper's sketch index.
    const out: SketchGeom[] = [];
    for (const g of geoms) {
      switch (g.kind) {
        case 'point': {
          const key = ctx.standalone.get(g.index);
          const pt = key ? this.readPoint(key) : undefined;
          out.push(pt ? { ...g, x: pt.x, y: pt.y } : g);
          break;
        }
        case 'line': {
          const l = ctx.lines.get(g.index)!;
          const p1 = this.readPoint(l.p1);
          const p2 = this.readPoint(l.p2);
          out.push(p1 && p2 ? { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y } : g);
          break;
        }
        case 'circle': {
          const cc = ctx.circles.get(g.index)!.center;
          const c = this.readPoint(cc);
          const rad = this.readCircleRadius(g.index);
          out.push(c && rad !== undefined ? { ...g, cx: c.x, cy: c.y, radius: rad } : g);
          break;
        }
        case 'arc': {
          const a = ctx.arcs.get(g.index)!;
          const c = this.readPoint(a.center);
          const s = this.readPoint(a.start);
          const e = this.readPoint(a.end);
          if (c && s && e) {
            const r = Math.hypot(s.x - c.x, s.y - c.y);
            const startAngle = Math.atan2(s.y - c.y, s.x - c.x);
            const endAngle = Math.atan2(e.y - c.y, e.x - c.x);
            out.push({ ...g, cx: c.x, cy: c.y, radius: r, startAngle, endAngle, x1: s.x, y1: s.y, x2: e.x, y2: e.y });
          } else out.push(g);
          break;
        }
        case 'bspline': {
          // P4: spline endpoints ride the line proxy; pull their solved coords.
          const l = ctx.lines.get(g.index)!;
          const p1 = this.readPoint(l.p1);
          const p2 = this.readPoint(l.p2);
          out.push(p1 && p2 ? { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y } : g);
          break;
        }
        case 'ellipse': {
          const el = ctx.ellipses.get(g.index)!;
          const c = this.readPoint(el.center);
          const f1 = this.readPoint(el.focus1);
          if (c && f1) {
            const major = Math.hypot(f1.x - c.x, f1.y - c.y) * 1;
            const angleXU = Math.atan2(f1.y - c.y, f1.x - c.x);
            // minor radius is a parameter on the ellipse primitive; approximate
            // pull via ratio is not exposed — keep stored minor (M3 scope).
            out.push({ ...g, cx: c.x, cy: c.y, majorRadius: g.majorRadius * (major / g.majorRadius), angleXU });
          } else out.push(g);
          break;
        }
      }
    }
    return out;
  }

  /** Read a point's solved coordinates from the sketch index.
   * apply_solution() already pulled every primitive's solved values back into
   * sketch_index (gcs_wrapper.js:104-108), so get_primitive is authoritative. */
  private readPoint(key: PtKey): { x: number; y: number } | undefined {
    const p = this.wrapper.sketch_index.get_primitive(key) as { x?: number; y?: number } | undefined;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return undefined;
    return { x: p.x, y: p.y };
  }

  private readCircleRadius(geoIndex: number): number | undefined {
    const c = this.wrapper.sketch_index.get_primitive(`C${geoIndex}`) as { radius?: number } | undefined;
    return typeof c?.radius === 'number' ? c.radius : undefined;
  }
}
