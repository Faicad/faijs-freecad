/**
 * Probe: what a conversion actually EMITS, statement by statement.
 *
 * Why: an execution failure names only a statement id
 * (`main failed: Execution failed at statement 36 (callee: sketchOnPlane)`), and
 * an `sN` maps to nothing readable without the generated source. This probe
 * converts the document and prints the FULL numbered statements of every emitted
 * module, so the failing id names its object.
 *
 * Sibling: `probe-emitted-source.ts` dumps the same sources but filters by a
 * regex and truncates each line to 220 chars — its trailing `// sN source`
 * comment is exactly what gets cut, which is why this one prints untruncated.
 *
 * Usage: node --import tsx packages/faijs-freecad/scripts/probe-emitted-statements.ts "<doc.FCStd>"
 */
import { convertFcstdFile } from '../src/convert.js';

const docPath = process.argv[2];
if (!docPath) {
  console.error('usage: probe-emitted-statements.ts "<doc.FCStd>"');
  process.exit(1);
}

const summary = await convertFcstdFile(docPath);
console.log(`ok=${summary.ok} elapsedMs=${summary.elapsedMs} counts=${JSON.stringify(summary.counts)}`);
if (summary.gaps.length) console.log(`gaps:\n${summary.gaps.map((g) => `  ${g.name} (${g.type}): ${g.reason}`).join('\n')}`);

if (!summary.zip) {
  console.error('no zip produced');
  process.exit(1);
}
const { unzipSync, strFromU8 } = await import('fflate');
const members = unzipSync(summary.zip);
for (const name of Object.keys(members).filter((n) => n.endsWith('.fai.js')).sort()) {
  const src = strFromU8(members[name]!);
  const lines = src.split('\n');
  console.log(`\n=== ${name} (${lines.length} lines) ===`);
  lines.forEach((l, i) => console.log(`${String(i).padStart(4)} | ${l}`));
}
