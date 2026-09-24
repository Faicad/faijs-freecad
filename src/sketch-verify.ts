/**
 * M3.5 — solved-vs-stored comparison (D2/V2).
 *
 * The on-disk coordinates ARE FreeCAD's last solution, so a correct pipeline
 * re-derives (nearly) the same geometry. maxPointDistance is the V2 metric;
 * its tolerance T1 is calibrated from the sample-set distribution, not
 * pre-set (plan §8).
 */
import type { SketchGeom } from './sketch-parse.js';
import type { SolveOutcome } from './sketch-solver.js';

/**
 * P4: exported for testability — anchor points used by maxPointDistance.
 *
 * @param g - the sketch geometry element (point/line/circle/arc/ellipse/bspline).
 * @returns the element's comparison anchor points (center/endpoints as applicable).
 */
export function anchorPoints(g: SketchGeom): { x: number; y: number }[] {
  switch (g.kind) {
    case 'point':
      return [{ x: g.x, y: g.y }];
    case 'line':
      return [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
    case 'circle':
      return [{ x: g.cx, y: g.cy }];
    case 'arc':
      return [{ x: g.cx, y: g.cy }, { x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
    case 'ellipse':
      return [{ x: g.cx, y: g.cy }];
    case 'bspline':
      // P4: spline anchors are its exact endpoints (poles move with them)
      return [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
  }
}

/**
 * Maximum anchor-point distance between two geometry lists (same indexing).
 *
 * @param a - first geometry list (e.g. the solver result).
 * @param b - second geometry list (e.g. the stored geometry).
 * @returns the maximum Euclidean distance between corresponding anchor points
 *   (0 when the lists have no comparable points).
 */
export function maxPointDistance(a: SketchGeom[], b: SketchGeom[]): number {
  let max = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const pa = anchorPoints(a[i]!);
    const pb = anchorPoints(b[i]!);
    const m = Math.min(pa.length, pb.length);
    for (let k = 0; k < m; k++) {
      const d = Math.hypot(pa[k]!.x - pb[k]!.x, pa[k]!.y - pb[k]!.y);
      if (Number.isFinite(d) && d > max) max = d;
    }
  }
  return max;
}

/**
 * Three-level downgrade verdict (D3) for one sketch.
 */
export interface SketchVerdict {
  /** solved quality level: L0 = solved & matches, L1 = flagged, L2 = baked */
  level: 'L0' | 'L1' | 'L2';
  /** human-readable reason for a non-L0 verdict */
  reason?: string;
  /** max anchor distance between re-solved and stored geometry */
  maxDelta?: number;
}

/**
 * Three-level downgrade (D3). L0 = solved & matches stored (delta <= T1).
 * L1 = solver result kept but flagged, stored coords used instead.
 * L2 = baked (unsupported geometry/constraints, external geometry).
 *
 * @param outcome - the solver result, or undefined when none was produced.
 * @param stored - the on-disk (stored) geometry to compare against.
 * @param t1 - the calibrated distance tolerance for the L0/L1 split.
 * @param preBlocked - pre-solve downgrade reason; when set the sketch is L2.
 * @returns the classification verdict for the sketch.
 */
export function classifySketch(
  outcome: SolveOutcome | undefined,
  stored: SketchGeom[],
  t1: number,
  preBlocked?: string,
): SketchVerdict {
  if (preBlocked) return { level: 'L2', reason: preBlocked };
  if (!outcome) return { level: 'L2', reason: 'no-solver-result' };
  if (!outcome.converged) {
    return { level: 'L1', reason: outcome.reason ?? 'solve-failed' };
  }
  const maxDelta = maxPointDistance(outcome.geoms, stored);
  if (maxDelta <= t1) return { level: 'L0', maxDelta };
  return { level: 'L1', reason: 'delta-exceeds-t1', maxDelta };
}
