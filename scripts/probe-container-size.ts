/**
 * Container size probe (plan Phase 3.9): convert the FCStd fixtures and report,
 * per product, the member count and the decompressed byte total.
 *
 * These are the two numbers `io/zip.ts`'s default read caps must accommodate —
 * the container layer inherits them, and the container's size is driven by the
 * source document (byte-exact `freecad/` shadow + every baked `.brp` carrier),
 * not by anything the container layer controls.
 *
 * usage: npx tsx packages/fcstd/scripts/probe-container-size.ts [fixtureDir]
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES } from '@faicad/faijs/io';
import { convertFcstdFile } from '../src/convert.js';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';

installSketchSolver(createNodePlanegcsSolver);
void mergeSketchNamespace;

const dir = process.argv[2] ?? 'C:/my/Faicad/fcstd-port/test/FreeCAD/fixtures';
if (!existsSync(dir)) {
  console.error(`fixture dir not found: ${dir}`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fcstd')).sort();
console.log(`fixtures: ${files.length} in ${dir}`);
console.log(`io/zip defaults: maxEntries=${DEFAULT_MAX_ENTRIES}, maxTotalBytes=${DEFAULT_MAX_TOTAL_BYTES}`);
console.log('');

let worstEntries = { name: '', value: 0 };
let worstBytes = { name: '', value: 0 };

for (const file of files) {
  const summary = await convertFcstdFile(join(dir, file));
  if (!summary.zip) {
    console.log(`${file}: no product (ok=${summary.ok}, gaps=${summary.gaps.length})`);
    continue;
  }
  const members = Object.entries(unzipSync(summary.zip));
  const bytes = members.reduce((n, [, b]) => n + b.byteLength, 0);
  const pctEntries = ((members.length / DEFAULT_MAX_ENTRIES) * 100).toFixed(1);
  const pctBytes = ((bytes / DEFAULT_MAX_TOTAL_BYTES) * 100).toFixed(2);
  console.log(
    `${file}: zip=${(summary.zip.byteLength / 1024).toFixed(0)} KiB, members=${members.length} (${pctEntries}% of cap), uncompressed=${(bytes / 1024 / 1024).toFixed(1)} MiB (${pctBytes}% of cap)`,
  );
  if (members.length > worstEntries.value) worstEntries = { name: file, value: members.length };
  if (bytes > worstBytes.value) worstBytes = { name: file, value: bytes };
}

console.log('');
console.log(`worst member count: ${worstEntries.value} (${worstEntries.name})`);
console.log(`worst uncompressed: ${(worstBytes.value / 1024 / 1024).toFixed(1)} MiB (${worstBytes.name})`);
