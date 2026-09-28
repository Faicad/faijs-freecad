/**
 * Endpoint-walk probe (2026-09-28): can the Draft wire's polyline be rebuilt by
 * matching edge endpoints, given that `wireframe().edgeGroups` is `TopExp::MapShapes`
 * order and NOT a traversal order?
 *
 * Measured facts this builds on (`Clone2D.Shape.brp`): 1 wire / 15 edges,
 * consecutive-array-entry gaps up to 3.43 mm (so array order is meaningless), and
 * the wire's own first/last endpoints do not coincide.
 *
 * Algorithm under test: treat every edge as a 2-endpoint segment; greedily chain
 * from an edge endpoint that has no partner (a free end); fall back to any unused
 * edge when the figure is a closed loop. Report coverage and whether the walk
 * closes, and the leftover edge count when it does not.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-edge-walk.ts <file.brp> [more.brp...]
 */
import { readFileSync } from 'node:fs';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';

const kernel = (await initOcctWasm()) as unknown as {
  fromBREP: (s: string) => number;
  wireframe: (s: number, d: number) => { points: Float32Array; edgeGroups: number[] };
  getSubShapes: (s: number, t: string) => number[];
  getShapeType: (s: number) => string;
  release: (s: number) => void;
};

type P2 = [number, number];

/** Near-equality for Float32 tessellation samples of the same vertex. */
function near(a: P2, b: P2, tol: number): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
}

for (const brpPath of process.argv.slice(2)) {
  const brp = readFileSync(brpPath, 'utf8');
  const shape = kernel.fromBREP(brp);
  const wires = kernel.getSubShapes(shape, 'wire');
  let totalEdges = 0;
  let walked = 0;
  let closedLoops = 0;
  const lines: string[] = [];

  for (const w of wires) {
    const wf = kernel.wireframe(w, 0.01);
    const edges = wf.edgeGroups.length / 3;
    const polys: P2[][] = [];
    for (let g = 0; g < edges; g++) {
      const g0 = wf.edgeGroups[g * 3]!;
      const n = Math.floor(wf.edgeGroups[g * 3 + 1]! / 3);
      const pts: P2[] = [];
      for (let i = 0; i < n; i++) pts.push([wf.points[g0 + i * 3]!, wf.points[g0 + i * 3 + 1]!]);
      if (pts.length >= 2) polys.push(pts);
    }
    if (polys.length === 0) { kernel.release(w); continue; }
    const mag = Math.max(...polys.flat().flat().map(Math.abs));
    const tol = Math.max(1e-3, 1e-6 * mag);

    const used = new Array<boolean>(polys.length).fill(false);
    // degree of each endpoint → find a free end to start from
    const deg = polys.map((p) => [0, 0]);
    for (let i = 0; i < polys.length; i++) {
      for (let j = 0; j < polys.length; j++) {
        if (i === j) continue;
        if (near(polys[i]![0]!, polys[j]![0]!, tol) || near(polys[i]![0]!, polys[j]![polys[j]!.length - 1]!, tol)) deg[i]![0]!++;
        if (near(polys[i]![polys[i]!.length - 1]!, polys[j]![0]!, tol) || near(polys[i]![polys[i]!.length - 1]!, polys[j]![polys[j]!.length - 1]!, tol)) deg[i]![1]!++;
      }
    }
    let start = deg.findIndex((d) => d[0] === 0 || d[1] === 0);
    if (start < 0) start = 0;
    const reverse = deg[start]![0] === 0 && deg[start]![1]! > 0;
    used[start] = true;
    let chain: P2[] = reverse ? [...polys[start]!].reverse() : [...polys[start]!];
    let consumed = 1;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const tail = chain[chain.length - 1]!;
      for (let i = 0; i < polys.length; i++) {
        if (used[i]) continue;
        const p = polys[i]!;
        if (near(p[0]!, tail, tol)) { chain = chain.concat(p.slice(1)); used[i] = true; consumed++; progressed = true; break; }
        if (near(p[p.length - 1]!, tail, tol)) { chain = chain.concat([...p].reverse().slice(1)); used[i] = true; consumed++; progressed = true; break; }
      }
    }
    const closes = near(chain[0]!, chain[chain.length - 1]!, tol);
    if (closes) closedLoops++;
    totalEdges += polys.length;
    walked += consumed;
    lines.push(`   wire edges=${polys.length} consumed=${consumed} chainPts=${chain.length} closes=${closes} tol=${tol.toExponential(2)}`);
    kernel.release(w);
  }
  kernel.release(shape);
  console.log(`${brpPath}  wires=${wires.length}`);
  console.log(lines.join('\n'));
  console.log(`   => edges=${totalEdges} consumed=${walked} closedLoops=${closedLoops}/${wires.length}`);
}
