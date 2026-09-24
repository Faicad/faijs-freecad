/**
 * P4 — B-spline curve evaluation for FCStd sketch geometry
 * (Part::GeomBSplineCurve → BSplineCurve element: Poles/Knots/Degree).
 *
 * Contours only need chained endpoints, but a spline interior must be
 * faithfully flattened into the 2D contour it feeds (P4: no-silent-loss —
 * a pole-only bounding approximation would distort Pad/Pocket profiles).
 * Cox–de Boor evaluation over the clamped knot vector is exact at the
 * sampled parameters; sampling density is chord-driven (see sampleBSpline).
 */

/** One control pole (2D sketch-local; Z is 0 for planar sketches). */
export interface BSPole {
  x: number
  y: number
}

/** Parsed BSplineCurve payload (freeCAD stores knots with multiplicity). */
export interface BSplineCurveData {
  poles: BSPole[]
  /** expanded knot vector (length === poles + degree + 1 for a clamped spline) */
  knots: number[]
  degree: number
  periodic: boolean
}

/**
 * Evaluate the B-spline at parameter t via Cox–de Boor recursion.
 * Outside the valid domain [knots[degree], knots[n]] the value is clamped.
 *
 * @param d - the parsed BSplineCurve payload (poles/knots/degree).
 * @param t - the parameter to evaluate (clamped to the valid domain).
 * @returns the evaluated pole (2D point) on the spline.
 */
export function evalBSpline(d: BSplineCurveData, t: number): BSPole {
  const { poles, knots, degree: p } = d;
  const n = knots.length - p - 1; // last span index
  const lo = knots[p]!;
  const hi = knots[n]!;
  const u = Math.min(Math.max(t, lo), hi);
  // find span k such that knots[k] <= u < knots[k+1] (clamped: hi lands in last span)
  let k = p;
  for (let i = p; i < n; i++) {
    if (u >= knots[i]! && u < knots[i + 1]!) {
      k = i;
      break;
    }
  }
  // de Boor: d[j] = poles[j + k - p], j = 0..p; lerp over levels
  const dd: BSPole[] = [];
  for (let j = 0; j <= p; j++) dd.push({ ...poles[j + k - p]! });
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const denom = knots[i + p - r + 1]! - knots[i]!;
      const a = denom === 0 ? 0 : (u - knots[i]!) / denom;
      dd[j] = {
        x: (1 - a) * dd[j - 1]!.x + a * dd[j]!.x,
        y: (1 - a) * dd[j - 1]!.y + a * dd[j]!.y,
      };
    }
  }
  return dd[p]!;
}

/**
 * Sample the spline into a polyline. `min` samples per span, at least the
 * pole count (a degree-3 spline needs ≥ poles points to show its shape).
 * Endpoints are exact (clamped knot vector).
 *
 * @param d - the parsed BSplineCurve payload (poles/knots/degree).
 * @param perSpan - minimum samples per knot span (default 6).
 * @returns the sampled polyline points (first/last are the exact endpoints).
 */
export function sampleBSpline(d: BSplineCurveData, perSpan = 6): BSPole[] {
  const { poles, knots, degree: p } = d;
  if (poles.length === 0) return [];
  if (knots.length < p + 2) return [...poles]; // degenerate: treat as control polygon
  const lo = knots[p]!;
  const hi = knots[knots.length - p - 1]!;
  const spans = Math.max(1, knots.length - 2 * p - 1);
  const count = Math.max(poles.length, spans * perSpan + 1);
  const out: BSPole[] = [];
  for (let i = 0; i < count; i++) {
    const t = lo + ((hi - lo) * i) / (count - 1);
    out.push(evalBSpline(d, t));
  }
  return out;
}

/**
 * Flatten the spline into consecutive straight contour segments (P4: the
 * contour chain only understands line/arc; a sampled polyline preserves the
 * profile within chord tolerance).
 *
 * @param d - the parsed BSplineCurve payload (poles/knots/degree).
 * @param perSpan - minimum samples per knot span (passed to sampleBSpline).
 * @returns the consecutive line segments approximating the spline.
 */
export function bsplineToSegments(d: BSplineCurveData, perSpan = 6): { x1: number; y1: number; x2: number; y2: number }[] {
  const pts = sampleBSpline(d, perSpan);
  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    segs.push({ x1: pts[i - 1]!.x, y1: pts[i - 1]!.y, x2: pts[i]!.x, y2: pts[i]!.y });
  }
  return segs;
}
