/**
 * Audit: NURBS round-trip fidelity for a whole BREP file, edge by edge.
 *
 * Why: A2 (`2026-09-29 plan` §A2) carries `bezier` / `bspline` edges
 * analytically instead of tessellating them, which requires rebuilding each one
 * from `getNurbsCurveData` via `makeBSplineEdge`. Three facts decide whether that
 * is possible, and none can be assumed:
 *
 *  1. **Fidelity.** Does `makeBSplineEdge(poles, weights, knots, multiplicities,
 *     degree, periodic)` — fed exactly what the kernel hands back — reproduce the
 *     source curve? Measured here by sampling both at the SAME absolute
 *     parameter. Comparing at each curve's own normalized `t` reports a bogus
 *     multi-mm "deviation": `getNurbsCurveData` returns the WHOLE basis curve
 *     while `curveParameters` returns the EDGE's trim range on it.
 *  2. **Trim.** An edge is often only a SUB-RANGE of its basis curve (measured:
 *     36 of 150 parametric edges in `PartShape6.brp`). A rebuild that ignores the
 *     trim hands the wire an edge running past its neighbour's start, so A2 also
 *     needs sub-range extraction — measured here through `curveSplit`.
 *  3. **Boundary trims.** `curveSplit` requires a STRICTLY interior parameter, so
 *     a trim that lands exactly on the domain end must skip that side rather than
 *     call the kernel (otherwise `curveSplit: parameter out of range`).
 *
 * Usage: node --import tsx packages/fcstd/scripts/probe-nurbs-roundtrip.ts <shape.brp> [maxReport]
 */
import { readFileSync } from 'node:fs';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';

interface Nr {
  degree: number;
  rational: boolean;
  periodic: boolean;
  knots: number[];
  multiplicities: number[];
  poles: number[];
  weights: number[];
}
interface K {
  fromBREP: (s: string) => number;
  getSubShapes: (s: number, t: string) => number[];
  getShapeType: (s: number) => string;
  curveType: (e: number) => string;
  curveParameters: (e: number) => { first: number; last: number };
  curvePointAtParam: (e: number, p: number) => { x: number; y: number; z: number };
  curveIsClosed: (e: number) => boolean;
  getNurbsCurveData: (e: number) => Nr | null;
  makeBSplineEdge: (
    poles: number[],
    weights: number[],
    knots: number[],
    mult: number[],
    degree: number,
    periodic?: boolean,
  ) => number;
  /** Split an edge at a parameter into two edges (occt-wasm index.d.ts:419). */
  curveSplit: (e: number, param: number) => [number, number];
}

const brpPath = process.argv[2];
if (!brpPath) {
  console.error('usage: probe-nurbs-roundtrip.ts <shape.brp> [maxReport]');
  process.exit(1);
}
const maxReport = Number(process.argv[3] ?? '3');

const kernel = (await initOcctWasm()) as unknown as K;
const shape = kernel.fromBREP(readFileSync(brpPath, 'utf8'));
console.log(`shape=${kernel.getShapeType(shape)}`);

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = (p: { x: number; y: number; z: number }): string =>
  `(${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`;
/** Sample max distance between two curves over the SAME absolute parameter range. */
const compare = (a: number, b: number, first: number, last: number): number => {
  let dev = 0;
  for (let i = 0; i <= 8; i++) {
    const p = first + (i / 8) * (last - first);
    dev = Math.max(dev, dist(kernel.curvePointAtParam(a, p), kernel.curvePointAtParam(b, p)));
  }
  return dev;
};

const kinds = new Map<string, number>();
const stats = {
  paramEdges: 0,
  rebuilt: 0,
  notRebuildable: 0,
  trimmed: 0,
  trimRecovered: 0,
  trimFailed: 0,
  maxDev: 0,
  maxTrimDev: 0,
  rational: 0,
  degrees: new Map<number, number>(),
};
const reported = new Set<string>();

/**
 * `curveSplit` needs a strictly interior parameter. Recover the sub-range
 * `[first, last]` of the basis edge `h` by splitting only on the sides that are
 * actually trimmed — splitting at a domain end throws
 * `curveSplit: parameter out of range`.
 */
