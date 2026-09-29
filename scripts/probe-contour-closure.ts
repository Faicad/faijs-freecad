/**
 * Per-PRODUCT open/closed contour audit (2026-09-29).
 *
 * A1 emits a Draft drawing as one `cad.sketchOnPlane` call per shape KIND: all
 * closed contours in one call (no `as`), and one `as:'wire'` call per open
 * contour (`draft-draw.ts` → `codegen.ts`). So the generated source states the
 * split directly, and this probe reads it back off generated products instead of
 * re-running the kernel — the only way to audit the whole library cheaply.
 *
 * Predecessor note: the previous version of this file parsed the superseded
 * `cad.draw((pen) => pen.polyline(…))` form by splitting on `moveTo(`. That
 * emission no longer exists, and its "geometrically closed" count was a
 * re-measurement of points the converter had already decided about. Reading the
 * emitted call kind is both simpler and truer to what the run time will build.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-contour-closure.ts [productsRoot]
 *   (default `out/insp2`: one sub-directory per product, each with model/main.fai.js)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'out/insp2';
let closedLoops = 0;
let openLoops = 0;
const rows: string[] = [];

for (const d of readdirSync(root)) {
  const f = join(root, d, 'model', 'main.fai.js');
  let src: string;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  let closed = 0;
  let open = 0;
  for (const raw of src.split('cad.sketchOnPlane(').slice(1)) {
    const call = raw.slice(0, raw.indexOf('});') + 1);
    const loops = (call.match(/"segments":\[/g) ?? []).length;
    if (loops === 0) continue;
    // An `as:'wire'` call always carries exactly one contour (codegen emits one
    // per open loop); a call without it is the whole closed group.
    if (/as: "wire"/.test(call)) open += loops;
    else closed += loops;
  }
  if (closed + open > 0) rows.push(`${d}  closed=${closed} open=${open}`);
  closedLoops += closed;
  openLoops += open;
}

console.log(rows.join('\n'));
const total = closedLoops + openLoops;
console.log(
  `\n=== contours=${total}  closed=${closedLoops}  open=${openLoops}  openShare=${total ? ((openLoops / total) * 100).toFixed(2) : '0'}% ===`,
);
