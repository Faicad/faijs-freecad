/**
 * End-to-end regression for `Part::Compound` members that carry no geometry.
 *
 * FreeCAD's `Part::Compound` lists every linked object in `Links` and simply
 * ignores the ones without a Shape. The FCBL family puts the document's
 * `App::VarSet` (a parameter container the Extrudes read their expressions
 * from) FIRST in that list, so requiring every link to resolve a geometry
 * variable gapped the whole document with `compound-missing-members` even
 * though every Extrusion member resolved. The unit-level contract lives in
 * feature-type.test.ts; this file proves it on REAL documents end to end —
 * the document converts gap-free AND the emitted `cad.compound` carries
 * exactly the geometry links (VarSet must leave no trace in the member list,
 * since a preserved-only object never gets a codegen variable).
 *
 * Corpus-dependent, exactly like external-vertex-e2e.test.ts: the FreeCAD
 * library lives in the sibling checkout, so the suite SKIPS (never fails) when
 * absent.
 *
 * NOTE (2026-09-28): these products are NOT executed here. Running them
 * surfaces a separate, pre-existing defect — the canonical sketch projection
 * drops the construction flag and `toFreeCadGeoms` rejects `point` — which
 * these sketches carry. That defect is tracked and fixed on its own; a
 * product-execution assertion belongs to its regression test, not this one.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readZipEntries } from '@faicad/faijs/io/zip';
import { convertFcstdFile } from './convert.js';

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/fcstd → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');

const CASES = [
  { name: 'FCBL_curtain (1 VarSet + 1 Extrusion)', rel: join('Architectural Parts', 'Miscellaneous', 'FCBL_curtain.FCStd'), members: 1 },
  { name: 'FCBL_bed_double (1 VarSet + 5 Extrusions)', rel: join('Architectural Parts', 'Bedroom', 'FCBL_bed_double.FCStd'), members: 5 },
  { name: 'FCBL_nightstand_wall_hung (1 VarSet + 6 Extrusions)', rel: join('Architectural Parts', 'Bedroom', 'FCBL_nightstand_wall_hung.FCStd'), members: 6 },
];

/** Read `model/main.fai.js` out of the container and count the compound members. */
function compoundMemberCount(zip: Uint8Array, objectName: string): number | undefined {
  const members = readZipEntries(zip);
  const entry = [...members.keys()].find((n) => n.endsWith('main.fai.js'));
  if (!entry) return undefined;
  const src = new TextDecoder().decode(members.get(entry)!);
  const m = src.match(new RegExp(`(?:let\\s+)?${objectName}\\s*=\\s*cad\\.compound\\(\\{\\s*members:\\s*\\[([^\\]]*)\\]`));
  if (!m) return undefined;
  return m[1]!.split(',').map((s) => s.trim()).filter(Boolean).length;
}

describe.skipIf(!existsSync(CORPUS))('Part::Compound with non-modeling members (real FreeCAD documents)', () => {
  for (const c of CASES) {
    const file = join(CORPUS, c.rel);
    it.skipIf(!existsSync(file))(`${c.name}: converts gap-free and compounds only the geometry links`, async () => {
      const summary = await convertFcstdFile(file);
      const compoundGaps = summary.gaps.filter((g) => g.reason.startsWith('compound-missing-members'));
      expect(compoundGaps, `compound gaps: ${JSON.stringify(compoundGaps)}`).toEqual([]);
      expect(summary.ok, `gaps: ${JSON.stringify(summary.gaps)}`).toBe(true);
      expect(summary.zip).toBeDefined();
      if (!summary.zip) return;

      // The proof that the VarSet link left no trace: the object produces no
      // codegen variable, so a member list that still required it could never
      // reach this shape.
      expect(compoundMemberCount(summary.zip, 'Compound')).toBe(c.members);
    });
  }
});
