/**
 * Edge-continuity probe (2026-09-28): is `renderDrawSession`'s chaining failing?
 *
 * `renderDrawSession` continues a pen run when the next edge starts within 1e-6 of
 * the pen position. `wireframe()` returns a **Float32Array**, whose spacing at
 * drawing-scale coordinates (~±700 mm) is ~6e-5 — i.e. ABOVE that tolerance. If
 * that is what happens, every edge becomes its own "contour" and no Draft contour
 * is ever closed, which would explain the 95% geometrically-open measurement.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-edge-continuity.ts <file.brp>
 */
import { readFileSync } from 'node:fs';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';

const brpPath = process.argv[2] ?? 'out/insp-kcb/assets/Clone2D.Shape.brp';
const brp = readFileSync(brpPath, 'utf8');
const kernel = (await initOcctWasm()) as unknown as {
  fromBREP: (s: string) => unknown;
  wireframe: (s: unknown, deflection: number) => { points: Float32Array; edgeGroups: number[] };
};
const wf = kernel.wireframe(kernel.fromBREP(brp), 0.01);

const pts: [number, number][] = [];
for (let i = 0; i * 3 + 1 < wf.edgeGroups.length; i++) {
  const g0 = wf.edgeGroups[i * 3]!;
  const n = Math.floor(wf.edgeGroups[i * 3 + 1]! / 3);
  pts.push([wf.points[g0]!, wf.points[g0 + 1]!], [wf.points[g0 + (n - 1) * 3]!, wf.points[g0 + (n - 1) * 3 + 1]!]);
}
const edges = wf.edgeGroups.length / 3;
console.log(`file=${brpPath} edges=${edges} vertices=${pts.length} isFloat32=${wf.points.constructor.name}`);

let exact = 0, lt1e6 = 0, lt1e4 = 0, lt1e3 = 0, rest = 0;
let maxGap = 0;
for (let e = 0; e + 1 < edges; e++) {
  const end = pts[e * 2 + 1]!;
  const start = pts[(e + 1) * 2]!;
  const d = Math.hypot(end[0] - start[0], end[1] - start[1]);
  maxGap = Math.max(maxGap, d);
  if (d === 0) exact++;
  else if (d < 1e-6) lt1e6++;
  else if (d < 1e-4) lt1e4++;
  else if (d < 1e-3) lt1e3++;
  else rest++;
}
console.log(`consecutive-edge gaps: exact=${exact} <1e-6=${lt1e6} <1e-4=${lt1e4} <1e-3=${lt1e3} >=1e-3=${rest} maxGap=${maxGap.toExponential(3)}`);
const mag = Math.max(...pts.flat().map(Math.abs));
console.log(`maxCoordinateMagnitude=${mag.toFixed(1)}  float32SpacingAtMag=${(Math.max(1, mag) * Math.pow(2, -23)).toExponential(3)}`);
