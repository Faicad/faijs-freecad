/**
 * Constraint-topology closed-loop discriminator for the parametric
 * `cad.sketch` emission gate.
 *
 * Background (K 组 2026-10-04): the convert-time zero-loop verdict
 * (`verdict.loopCount === 0`) CANNOT gate the emission by itself —
 * Kitchen_cabinet's Sketch037 et al. precheck as zero-loop yet run fine,
 * because the run-time op RE-SOLVES the constraints first and the coincident
 * endpoints snap together before `extractContours` chains by coordinates.
 * Maxim Air's Sketch188 (a genuinely open 2-line V) throws
 * E_SKETCHC_NO_CONTOUR with the SAME convert-time verdict. The two are
 * separated only by the CONSTRAINT TOPOLOGY: does the profile segment graph —
 * endpoints identified through `coincident` constraints and numeric
 * coincidence (≤ 1e-7, the same tolerance the run-time chaining uses) —
 * contain a cycle?
 *
 * Connectivity mirrors `contour.ts::extractContours` exactly:
 * - joinable profile segments: non-construction `line` / `arc` / `bspline`
 *   (a bspline chains via its first/last pole);
 * - self-closed: non-construction `circle` → loop by itself;
 * - everything else (points, ellipses — `segEnds` returns undefined for them)
 *   and construction geometry does NOT participate;
 * - construction-mediated closure does NOT count: a coincident chain THROUGH
 *   a construction line does not make two profile endpoints meet (the
 *   construction segment is not in the run-time contour pool).
 */
import type { At, Ref, SketchConstraint, SketchGeom } from '@faicad/faijs-sketch';

interface P {
  x: number
  y: number
}

/** The two chainable endpoints of a segment geometry, or undefined when the kind cannot join a contour chain. */
function endpointPair(g: SketchGeom): [P, P] | undefined {
  switch (g.kind) {
    case 'line':
      return [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
    case 'arc':
      // canonical arc: center + radius + start/end angles (radians)
      return [
        { x: g.cx + g.r * Math.cos(g.a0), y: g.cy + g.r * Math.sin(g.a0) },
        { x: g.cx + g.r * Math.cos(g.a1), y: g.cy + g.r * Math.sin(g.a1) },
      ];
    case 'bspline': {
      const first = g.poles[0];
      const last = g.poles[g.poles.length - 1];
      if (!first || !last) return undefined;
      return [{ x: first.x, y: first.y }, { x: last.x, y: last.y }];
    }
    default:
      return undefined; // circle self-closes; ellipse/point never join (segEnds default)
  }
}

/** Map a Ref's `at` to a segment endpoint ordinal, or undefined for non-endpoint anchors (mid/center/exotic numerics). */
function endOrdinal(at: At | undefined): 0 | 1 | undefined {
  if (at === undefined || at === 'start' || at === 0) return 0;
  if (at === 'end' || at === 1) return 1;
  return undefined;
}

/**
 * @param geoms canonical sketch geometry (the would-be `cad.sketch` inputs)
 * @param constraints canonical constraints travelling with them
 * @returns true when a closed profile loop is topologically guaranteed —
 *   emit the parametric `cad.sketch`; false when the profile is provably open
 *   (the run-time op will throw E_SKETCHC_NO_CONTOUR — bake with an explicit
 *   gap instead of shipping a guaranteed run failure).
 */
export function hasConstraintClosedLoop(geoms: SketchGeom[], constraints: SketchConstraint[]): boolean {
  // self-closed profiles: any non-construction circle is a loop on its own
  for (const g of geoms) {
    if (!g.construction && g.kind === 'circle' && g.r > 0) return true;
  }

  // profile segments that can chain (same set extractContours pools)
  const segs: { i: number; a: P; b: P }[] = [];
  for (let i = 0; i < geoms.length; i++) {
    const g = geoms[i]!;
    if (g.construction) continue;
    const ends = endpointPair(g);
    if (ends) segs.push({ i, a: ends[0], b: ends[1] });
  }
  if (segs.length === 0) return false;

  // union-find over endpoint nodes keyed `${geomIndex}:${0|1}`
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    let cur = x;
    while (cur !== root) {
      const nxt = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = nxt;
    }
    return root;
  };
  /** false = the two nodes were ALREADY connected (a cycle closes) */
  const union = (x: string, y: string): boolean => {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return false;
    parent.set(rx, ry);
    return true;
  };

  // 1. coincident constraints between two PROFILE endpoints (construction
  //    refs are ignored: they anchor construction geometry, they never merge
  //    two profile points)
  const tagIdx = new Map<string, number>();
  for (let i = 0; i < geoms.length; i++) {
    const t = geoms[i]?.tag;
    if (t !== undefined) tagIdx.set(t, i);
  }
  const profileSeg = new Set(segs.map((s) => s.i));
  const resolve = (ref: Ref): { i: number; end: 0 | 1 } | undefined => {
    const i = 'index' in ref ? ref.index : tagIdx.get(ref.tag);
    if (i === undefined || !profileSeg.has(i)) return undefined;
    const end = endOrdinal(ref.at);
    return end === undefined ? undefined : { i, end };
  };
  for (const c of constraints) {
    if (c.kind !== 'coincident') continue;
    const p = resolve(c.a);
    const q = resolve(c.b);
    if (!p || !q) continue;
    if (p.i === q.i && p.end === q.end) continue;
    union(`${p.i}:${p.end}`, `${q.i}:${q.end}`);
  }

  // 2. numeric coincidence between endpoints of DIFFERENT profile segments —
  //    the run-time chaining joins coordinates within 1e-7 with or without a
  //    constraint, so the topology check must see the same identity
  const eps = 1e-7;
  for (let x = 0; x < segs.length; x++) {
    const sx = segs[x]!;
    for (let y = x + 1; y < segs.length; y++) {
      const sy = segs[y]!;
      for (const [ex, ey] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
        const px = ex === 0 ? sx.a : sx.b;
        const py = ey === 0 ? sy.a : sy.b;
        if (Math.hypot(px.x - py.x, px.y - py.y) <= eps) {
          union(`${sx.i}:${ex}`, `${sy.i}:${ey}`);
        }
      }
    }
  }

  // 3. cycle detection: add each profile segment as an edge between its
  //    endpoint classes; an edge whose ends are already connected closes a
  //    cycle — exactly the chain extractContours' DFS would find
  for (const s of segs) {
    if (!union(`${s.i}:0`, `${s.i}:1`)) return true;
  }
  return false;
}
