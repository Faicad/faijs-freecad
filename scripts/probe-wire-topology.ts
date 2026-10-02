/**
 * Wire-topology probe (2026-09-28).
 *
 * `extractDraftDrawing` chains CONSECUTIVE entries of `wireframe().edgeGroups`.
 * Measured on `Clone2D.Shape.brp`: 15 edges, only 3 consecutive pairs share an
 * endpoint exactly and the rest are up to 3.4 mm apart — i.e. `edgeGroups` is NOT
 * a wire traversal order (it is `TopExp::MapShapes` order over the whole shape).
 * Chaining it therefore shatters every Draft wire into per-edge fragments, which
 * is exactly the 95%-"open" contour measurement.
 *
 * This probe asks the replacement question: does walking `getSubShapes(shape,
 * 'wire')` and running `wireframe(wire)` PER WIRE give ordered, chainable edge
 * polylines?
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-wire-topology.ts <file.brp>
 */
import { readFileSync } from 'node:fs';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';

const brpPath = process.argv[2] ?? 'out/insp-kcb/assets/Clone2D.Shape.brp';
const brp = readFileSync(brpPath, 'utf8');
const kernel = (await initOcctWasm()) as unknown as {
  fromBREP: (s: string) => number;
  wireframe: (s: number, d: number) => { points: Float32Array; edgeGroups: number[] };
  getSubShapes: (s: number, t: string) => number[];
  getShapeType: (s: number) => string;
  release: (s: number) => void;
};

const shape = kernel.fromBREP(brp);
const shapeType = kernel.getShapeType(shape);
const wires = kernel.getSubShapes(shape, 'wire');
console.log(`file=${brpPath} shapeType=${shapeType} wires=${wires.length}`);

/** Endpoints of one edge group within a wireframe payload. */
function edgeEnds(wf: { points: Float32Array; edgeGroups: number[] }, g: number): [[number, number], [number, number]] | undefined {
  const g0 = wf.edgeGroups[g * 3]!;
  const n = Math.floor(wf.edgeGroups[g * 3 + 1]! / 3);
  if (n < 2) return undefined;
  return [
    [wf.points[g0]!, wf.points[g0 + 1]!],
    [wf.points[g0 + (n - 1) * 3]!, wf.points[g0 + (n - 1) * 3 + 1]!],
  ];
}

let totalEdges = 0;
let orderedPairs = 0;
let brokenPairs = 0;
let maxGap = 0;
let closedWires = 0;

for (const [wi, w] of wires.entries()) {
  const wf = kernel.wireframe(w, 0.01);
  const edges = wf.edgeGroups.length / 3;
  totalEdges += edges;
  let wMaxGap = 0;
  for (let g = 0; g + 1 < edges; g++) {
    const a = edgeEnds(wf, g);
    const b = edgeEnds(wf, g + 1);
    if (!a || !b) continue;
    const d = Math.hypot(a[1][0] - b[0][0], a[1][1] - b[0][1]);
    wMaxGap = Math.max(wMaxGap, d);
    if (d < 1e-4) orderedPairs++;
    else brokenPairs++;
  }
  const first = edgeEnds(wf, 0);
  const last = edgeEnds(wf, edges - 1);
  const closed = !!(first && last && Math.hypot(first[0][0] - last[1][0], first[0][1] - last[1][1]) < 1e-4);
  if (closed) closedWires++;
  maxGap = Math.max(maxGap, wMaxGap);
  console.log(
    `  wire[${wi}] edges=${edges} chainOkPairs=${orderedPairs} chainBrokenPairs=${brokenPairs} wireMaxGap=${wMaxGap.toExponential(2)} closedLoop=${closed}`,
  );
  kernel.release(w);
}
console.log(
  `\n=== wires=${wires.length} edges=${totalEdges} orderedPairs=${orderedPairs} brokenPairs=${brokenPairs} closedWires=${closedWires} maxGap=${maxGap.toExponential(2)} ===`,
);
kernel.release(shape);
