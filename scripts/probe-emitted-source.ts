/**
 * Dump one converted product's emitted main source + the per-object ledger, to
 * see how a given corpus file's Draft objects were (or were not) translated.
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-emitted-source.ts <file.FCStd> [grepPattern]
 */
import { unzipSync, strFromU8 } from 'fflate';
import { convertFcstdFile } from '../src/convert.js';

const file = process.argv[2]!;
const pattern = process.argv[3] ?? 'draw';
const summary = await convertFcstdFile(file);
console.log(`ok=${summary.ok} gaps=${JSON.stringify(summary.gaps)}`);
if (!summary.zip) process.exit(0);
const members = unzipSync(summary.zip);
const srcEntry = Object.keys(members).find((n) => n.endsWith('main.fai.js'))!;
const src = strFromU8(members[srcEntry]!);
const lines = src.split('\n');
console.log(`--- lines matching /${pattern}/ (${lines.length} lines total) ---`);
for (const [i, l] of lines.entries()) {
  if (new RegExp(pattern).test(l)) console.log(`${i + 1}: ${l.length > 220 ? l.slice(0, 220) + '…' : l}`);
}
const mapEntry = Object.keys(members).find((n) => n.endsWith('mapping.json'));
if (mapEntry) {
  const map = JSON.parse(strFromU8(members[mapEntry]!)) as {
    objects: { name: string; type: string; disposition: string; reason?: string }[];
  };
  const drafts = map.objects.filter((o) => o.type === 'Part::Part2DObjectPython');
  console.log(`--- Part::Part2DObjectPython in ledger: ${drafts.length} ---`);
  for (const d of drafts) console.log(`  ${d.name}: ${d.disposition} ${d.reason ?? ''}`);
}
