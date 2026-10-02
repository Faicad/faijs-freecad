/**
 * Probe (kept per repo policy): dump the raw Document.xml properties of chosen
 * objects in an FCStd file, so translator branches can be checked against the
 * real serialization instead of the (possibly wrong) property-name assumption.
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-b2-xml.ts <rel> [objName ...]
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText } from '../src/unpack.js';
import { parseDocumentXml } from '../src/document.js';
import { isOk } from '@faicad/faijs/api/result';

const rel = process.argv[2] ?? 'Architectural Parts/Bedroom/Beds.FCStd';
const want = new Set(process.argv.slice(3));

const raw = new Uint8Array(readFileSync(`D:/Faicad/FreeCAD-library/${rel}`));
const unpacked = unpackFcstd(raw);
if (!isOk(unpacked)) throw new Error(JSON.stringify(unpacked.error));
const xml = memberText(unpacked.value, 'Document.xml')!;
const doc = parseDocumentXml(xml);
if (!isOk(doc)) throw new Error(doc.error.message);

for (const obj of doc.value.objects) {
  if (want.size > 0 && !want.has(obj.name)) continue;
  if (want.size === 0 && !/Loft|Compound|Sweep/.test(obj.type)) continue;
  console.log(`\n=== ${obj.name} :: ${obj.type} ===`);
  for (const [name, p] of obj.properties) {
    const deep: string[] = [];
    for (const c of p.children) {
      for (const g of c.children) {
        if (g.attributes['value']) deep.push(`${c.tagName}/${g.tagName}=${g.attributes['value']}`);
      }
    }
    const vals = p.children.map((c) => c.attributes['value']).filter(Boolean);
    console.log(`  ${name} [${p.type}] tag=${p.tagName} children=${p.children.length} values=${JSON.stringify(vals).slice(0, 200)} deep=${JSON.stringify(deep).slice(0, 400)}`);
  }
}