function trimTo(h: number, first: number, last: number): number {
  const b = kernel.curveParameters(h);
  const eps = 1e-9 * Math.max(1, Math.abs(b.last - b.first));
  let cur = h;
  if (last < b.last - eps) cur = kernel.curveSplit(cur, last)[0];
  const b2 = kernel.curveParameters(cur);
  if (first > b2.first + eps) cur = kernel.curveSplit(cur, first)[1];
  return cur;
}

const wires = kernel.getSubShapes(shape, 'wire');
const wireHandles: number[] = wires.length > 0 ? wires : [shape];
// Read one wire's edges, analyse them, then move on. GOTCHA (measured
// 2026-09-29): interleaving `makeBSplineEdge`/`curveSplit` allocations with a
// walk over MANY wires at once degrades into `getSubShapes: memory access out of
// bounds`; keeping the read scoped to a single wire avoids it.
for (const w of wireHandles) {
  let edges: number[];
  try {
    edges = kernel.getSubShapes(w, 'edge');
  } catch (err) {
    console.log(`  wire skipped: ${String((err as Error).message).slice(0, 80)}`);
    continue;
  }
  for (const e of edges) {
    try {
      const k = kernel.curveType(e);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      const { first, last } = kernel.curveParameters(e);
      let nr: Nr | null = null;
      try {
        nr = kernel.getNurbsCurveData(e);
      } catch {
        nr = null;
      }
      if (!nr) {
        if (k !== 'line' && k !== 'circle') stats.notRebuildable++;
        continue;
      }
      stats.paramEdges++;
      stats.degrees.set(nr.degree, (stats.degrees.get(nr.degree) ?? 0) + 1);
      if (nr.rational) stats.rational++;
      const h = kernel.makeBSplineEdge(nr.poles, nr.weights, nr.knots, nr.multiplicities, nr.degree, nr.periodic);
      stats.rebuilt++;
      const dev = compare(e, h, first, last);
      const rb = kernel.curveParameters(h);
      const trimmed = Math.abs(rb.first - first) > 1e-9 || Math.abs(rb.last - last) > 1e-9;
      if (trimmed) stats.trimmed++;
      if (dev > stats.maxDev) stats.maxDev = dev;

      if (trimmed) {
        const t = trimTo(h, first, last);
        const tdev = compare(e, t, first, last);
        stats.trimRecovered++;
        stats.maxTrimDev = Math.max(stats.maxTrimDev, tdev);
        if (!reported.has('trim')) {
          reported.add('trim');
          console.log(
            `  trim recovery: ${k} edge=[${first.toFixed(4)}, ${last.toFixed(4)}] basis=[${rb.first.toFixed(4)}, ${rb.last.toFixed(4)}] ` +
              `recoveredDev=${tdev.toExponential(2)}mm endpoint=${fmt(kernel.curvePointAtParam(t, kernel.curveParameters(t).last))}`,
          );
        }
      }
      if (reported.size < maxReport + 1 && !reported.has(k)) {
        reported.add(k);
        console.log(
          `  ${k}: deg=${nr.degree} rational=${nr.rational} periodic=${nr.periodic} poles=${nr.poles.length / 3} ` +
            `knots=${nr.knots.length} mult=${nr.multiplicities.length} closed=${kernel.curveIsClosed(e)} ` +
            `roundTripDev=${dev.toExponential(2)} trimmed=${trimmed}`,
        );
      }
    } catch (err) {
      stats.trimFailed++;
      if (!reported.has('edgeerr')) {
        reported.add('edgeerr');
        console.log(`  edge skipped: ${String((err as Error).message).slice(0, 100)}`);
      }
    }
  }
}

console.log('--- kinds ---');
console.log([...kinds].map(([k, c]) => `${k}=${c}`).join(' '));
console.log(
  `paramEdges=${stats.paramEdges} rebuilt=${stats.rebuilt} notRebuildable=${stats.notRebuildable} rational=${stats.rational} ` +
    `roundTripMaxDeviation=${stats.maxDev.toExponential(3)}mm`,
);
console.log(
  `trim: trimmed=${stats.trimmed} recovered=${stats.trimRecovered} failed=${stats.trimFailed} maxRecoverDeviation=${stats.maxTrimDev.toExponential(3)}mm`,
);
console.log(`degrees: ${[...stats.degrees].map(([d, c]) => `d${d}=${c}`).join(' ')}`);
