/**
 * Probe (kept per repo policy): measure why a sketch that the solver reports as
 * L0 yields zero closed contours (`sketch-solved-no-closed-loop`).
 *
 * The CLI contract only prints the bake reason. The two candidate causes are
 * structurally different and need different fixes:
 *   (a) the endpoints that *should* coincide do not, by more than the chaining
 *       tolerance `JOIN_TOL` in `contour.ts` — a tolerance bug, fixable;
 *   (b) the profile is genuinely open / the geometry set is not chainable —
 *       a modelling reality, not a bug.
 *
 * This probe separates them: it clusters every segment endpoint and reports the
 * largest intra-cluster separation, i.e. how far apart two points that a human
 * would call "the same corner" actually are after solving.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-sketch-loop.ts [rel] [sketchName]
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText } from '../src/unpack.js';
import { parseDocumentXml } from '../src/document.js';
import { parseSketchObject } from '../src/sketch-parse.js';
import { createPlanegcsSolver } from '../src/planegcs-backend.js';
import { classifySketch } from '../src/sketch-verify.js';
import { extractContours } from '../src/contour.js';
import { isOk } from '@faicad/faijs/api/result';

const rel = process.argv[2] ?? 'Architectural Parts/Bathroom/Bathroom_cabinet_sink.FCStd';
const wantName = process.argv[3];
const input = `D:/Faicad/FreeCAD-library/${rel}`;

const raw = new Uint8Array(readFileSync(input));
const unpacked = unpackFcstd(raw);
if (!isOk(unpacked)) throw new Error(`unpack failed: ${JSON.stringify(unpacked.error)}`);
const xml = memberText(unpacked.value, 'Document.xml');
if (xml === undefined) throw new Error('Document.xml missing');
const doc = parseDocumentXml(xml);
if (!isOk(doc)) throw new Error(`parse failed: ${doc.error.message}`);

const solver = await createPlanegcsSolver();
for (const obj of doc.value.objects) {
  if (obj.type !== 'Sketcher::SketchObject') continue;
  if (wantName && obj.name !== wantName) continue;

  const sk = parseSketchObject(obj.properties.get('Geometry'), obj.properties.get('Constraints'), false);
  const r = await solver.solve(sk.geoms, sk.constraints, undefined);
  if (!isOk(r)) { console.log(`${obj.name}: solver-error`); continue; }
  const verdict = classifySketch(r.value, sk.geoms, 1e-6);
  const contours = verdict.level === 'L0' ? extractContours(r.value.geoms) : [];
  if (verdict.level === 'L0' && contours.length > 0) continue; // only report failures

  // Cluster every segment endpoint and report the worst intra-cluster spread.
  type P = { x: number; y: number };
  const pts: P[] = [];
  for (const g of r.value.geoms) {
    if (g.construction) continue;
    if (g.kind === 'line') { pts.push({ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }); }
    else if (g.kind === 'arc') { pts.push({ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }); }
    else if (g.kind === 'circle') { /* self-closed, no endpoints */ }
  }
  const CLUSTER = 1e-4;
  const used = new Array<boolean>(pts.length).fill(false);
  const clusters: P[][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    const c: P[] = [pts[i]!];
    used[i] = true;
    for (let j = i + 1; j < pts.length; j++) {
      if (used[j]) continue;
      if (Math.hypot(pts[j]!.x - pts[i]!.x, pts[j]!.y - pts[i]!.y) <= CLUSTER) { c.push(pts[j]!); used[j] = true; }
    }
    clusters.push(c);
  }
  let worst = 0;
  for (const c of clusters) {
    for (const p of c) worst = Math.max(worst, Math.hypot(p.x - c[0]!.x, p.y - c[0]!.y));
  }
  // Degree tally: how many segments touch each cluster (2 = a clean corner).
  const degree = clusters.map((c) => {
    let d = 0;
    for (const g of r.value.geoms) {
      const ends: P[] = g.kind === 'line' ? [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }]
        : g.kind === 'arc' ? [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }] : [];
      for (const e of ends) if (Math.hypot(e.x - c[0]!.x, e.y - c[0]!.y) <= CLUSTER) d++;
    }
    return d;
  });

  console.log(`\n=== ${obj.name} :: level=${verdict.level} reason=${verdict.reason ?? '-'} contours=${contours.length}`);
  const realGeoms = r.value.geoms.filter((g) => g.construction !== true);
  console.log(`  geoms=${r.value.geoms.length} construction=${r.value.geoms.length - realGeoms.length} kinds=${JSON.stringify(realGeoms.reduce<Record<string, number>>((a, g) => { a[g.kind] = (a[g.kind] ?? 0) + 1; return a; }, {}))}`);
  console.log(`  endpoints=${pts.length} clusters=${clusters.length} worstIntraCluster=${worst.toExponential(3)} (JOIN_TOL=1e-7, T1=1e-6)`);
  console.log(`  cluster degrees=${JSON.stringify(degree)}`);
  if (wantName) {
    for (const g of r.value.geoms) console.log(`   ${JSON.stringify(g)}`);
    console.log('  solved:', JSON.stringify(r.value.geoms));
  }
}
