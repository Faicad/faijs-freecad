/**
 * Probe D2: which faces of a shape carry no role lineage, and why.
 *
 * The D2 failure mode is `edgeRef: adjacent face ordinal N has no role lineage`
 * at a `cad.fillet` statement. This probe runs the converted product's emitted
 * source *up to* the failing statement, then asks the public query op
 * `cad.faceRef(shape, i)` for every face ordinal — a face without lineage throws
 * the same error class, so the probe reports exactly the coverage hole the
 * downstream edgeRef hits, plus the surfaceType/normal of every face so the
 * role-assignment rule (`extrudeConstructRoles`) can be judged against reality.
 *
 * Usage:
 *   node ../../node_modules/tsx/dist/cli.mjs scripts/probe-d2-faces.ts \
 *     "<doc.FCStd>" <uptoStmtId> <partName>
 */
import { unzipSync, strFromU8 } from 'fflate';
import { convertFcstdFile } from '../src/convert.js';
import { CadRuntime } from '@faicad/faijs/cad-runtime/runtime';
import type { HostPorts } from '@faicad/faijs/cad-runtime/ports';
import { asPartName } from '@faicad/faijs/identity';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '@faicad/faijs-draw';
import { getBrepApi } from '@faicad/faijs/brep/handle-bridge';
import { brepOf } from '@faicad/faijs/shape';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace())) as Record<string, unknown>;

const docPath = process.argv[2];
const upto = process.argv[3]; // e.g. "s9"
const partName = process.argv[4];
if (!docPath || !upto || !partName) {
  console.error('usage: probe-d2-faces.ts "<doc.FCStd>" <uptoStmtId> <partName>');
  process.exit(1);
}

await initOcctWasm();

const summary = await convertFcstdFile(docPath);
if (!summary.zip) {
  console.error(`convert failed: ${summary.error}`);
  process.exit(1);
}
const members = unzipSync(summary.zip);
const srcEntry = Object.keys(members).find((n) => n.endsWith('main.fai.js'))!;
const lines = strFromU8(members[srcEntry]!).split('\n');
const cut = lines.findIndex((l) => l.includes(`// ${upto} `));
if (cut < 0) {
  console.error(`no statement marker "// ${upto} "`);
  process.exit(1);
}
// `cad.import_brep` needs an assets backend in the ports; the prefix we care
// about (a sketch + its extrude) never depends on those imports, so drop them
// rather than wiring a full host.
const code = lines
  .slice(0, cut + 1)
  .filter((l) => !l.includes('cad.import_brep('))
  .join('\n');

const ports = { events: { emit: () => {} } } as HostPorts;
const rt = new CadRuntime(ports, 'brep', { cad: CAD_NS as never });
const result = await rt.execute(code);
if (result.failedAt) {
  console.error(`prefix execution failed at ${result.failedAt.callee}: ${result.failedAt.message}`);
  process.exit(1);
}
const shape = result.outputs.get(asPartName(partName));
if (!shape) {
  console.error(`no output named ${partName}; have ${[...result.outputs.keys()].join(', ')}`);
  process.exit(1);
}

const faceRef = CAD_NS['faceRef'] as
  | ((of: unknown, n: number) => { origin: string; role: string; hint?: { surfaceType?: string; normal?: number[]; center?: number[] } })
  | undefined;
if (!faceRef) {
  console.error('cad.faceRef missing from namespace');
  process.exit(1);
}

const kernel = getBrepApi();
const solid = brepOf(shape as object) as unknown as Parameters<typeof kernel.getSubShapes>[0];
const faceHandles = kernel.getSubShapes(solid, 'face');
console.log(`solid bbox: ${JSON.stringify(kernel.getBoundingBox(solid))}`);

/** strongest normal over a uv grid — a single midpoint sample can land on a degenerate spot. */
function strongestNormal(f: (typeof faceHandles)[number]): { n: number[]; mag: number } {
  const uv = kernel.uvBounds(f);
  let best: number[] = [0, 0, 0];
  let bestMag = -1;
  for (let a = 0; a <= 4; a++) {
    for (let b = 0; b <= 4; b++) {
      const u = uv.uMin + ((uv.uMax - uv.uMin) * a) / 4
      const v = uv.vMin + ((uv.vMax - uv.vMin) * b) / 4
      const n = kernel.surfaceNormal(f, u, v)
      const mag = Math.hypot(n.x, n.y, n.z)
      if (mag > bestMag) {
        bestMag = mag
        best = [n.x, n.y, n.z]
      }
    }
  }
  return { n: best, mag: bestMag }
}

let named = 0;
const missing: number[] = [];
for (let i = 1; i <= 200; i++) {
  const f = faceHandles[i - 1];
  const geom =
    f === undefined
      ? '(no face handle)'
      : (() => {
          const uv = kernel.uvBounds(f)
          const mid = kernel.surfaceNormal(f, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2)
          const { n, mag } = strongestNormal(f)
          const bb = kernel.getBoundingBox(f)
          const c = kernel.surfaceCenterOfMass(f)
          return (
            `type=${kernel.surfaceType(f)} mid=[${mid.x.toExponential(2)},${mid.y.toExponential(2)},${mid.z.toExponential(2)}]` +
            ` best=[${n.map((x) => x.toExponential(2)).join(',')}] |best|=${mag.toExponential(2)}` +
            ` bbox=${JSON.stringify(bb)} com=[${c.x},${c.y},${c.z}]`
          )
        })();
  try {
    const ref = faceRef(shape, i);
    named++;
    console.log(`face ${String(i).padStart(3)}: role=${ref.role} ${geom}`);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/out of range/.test(msg)) {
      console.log(`--- total faces: ${i - 1}; named ${named}; unnamed ${missing.length} ---`);
      if (missing.length) console.log(`unnamed ordinals: ${missing.join(', ')}`);
      break;
    }
    missing.push(i);
    console.log(`face ${String(i).padStart(3)}: NO LINEAGE ${geom}`);
  }
}
