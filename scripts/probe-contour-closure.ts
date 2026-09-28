/**
 * Per-CONTOUR closure test over already-generated products (2026-09-28).
 *
 * `DraftEdge.closed` in `draft-draw.ts` is per-EDGE (only a full-circle edge
 * closes on itself), while a Draft contour made of 4 straight edges closes only by
 * CHAINING. So "how many emitted contours are actually closed" cannot be read off
 * `edge.closed` — split each emitted pen chain at `moveTo(` boundaries and compare
 * the contour's first point with the point the chain ends on.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-contour-closure.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = 'out/insp2';
let contours = 0;
let geoClosed = 0;
let geoOpen = 0;
const rows: string[] = [];

for (const d of readdirSync(root)) {
  const f = join(root, d, 'model', 'main.fai.js');
  let src: string;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const re = /return cad\.draw\(\(pen\) => pen\.([\s\S]*?)\);\r?\n\}/g;
  let m: RegExpExecArray | null;
  let c = 0;
  let gc = 0;
  let go = 0;
  while ((m = re.exec(src)) !== null) {
    const chunks = m[1]!.split(/moveTo\(/).slice(1);
    for (const chunk of chunks) {
      const nums = chunk.match(/-?\d+(?:\.\d+)?/g) ?? [];
      const pts: [number, number][] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
      c++;
      if (pts.length < 2) { go++; continue; }
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) gc++; else go++;
    }
  }
  if (c) rows.push(`${d}  contours=${c} geometricallyClosed=${gc} geometricallyOpen=${go}`);
  contours += c;
  geoClosed += gc;
  geoOpen += go;
}
console.log(rows.join('\n'));
console.log(
  `\n=== contours=${contours}  geometricallyClosed=${geoClosed}  geometricallyOpen=${geoOpen}  openShare=${contours ? ((geoOpen / contours) * 100).toFixed(2) : '0'}% ===`,
);
