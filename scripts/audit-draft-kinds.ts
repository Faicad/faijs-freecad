/**
 * Audit: which Draft 2D objects in the whole corpus carry PARAMETRIC edges.
 *
 * Why this exists: `docs/plans/2026-09-29-fcstd-draft-sprocket-timeout-plan.md`
 * §6 scopes A2 as "`bezier` / `bspline` through `getNurbsCurveData`" and names
 * `PartShape6/9/12` as its acceptance fixture. A per-object probe
 * (`probe-draft-kinds.ts`) falsified that fixture: in the Sprocket document those
 * three members belong to `PartDesign::Groove` / `PartDesign::Pad` /
 * `PartDesign::Pocket` — PartDesign features emitted as dead `shape-asset`
 * imports, NOT Draft objects. The Sprocket's single Draft object is 126 circle +
 * 42 line, i.e. fully covered by A1.
 *
 * So before writing any A2 code, the question "does the Draft path contain ANY
 * parametric edge at all?" has to be answered by counting, not by inference. This
 * script walks every `.FCStd` in the corpus, keeps the `Part::Part2DObjectPython`
 * objects, and reports the RAW `curveType` histogram of their frozen `.brp`.
 *
 * Read-only: reads documents, writes one JSON + prints a stream log.
 *
 * Usage: node --import tsx packages/fcstd/scripts/audit-draft-kinds.ts <corpusRoot> [outJson]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { unpackFcstd, memberText, parseDocumentXml } from '../src/index.js';
import { shapeBrpFile } from '../src/external-geo.js';
import { isDraft2DObject } from '../src/draft-draw.js';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';

interface ProbeKernel {
  fromBREP: (s: string) => number;
  getSubShapes: (s: number, t: string) => number[];
  curveType: (e: number) => string;
  getNurbsCurveData: (e: number) =>
    | { degree: number; rational: boolean; periodic: boolean; poles?: number[]; knots?: number[] }
    | null;
  release: (s: number) => void;
}

const root = process.argv[2];
if (!root) {
  console.error('usage: audit-draft-kinds.ts <corpusRoot> [outJson]');
  process.exit(1);
}
const outJson = process.argv[3] ?? 'out/draft-kinds-audit.json';

const docs = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => f.toLowerCase().endsWith('.fcstd'))
  .map((f) => join(root, f))
  .sort();
console.log(`docs=${docs.length} root=${root}`);

const kernel = (await initOcctWasm()) as unknown as ProbeKernel;

/** Per-document record; `paramEdges > 0` is the A2 target signal. */
interface DocRecord {
  doc: string;
  error?: string;
  draftObjects: number;
  draftEdges: number;
  paramEdges: number;
  kinds: Record<string, number>;
  paramObjects: { name: string; kinds: Record<string, number> }[];
}

const records: DocRecord[] = [];
const globalKinds = new Map<string, number>();
let draftObjects = 0;
let draftEdges = 0;
let paramEdges = 0;
let unreadable = 0;

const t0 = Date.now();
for (let di = 0; di < docs.length; di++) {
  const doc = docs[di]!;
  const rec: DocRecord = { doc: relative(root, doc), draftObjects: 0, draftEdges: 0, paramEdges: 0, kinds: {}, paramObjects: [] };
  try {
    const unpacked = unpackFcstd(new Uint8Array(readFileSync(doc)));
    if (!unpacked.ok) {
      rec.error = 'unpack failed';
      records.push(rec);
      unreadable++;
      continue;
    }
    const xml = memberText(unpacked.value, 'Document.xml');
    if (xml === undefined) {
      rec.error = 'no Document.xml';
      records.push(rec);
      unreadable++;
      continue;
    }
    const parsed = parseDocumentXml(xml);
    if (!parsed.ok) {
      rec.error = 'parse failed';
      records.push(rec);
      unreadable++;
      continue;
    }
    for (const obj of parsed.value.objects) {
      if (!isDraft2DObject(obj)) continue;
      const brpFile = shapeBrpFile(obj);
      if (!brpFile) continue;
      const brp = memberText(unpacked.value, brpFile);
      if (!brp) continue;
      let shape: number;
      try {
        shape = kernel.fromBREP(brp);
      } catch {
        continue;
      }
      const objKinds: Record<string, number> = {};
      let objParam = 0;
      const wires = ((): number[] => {
        try {
          return kernel.getSubShapes(shape, 'wire');
        } catch {
          return [];
        }
      })();
      const walk = (handle: number): void => {
        let edges: number[];
        try {
          edges = kernel.getSubShapes(handle, 'edge');
        } catch {
          return;
        }
        for (const e of edges) {
          let k = 'error';
          try {
            k = kernel.curveType(e);
          } catch {
            k = 'error';
          }
          objKinds[k] = (objKinds[k] ?? 0) + 1;
          globalKinds.set(k, (globalKinds.get(k) ?? 0) + 1);
          if (k !== 'line' && k !== 'circle') objParam++;
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

      const edges = Object.values(objKinds).reduce((a, b) => a + b, 0);
      rec.draftObjects++;
      rec.draftEdges += edges;
      rec.paramEdges += objParam;
      for (const [k, c] of Object.entries(objKinds)) rec.kinds[k] = (rec.kinds[k] ?? 0) + c;
      if (objParam > 0) rec.paramObjects.push({ name: obj.name, kinds: objKinds });
    }
  } catch (e) {
    rec.error = String((e as Error).message).slice(0, 120);
    unreadable++;
  }
  draftObjects += rec.draftObjects;
  draftEdges += rec.draftEdges;
  paramEdges += rec.paramEdges;
  records.push(rec);
  if (rec.paramEdges > 0) {
    console.log(
      `PARAM ${rec.doc}: draftObjects=${rec.draftObjects} paramEdges=${rec.paramEdges} | ` +
        rec.paramObjects.map((o) => `${o.name}:${JSON.stringify(o.kinds)}`).join(' '),
    );
  }
  if ((di + 1) % 200 === 0) {
    console.log(`... ${di + 1}/${docs.length} drafts=${draftObjects} paramEdges=${paramEdges} unreadable=${unreadable} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}

console.log('--- totals ---');
console.log(`docs=${docs.length} unreadable=${unreadable} draftObjects=${draftObjects} draftEdges=${draftEdges} paramEdges=${paramEdges}`);
console.log(`kinds: ${[...globalKinds].map(([k, c]) => `${k}=${c}`).join(' ')}`);

writeFileSync(outJson, JSON.stringify({ totals: { docs: docs.length, unreadable, draftObjects, draftEdges, paramEdges }, globalKinds: Object.fromEntries(globalKinds), records }, null, 1));
console.log(`wrote ${outJson}`);
