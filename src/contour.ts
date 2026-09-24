/**
 * M3.6 — contour extraction: solved sketch geometry → closed loops → 2D
 * contour (R6: pure data, no OCCT dependency; the cad-face wiring that turns
 * contours into Blueprint/extrude inputs happens in M4.6/M5).
 *
 * Extraction: collect endpoints of every non-construction geometry, chain
 * segments sharing endpoints (tolerance-based), keep closed loops.
 */
import type { SketchGeom } from './sketch-parse.js';
import { bsplineToSegments } from './bspline.js';

/** One segment of a 2D contour: either a straight line or a circular arc (planar, sketch-local coordinates). */
export type ContourSeg =
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | {
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
    };

/** A chained run of segments; `closed` when the chain's ends meet (R6: pure data, no OCCT dependency). */
export interface Contour {
  /** chained segments in traversal order */
  segments: ContourSeg[];
  /** true when the chain's endpoints meet within JOIN_TOL */
  closed: boolean;
}

const JOIN_TOL = 1e-7;

function segEnds(g: SketchGeom): [ContourSeg, { x: number; y: number }, { x: number; y: number }] | undefined {
  switch (g.kind) {
    case 'line':
      return [
        { kind: 'line', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 },
        { x: g.x1, y: g.y1 },
        { x: g.x2, y: g.y2 },
      ];
    case 'arc':
      return [
        {
          kind: 'arc', cx: g.cx, cy: g.cy, radius: g.radius,
          startAngle: g.startAngle, endAngle: g.endAngle, ccw: true,
          x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
        },
        { x: g.x1, y: g.y1 },
        { x: g.x2, y: g.y2 },
      ];
    case 'bspline': {
      // P4: flatten the spline into a sampled polyline. Only the FIRST
      // sub-segment is returned here so the pool gets exactly one entry per
      // geometry (no index duplication); extractContours splices the full
      // polyline run in its place (see expandBSpline below).
      const segs = bsplineToSegments({
        poles: g.poles, knots: g.knots, degree: g.degree, periodic: g.periodic,
      });
      const first = segs[0];
      const last = segs[segs.length - 1];
      if (!first || !last) return undefined;
      return [{ kind: 'line', x1: first.x1, y1: first.y1, x2: last.x2, y2: last.y2 }, { x: first.x1, y: first.y1 }, { x: last.x2, y: last.y2 }];
    }
    default:
      return undefined; // circles are closed on their own; points don't join
  }
}

/**
 * Extract closed contours (chains of segments whose endpoints meet).
 * @param geoms solved sketch geometry to chain (non-construction segments only)
 * @returns closed loops plus self-closed circles (open chains are dropped)
 */
export function extractContours(geoms: SketchGeom[]): Contour[] {
  const pool: { seg: ContourSeg; a: { x: number; y: number }; b: { x: number; y: number }; used: boolean; spline?: { x1: number; y1: number; x2: number; y2: number }[] }[] = [];
  for (const g of geoms) {
    const s = segEnds(g);
    if (!s) continue;
    // P4: keep the full sampled polyline for splines — after chaining, the
    // winning seg is expanded back into all sub-segments (no interior loss).
    const spline = g.kind === 'bspline'
      ? bsplineToSegments({ poles: g.poles, knots: g.knots, degree: g.degree, periodic: g.periodic })
      : undefined;
    pool.push({ seg: s[0], a: s[1], b: s[2], used: false, spline });
  }

  const near = (p: { x: number; y: number }, q: { x: number; y: number }): boolean =>
    Math.hypot(p.x - q.x, p.y - q.y) <= JOIN_TOL;

  const contours: Contour[] = [];
  for (const start of pool) {
    if (start.used) continue;
    start.used = true;
    const head = start.a;
    // GOTCHA (slittingsaw corpus, 2026-09-20): junction points with free
    // branches (three+ segments sharing an endpoint) defeat first-come
    // chaining — a branch to a dead end consumed the segments and the real
    // loop never closed. DFS with backtracking: try each candidate
    // continuation; the FIRST chain that closes at the head wins; a dead
    // branch returns its segments to the pool. Closure-stop (tap GOTCHA) and
    // pool-restart are both subsumed by the DFS ordering.
    const dfs = (tail: { x: number; y: number }, walk: ContourSeg[]): ContourSeg[] | undefined => {
      if (walk.length > 0 && near(tail, head)) return walk;
      for (const cand of pool) {
        if (cand.used) continue;
        cand.used = true;
        if (near(tail, cand.a)) {
          const r = dfs(cand.b, [...walk, cand.seg]);
          if (r) return r;
        } else if (near(tail, cand.b)) {
          const r = dfs(cand.a, [...walk, reverseSeg(cand.seg)]);
          if (r) return r;
        }
        cand.used = false; // dead branch — return the segment to the pool
      }
      return undefined;
    };
    const solved = dfs(start.b, [start.seg]);
    if (solved && solved.length > 1) {
      // P4: replace spline proxy segs with their full sampled polyline runs.
      // The proxy seg for geometry index i sits in pool order; recover the
      // spline runs by matching the seg reference against pool entries.
      const expanded: ContourSeg[] = [];
      for (const seg of solved) {
        const entry = pool.find((e) => e.seg === seg && e.spline);
        if (entry?.spline) {
          for (const sub of entry.spline) {
            expanded.push({ kind: 'line', x1: sub.x1, y1: sub.y1, x2: sub.x2, y2: sub.y2 });
          }
        } else {
          expanded.push(seg);
        }
      }
      contours.push({ segments: expanded, closed: true });
    }
  }

  // circles are self-closed contours
  for (const g of geoms) {
    if (g.kind === 'circle' && g.radius > 0) {
      contours.push({
        segments: [{
          kind: 'arc', cx: g.cx, cy: g.cy, radius: g.radius,
          startAngle: 0, endAngle: Math.PI * 2, ccw: true,
          x1: g.cx + g.radius, y1: g.cy, x2: g.cx + g.radius, y2: g.cy,
        }],
        closed: true,
      });
    }
  }
  return contours;
}

function reverseSeg(s: ContourSeg): ContourSeg {
  if (s.kind === 'line') return { kind: 'line', x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 };
  return { ...s, startAngle: s.endAngle, endAngle: s.startAngle, ccw: !s.ccw, x1: s.x2, y1: s.y2, x2: s.x1, y2: s.y1 };
}
