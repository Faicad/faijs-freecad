/**
 * Dump EVERY emitted `.fai.js` module of one converted product, with 1-based
 * line numbers, so a runtime failure reported as
 * `dependency module failed at line N` can be traced back to real source.
 *
 * Companion to `probe-emitted-source.ts` (which dumps only the main module and
 * filters by pattern); this one prints all modules unfiltered because the
 * failure line number is meaningful only against the exact emitted text.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-dump-modules.ts <file.FCStd> [moduleNameSubstring]
 */
import { unzipSync, strFromU8 } from 'fflate';
import { convertFcstdFile } from '../src/convert.js';

const file = process.argv[2]!;
const only = process.argv[3];
const summary = await convertFcstdFile(file);
console.log(`ok=${summary.ok} gaps=${JSON.stringify(summary.gaps)} error=${summary.error ?? ''}`);
if (!summary.zip) process.exit(0);

const members = unzipSync(summary.zip);
for (const [name, bytes] of Object.entries(members)) {
  if (!name.endsWith('.fai.js')) continue;
  if (only && !name.includes(only)) continue;
  console.log(`\n===== ${name} =====`);
  const lines = strFromU8(bytes).split('\n');
  lines.forEach((l, i) => console.log(`${String(i + 1).padStart(4)}: ${l}`));
}
