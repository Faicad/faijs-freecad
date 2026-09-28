import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText } from '../src/unpack.js';
import { parseDocumentXml } from '../src/document.js';
import { effectivePlacement } from '../src/attachment.js';
import { placementOf } from '../src/placement.js';
import type { Placement } from '../src/placement.js';

const fcstd = process.argv[2];
const raw = new Uint8Array(readFileSync(fcstd));
const unpacked = unpackFcstd(raw);
if (!unpacked.ok) {
  console.error('unpack fail', unpacked.error);
  process.exit(1);
}
const xml = memberText(unpacked.value, 'Document.xml');
if (xml === undefined) {
  console.error('no doc');
  process.exit(1);
}
const doc = parseDocumentXml(xml);
if (!doc.ok) {
  console.error('parse fail', doc.error);
  process.exit(1);
}

const placements = new Map<string, Placement>();
for (const obj of doc.value.objects) placements.set(obj.name, effectivePlacement(obj, placements));

const names = ['Sketch', 'Pad', 'Sketch001', 'Pad001', 'Sketch002', 'Pocket', 'Sketch008', 'Pad005'];
for (const nm of names) {
  const o = doc.value.objects.find((x) => x.name === nm);
  if (!o) {
    console.log(nm + ': NOT FOUND');
    continue;
  }
  const eff = placements.get(nm)!;
  const stored = placementOf(o);
  const mode = o.properties.get('MapMode')?.children[0]?.attributes['value'];
  const sup = JSON.stringify(o.properties.get('Support')?.children[0]?.children[0]?.attributes);
  const sketch = o.properties.get('Sketch')?.children[0]?.attributes['value'];
  const profile = o.properties.get('Profile')?.children[0]?.attributes['value'];
  const base = o.properties.get('Base')?.children[0]?.attributes['value'];
  console.log(
    nm + ' (' + o.type + ')  effective=[' + eff.p.join(',') + ']  stored=[' + stored.p.join(',') + ']  mode=' + mode + '  support=' + sup + '  Sketch=' + sketch + '  Profile=' + profile + '  Base=' + base,
  );
}
