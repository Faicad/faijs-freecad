/**
 * Probe: what a rebuilt Draft contour looks like, contour by contour.
 *
 * Why this exists: A1 (`draft-draw.ts`) emits `ProfileLoop` segments (`line` /
 * `arc`) straight into `cad.sketchOnPlane`, and the run time turns them into one
 * edge per segment + `makeWire` + `makeFace`. That is STRICTER than the
 * superseded single-`polyline` form in exactly two ways, and this probe names
 * which one a document hits:
 *   · a wire must be SEWABLE — every segment must start where the previous one
 *     ended (the emitted numbers have to agree, not merely be close);
 *   · a face needs a CLOSED loop — the last segment must end on the first one's
 *     start, or `makeFace` reports `construction failed`.
 *
 * It also reports the arc sweep range, because a `ccw` that got flipped turns a
 * short arc into its complement and can make the loop self-intersecting.
 *
 * Usage: node --import tsx packages/fcstd/scripts/probe-draft-loop.ts "<doc.FCStd>" [objectName]
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText, parseDocumentXml } from '../src/index.js';
import { extractDraftDrawing, isDraft2DObject, segmentEnd, segmentStart } from '../src/draft-draw.js';

const docPath = process.argv[2];
const onlyName = process.argv[3];
if (!docPath) {
  console.error('usage: probe-draft-loop.ts "<doc.FCStd>" [objectName]');
  process.exit(1);
}

const unpacked = unpackFcstd(new Uint8Array(readFileSync(docPath)));
if (!unpacked.ok) {
  console.error(`unpack failed: ${JSON.stringify(unpacked.error)}`);
  process.exit(1);
}
const xml = memberText(unpacked.value, 'Document.xml');
if (xml === undefined) {
  console.error('Document.xml missing');
  process.exit(1);
}
const parsed = parseDocumentXml(xml);
if (!parsed.ok) {
  console.error(`parse failed: ${parsed.error.message}`);
  process.exit(1);
}

for (const obj of parsed.value.objects) {
  if (!isDraft2DObject(obj)) continue;
  if (onlyName && obj.name !== onlyName) continue;
  const drawing = await extractDraftDrawing(obj, unpacked.value);
  if (!drawing) {
    console.log(`${obj.name}: NO DRAWING`);
    continue;
  }
  console.log(`\n=== ${obj.name} (${obj.type}) contours=${drawing.contours.length} ===`);
  for (let ci = 0; ci < drawing.contours.length; ci++) {
    const c = drawing.contours[ci]!;
    const kinds = c.segments.reduce<Record<string, number>>((a, s) => ((a[s.kind] = (a[s.kind] ?? 0) + 1), a), {});
    let maxGap = 0;
    let maxGapAt = -1;
    for (let i = 1; i < c.segments.length; i++) {
      const prev = segmentEnd(c.segments[i - 1]!);
      const here = segmentStart(c.segments[i]!);
      const g = Math.hypot(prev[0] - here[0], prev[1] - here[1]);
      if (g > maxGap) {
        maxGap = g;
        maxGapAt = i;
      }
    }
    const first = segmentStart(c.segments[0]!);
    const last = segmentEnd(c.segments[c.segments.length - 1]!);
    const closure = Math.hypot(last[0] - first[0], last[1] - first[1]);
    const sweeps = c.segments
      .filter((s) => s.kind === 'arc')
      .map((s) => {
        const a = s as Extract<typeof s, { kind: 'arc' }>;
        let sweep = a.ccw ? a.endAngle - a.startAngle : a.startAngle - a.endAngle;
        while (sweep <= 0) sweep += 2 * Math.PI;
        while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
        return sweep;
      });
    console.log(
      `  [${ci}] segs=${c.segments.length} closed=${c.closed} ${JSON.stringify(kinds)} ` +
        `maxAdjGap=${maxGap.toExponential(2)}@${maxGapAt} closureGap=${closure.toExponential(2)} ` +
        `arcSweep=[${sweeps.length ? Math.min(...sweeps).toFixed(4) : '-'}, ${sweeps.length ? Math.max(...sweeps).toFixed(4) : '-'}]`,
    );
    if (!c.closed || maxGap > 1e-6 || closure > 1e-6) {
      console.log(`      first=${JSON.stringify(first)} last=${JSON.stringify(last)}`);
      if (maxGapAt > 0 && maxGap > 1e-6) {
        console.log(`      gap @${maxGapAt - 1}->${maxGapAt}: ${JSON.stringify(c.segments[maxGapAt - 1])}`);
        console.log(`                    ${JSON.stringify(c.segments[maxGapAt])}`);
      }
      if (c.segments.length <= 8) console.log(`      segs=${JSON.stringify(c.segments)}`);
    }
  }
}
