/**
 * Probe (kept per repo policy): show why a `Shape`/`SubShape` `file` attribute
 * is judged a broken asset (`shape-asset-broken: frozen .brp member missing or
 * empty`).
 *
 * The convert-time check is
 *   `shapeFile !== undefined && !!memberText(unpacked, shapeFile)`
 * which conflates three very different situations:
 *   (1) the member is genuinely absent from the archive;
 *   (2) the member is present but zero bytes;
 *   (3) the member is present and non-empty but `memberText` refuses it
 *       (binary BREP / non-UTF-8 payload).
 * Only (1) and (2) are real defects. This probe prints which one it is, plus a
 * case-insensitive candidate lookup so a name-casing mismatch is visible.
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-shape-asset.ts [rel] [objName]
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText } from '../src/unpack.js';
import { parseDocumentXml } from '../src/document.js';
import { isOk } from '@faicad/faijs/api/result';

const rel = process.argv[2] ?? 'Electrical Parts/Enclosures/RND_455_00194.fcstd';
const want = process.argv[3];
const raw = new Uint8Array(readFileSync(`D:/Faicad/FreeCAD-library/${rel}`));
const unpacked = unpackFcstd(raw);
if (!isOk(unpacked)) throw new Error(`unpack failed: ${JSON.stringify(unpacked.error)}`);
const members = unpacked.value.members;
const xml = memberText(unpacked.value, 'Document.xml');
if (xml === undefined) throw new Error('Document.xml missing');
const doc = parseDocumentXml(xml);
if (!isOk(doc)) throw new Error(`parse failed: ${doc.error.message}`);

const lower = new Map<string, string>();
for (const k of members.keys()) lower.set(k.toLowerCase(), k);

for (const obj of doc.value.objects) {
  if (want && obj.name !== want) continue;
  for (const prop of ['Shape', 'SubShape']) {
    const file = obj.properties.get(prop)?.children[0]?.attributes['file'];
    if (file === undefined) continue;
    const exact = members.get(file);
    const ci = lower.get(file.toLowerCase());
    const size = exact?.byteLength ?? (ci ? members.get(ci)?.byteLength : undefined);
    const text = memberText(unpacked.value, file);
    const ok = file !== undefined && !!text;
    console.log(
      `${obj.name}.${prop} file=${file} exact=${exact !== undefined} ci=${ci !== undefined && ci !== file ? ci : '-'} `
      + `bytes=${size ?? 'n/a'} memberText=${text === undefined ? 'undefined' : String(text.length)} judge=${ok ? 'OK' : 'BROKEN'}`,
    );
  }
}
