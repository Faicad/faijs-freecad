/**
 * Dump a window of a converted product's emitted main source, plus every
 * compound / sweep / draft call site with its line number. Used to locate the
 * exact statement that a runtime failure names ("statement N (callee: X)").
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-stmt-window.ts <file.FCStd> <from> <to> [outFile]
 */
import { unzipSync, strFromU8 } from 'fflate';
import { writeFileSync } from 'node:fs';
import { convertFcstdFile } from '../src/convert.js';

const file = process.argv[2]!;
const from = Number(process.argv[3] ?? '1');
const to = Number(process.argv[4] ?? '20');
const outFile = process.argv[5];

const summary = await convertFcstdFile(file);
console.log(`ok=${summary.ok} gaps=${JSON.stringify(summary.gaps)}`);
if (!summary.zip) process.exit(0);

const members = unzipSync(summary.zip);
const src = strFromU8(members[Object.keys(members).find((n) => n.endsWith('main.fai.js'))!]!);
const lines = src.split('\n');
if (outFile) {
  writeFileSync(outFile, src, 'utf8');
  // Unit ordinal == top-level statement order (function decls included).
  const unitLines: { idx: number; line: number; text: string }[] = [];
  for (const [i, l] of lines.entries()) {
    if (/^(function |let |const |var |await )/.test(l)) {
      unitLines.push({ idx: unitLines.length, line: i + 1, text: l.length > 120 ? l.slice(0, 120) + '…' : l });
    }
  }
  writeFileSync(`${outFile}.units.json`, JSON.stringify(unitLines, null, 1), 'utf8');
  console.log(`wrote ${outFile} + ${outFile}.units.json (${unitLines.length} units)`);
}

console.log(`--- lines ${from}..${to} of ${lines.length} ---`);
for (let i = from - 1; i < Math.min(to, lines.length); i++) {
  console.log(`${i + 1}: ${lines[i]!.length > 200 ? lines[i]!.slice(0, 200) + '…' : lines[i]}`);
}

console.log('--- all compound / sweep / draw call sites ---');
for (const [i, l] of lines.entries()) {
  if (/cad\.(compound|sweep|draw)\(|sketchOnPlane\(/.test(l)) {
    const idx = (l.match(/cad\.(compound|sweep|draw)\(|sketchOnPlane\(/) ?? []).index ?? 0;
    console.log(`${i + 1}: ${l.slice(Math.max(0, idx - 60), idx + 120).trim()}`);
  }
}
