/**
 * Probe (kept per repo policy): show the expression binding behind a
 * `*-length-expression-non-constant` bake.
 *
 * `hasNonConstantBinding` is `binding !== undefined && binding.value ===
 * undefined`, i.e. the ExpressionEngine has an entry for the property but
 * `evalConstantExpression` could not reduce it to a number. The reasons split
 * into very different work items — a Spreadsheet/VarSet alias we cannot reach,
 * a constraint reference, a unit suffix, an unsupported operator — and the
 * convert-time reason does not say which. This probe prints the raw expression
 * plus what the evaluator managed to resolve.
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-b1-expr.ts [rel] [objName]
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText } from '../src/unpack.js';
import { parseDocumentXml } from '../src/document.js';
import { translateObject } from '../src/feature-translate.js';
import { isOk } from '@faicad/faijs/api/result';

const rel = process.argv[2] ?? 'Electrical Parts/Enclosures/RND_455_00194.fcstd';
const want = process.argv[3];
const raw = new Uint8Array(readFileSync(`D:/Faicad/FreeCAD-library/${rel}`));
const unpacked = unpackFcstd(raw);
if (!isOk(unpacked)) throw new Error(`unpack failed: ${JSON.stringify(unpacked.error)}`);
const xml = memberText(unpacked.value, 'Document.xml');
if (xml === undefined) throw new Error('Document.xml missing');
const doc = parseDocumentXml(xml);
if (!isOk(doc)) throw new Error(`parse failed: ${doc.error.message}`);

for (const o of doc.value.objects) {
  if (want && o.name !== want) continue;
  const ee = o.properties.get('ExpressionEngine');
  if (!ee) continue;
  const exprs = ee.children[0]?.children ?? [];
  if (exprs.length === 0) continue;
  const shown = exprs
    .map((e) => `${e.attributes['path']} = ${e.attributes['expression']}`)
    .join(' | ');
  const v = translateObject(o, (dep) => `var(${dep})`, doc.value.objects);
  console.log(`${o.name} [${o.type}] exprs: ${shown}\n  -> ${v.kind} ${v.kind === 'baked' ? v.reason ?? '' : ''}`);
}
