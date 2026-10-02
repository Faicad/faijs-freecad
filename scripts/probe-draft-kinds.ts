/**
 * Probe: the RAW curve-kind inventory of every Draft 2D object in a document.
 *
 * Why: `extractDraftDrawing` collapses each edge to `line` / `arc` / a
 * tessellated run, so the per-edge decision it made is invisible in the emitted
 * source. A2 (`2026-09-29 plan` §A2) turns on exactly that decision — which
 * kinds are still falling through to the per-EDGE tessellation fallback — and
 * §9 requires the kernel to state, by measurement, what `curveType` returns for
 * the parametric edges (`bezier` or `bspline`?) and whether
 * `getNurbsCurveData` hands back usable poles/knots/multiplicities.
 *
 * This probe reads each Draft object's frozen `.brp`, walks its wires and prints
 * one line per edge kind, plus the NURBS summary for the parametric kinds. It is
 * read-only and reusable as the A4 library-wide inventory.
 *
 * Usage: node --import tsx packages/faijs-freecad/scripts/probe-draft-kinds.ts "<doc.FCStd>"
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText, parseDocumentXml } from '../src/index.js';
import { shapeBrpFile } from '../src/external-geo.js';
import { isDraft2DObject } from '../src/draft-draw.js';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';

interface ProbeKernel {
  fromBREP: (s: string) => number;
  getSubShapes: (s: number, t: string) => number[];
  getShapeType: (s: number) => string;
  curveType: (e: number) => string;
  curveParameters: (e: number) => { first: number; last: number };
  curveIsClosed: (e: number) => boolean;
  getNurbsCurveData: (e: number) =>
    | {
        degree: number;
        periodic: boolean;
        rational: boolean;
        knots?: number[];
        multiplicities?: number[];
        poles?: number[];
        weights?: number[];
      }
    | null;
  release: (s: number) => void;
}

const docPath = process.argv[2];
if (!docPath) {
  console.error('usage: probe-draft-kinds.ts "<doc.FCStd>"');
  process.exit(1);
}

const unpacked = unpackFcstd(new Uint8Array(readFileSync(docPath)));
if (!unpacked.ok) {
  console.error(`unpack failed: ${JSON.stringify(unpacked.error)}`);
  process.exit(1);
}
const xml = memberText(unpacked.value, 'Document.xml');
if (xml === undefined) {
  console.error('Document.xml missing');
  process.exit(1);
}
const parsed = parseDocumentXml(xml);
if (!parsed.ok) {
  console.error(`parse failed: ${parsed.error.message}`);
  process.exit(1);
}

const kernel = (await initOcctWasm()) as unknown as ProbeKernel;
const globalKinds = new Map<string, number>();
const nurbsSeen = new Map<string, string>();

console.log('--- all objects ---');
for (const obj of parsed.value.objects) {
  const draft = isDraft2DObject(obj);
  console.log(
    `${draft ? 'DRAFT ' : '      '}${obj.name} (${obj.type}) brp=${shapeBrpFile(obj) ?? '-'}`,
  );
}

for (const obj of parsed.value.objects) {
  if (!isDraft2DObject(obj)) continue;
  const brpFile = shapeBrpFile(obj);
  if (!brpFile) {
    console.log(`${obj.name}: NO .brp member — not a rebuildable drawing`);
    continue;
  }
  const brp = memberText(unpacked.value, brpFile);
  if (!brp) {
    console.log(`${obj.name}: .brp member "${brpFile}" unreadable`);
    continue;
  }
  let shape: number;
  try {
    shape = kernel.fromBREP(brp);
  } catch (e) {
    console.log(`${obj.name}: fromBREP threw: ${String((e as Error).message).slice(0, 120)}`);
    continue;
  }

  const wires = kernel.getSubShapes(shape, 'wire');
  const kinds = new Map<string, number>();
  let paramEdges = 0;
  const walk = (handle: number): void => {
    const edges = kernel.getSubShapes(handle, 'edge');
    for (const e of edges) {
      let k = '?';
      try {
        k = kernel.curveType(e);
      } catch {
        k = 'error';
      }
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      globalKinds.set(k, (globalKinds.get(k) ?? 0) + 1);
      if (k !== 'line' && k !== 'circle') {
        paramEdges++;
        // `getNurbsCurveData` THROWS for analytic curves (measured 2026-09-29:
        // `edge is not a BSpline or Bezier curve`) — it is not a nullable getter.
        let line = `${obj.name} ${k}: n/a`;
        try {
          const d = kernel.getNurbsCurveData(e);
          line = d
            ? `${obj.name} ${k}: deg=${d.degree} rational=${d.rational} periodic=${d.periodic} ` +
              `poles=${(d.poles?.length ?? 0) / 3} knots=${d.knots?.length ?? 0} mult=${d.multiplicities?.length ?? 0} ` +
              `knotVals=${JSON.stringify((d.knots ?? []).slice(0, 8))}`
            : `${obj.name} ${k}: nurbs=null`;
        } catch (err) {
          line = `${obj.name} ${k}: getNurbsCurveData threw: ${String((err as Error).message).slice(0, 80)}`;
        }
        if (!nurbsSeen.has(k)) {
          nurbsSeen.set(k, line);
          console.log(line);
        }
      }
      kernel.release(e);
    }
  };

  if (wires.length > 0) {
    for (const w of wires) {
      walk(w);
      kernel.release(w);
    }
  } else {
    walk(shape);
  }
  kernel.release(shape);

  const kindStr = [...kinds].map(([k, c]) => `${k}=${c}`).join(' ');
  const total = [...kinds.values()].reduce((a, b) => a + b, 0);
  console.log(
    `${obj.name} (${obj.type}) wires=${wires.length} edges=${total} paramEdges=${paramEdges} | ${kindStr}`,
  );
}

console.log('--- global kinds ---');
console.log([...globalKinds].map(([k, c]) => `${k}=${c}`).join(' '));
