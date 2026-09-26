/**
 * Probe (kept per repo policy): dump the per-object mapping ledger for the
 * B1/B2 sample `Architectural Parts/Bedroom/Beds.FCStd`.
 *
 * The CLI contract prints `gaps[]` only, which is enough to see *what* failed
 * but not *why the upstream object failed*. This probe re-runs the pipeline with
 * `keepGappedContainer` and reads `mapping.json` so the culprit chain
 * (e.g. Loft002 -> Sketch262 -> ...) is visible in one shot.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-b2-beds.ts [rel-under-D:/Faicad/FreeCAD-library]
 */
import { unzipSync, strFromU8 } from 'fflate';
import { convertFcstdFile } from '../src/convert.js';

const rel = process.argv[2] ?? 'Architectural Parts/Bedroom/Beds.FCStd';
const input = `D:/Faicad/FreeCAD-library/${rel}`;

const summary = await convertFcstdFile(input, { keepGappedContainer: true });
console.log('gaps:', JSON.stringify(summary.gaps));
console.log('counts:', JSON.stringify(summary.counts));
console.log('sketches:', JSON.stringify(summary.sketches));

if (!summary.zip) {
  console.log('no gapped container produced');
  process.exit(0);
}
const members = unzipSync(summary.zip);
const mapping = JSON.parse(strFromU8(members['mapping.json']!)) as {
  objects: { name: string; type: string; disposition: string; reason?: string; sketch?: { level: string; reason?: string } }[];
};

const focus = new Set(process.argv.slice(3));
for (const o of mapping.objects) {
  if (focus.size > 0 && !focus.has(o.name)) continue;
  if (focus.size === 0 && o.disposition === 'translated' && !o.sketch) continue;
  console.log(
    `${o.name}\t${o.type}\t${o.disposition}\t${o.reason ?? ''}\t${o.sketch ? `sketch=${o.sketch.level}:${o.sketch.reason ?? ''}` : ''}`,
  );
}
