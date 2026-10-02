/**
 * End-to-end regression for external-VERTEX links (`VertexN`).
 *
 * Before 2026-09-28 such a link aborted the whole sketch with
 * `external-geometry-unresolved: unsupported sub-element` (only `EdgeN` was
 * handled), which cascaded into `pad-missing-profile` / `groove-*` gaps for
 * every downstream feature. The unit-level contracts live in
 * external-geo.test.ts and sketch-solver.test.ts; this file proves the whole
 * chain (ordinal convention → sketch-local projection → geoId alignment) on
 * REAL documents.
 *
 * Corpus-dependent, exactly like p2-3-single-file.test.ts: the FreeCAD library
 * lives in the sibling checkout, so the suite SKIPS (never fails) when absent.
 *
 * door-keeper.FCStd is the sharpest carrier — its ONLY gap was the external
 * vertex (`Sketch002` → `Sketch001.Vertex1`), so a correct pipeline makes the
 * document gap-free with every sketch at L0.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertFcstdFile } from './convert.js';

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/faijs-freecad → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');

const CASES = [
  {
    name: 'door-keeper (vertex of a sketch)',
    rel: join('Logistics', 'Shipping Containers', '20_Feet_ISO_Container', 'door-keeper.FCStd'),
  },
  {
    name: 'CrankShaft (vertex of a pad)',
    rel: join('Mechanical Parts', 'Automotive', 'CrankShaft.FCStd'),
  },
];

describe.skipIf(!existsSync(CORPUS))('external-vertex links (real FreeCAD documents)', () => {
  for (const c of CASES) {
    const file = join(CORPUS, c.rel);
    it.skipIf(!existsSync(file))(
      `${c.name}: no external-geometry failure and every sketch at L0`,
      async () => {
        const summary = await convertFcstdFile(file);
        const extGaps = summary.gaps.filter((g) => g.reason.startsWith('external-geometry-unresolved'));
        expect(extGaps, `external-geometry failures: ${JSON.stringify(extGaps)}`).toEqual([]);
        // L0 means the re-solve reproduced FreeCAD's stored coordinates, so a
        // wrong vertex ordinal or a shifted geoId cannot pass this.
        expect(summary.sketches.l2, 'a sketch still fell back to L2').toBe(0);
        expect(summary.sketches.l0).toBe(summary.sketches.total);
      },
    );
  }
});
