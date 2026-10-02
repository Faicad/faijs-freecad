/**
 * Probe (kept per repo policy): convert a corpus sample and report the gap
 * ledger, so a translator change can be checked for regressions without the
 * fcstd-port batch driver.
 *
 * The canary is the gap reason `feature-translation-pending`: that is the
 * container's INITIAL disposition, retained by any object that the topological
 * sort dropped. A dependency-edge change that creates a cycle would show up
 * here rather than as a plausible `*-missing-*` reason.
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/sweep-gaps.ts [limit] [stride]
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { convertFcstdFile } from '../src/convert.js';

const CORPUS = 'D:/Faicad/FreeCAD-library';
const limit = Number(process.argv[2] ?? 120);
const stride = Number(process.argv[3] ?? 1);

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.fcstd$/i.test(e)) out.push(p);
  }
  return out;
}

const all = walk(CORPUS, []).sort();
const sample = all.filter((_, i) => i % stride === 0).slice(0, limit);

const reasonTally = new Map<string, number>();
const reasonExample = new Map<string, string>();
let ok = 0;
let failed = 0;
const pending: string[] = [];

for (const f of sample) {
  const s = await convertFcstdFile(f);
  if (s.error) { failed++; console.log(`ERROR ${f}: ${s.error}`); continue; }
  if (s.ok) { ok++; continue; }
  for (const g of s.gaps) {
    const key = `${g.type} :: ${g.reason.replace(/:.*/, ':…')}`;
    reasonTally.set(key, (reasonTally.get(key) ?? 0) + 1);
    if (!reasonExample.has(key)) reasonExample.set(key, `${f.replace(CORPUS + '/', '')} :: ${g.name} :: ${g.reason}`);
    if (g.reason === 'feature-translation-pending') pending.push(`${f} :: ${g.name}`);
  }
}

console.log(`\nsample=${sample.length} ok=${ok} gapped=${sample.length - ok - failed} failed=${failed}`);
console.log('--- gap reasons (top 25) ---');
for (const [k, v] of [...reasonTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`${String(v).padStart(5)}  ${k}\n         e.g. ${reasonExample.get(k)}`);
}
console.log(`--- dropped-by-sort canary (feature-translation-pending): ${pending.length} ---`);
for (const p of pending.slice(0, 20)) console.log(`  ${p}`);
