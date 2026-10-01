/**
 * C2 e2e (2026-10-01) — root shape-asset Placement on a REAL FreeCAD document.
 *
 * `Mechanical Parts/Enclosures/HBS/HBS_assembly.FCStd` is a flat Part document
 * (no Body): two shape-assets (`Cut`, `Cut001`) are consumed by a frozen
 * `Part::Compound`, and `Cut002` (a nut, Document Placement z=+3) is a ROOT.
 *
 * The truth reference (`fcstd-port/tools/export-fcstd-truth.py`) compounds only
 * the ROOT shape objects and applies each root's Document Placement ON TOP of
 * its `.brp`-read shape — so `Cut002` MUST be re-placed by +3. Its `.brp` header
 * embeds a location equal to that same placement (brpEmbeddedLocation == +3),
 * which the old `prePlacedAssets` heuristic mistook for "already placed" and
 * dropped the `cad.place` → faijs com z 5.4284 vs truth 6.1738
 * (`com(1.21e-01)`). A CHILD (`Cut001`, embedded +0.5 == its Placement) must
 * keep the skip: the parent Compound's frozen `.brp` already carries it.
 *
 * Numeric proof of the fixed geometry (OCP, same kernel family as faijs):
 *   compound(read(PartShape2), place(read(PartShape3), z=3))
 *   → com z 6.1737645296731785 == truth, delta 0.000000.
 *
 * GOTCHA (same corpus-skip pattern as container-open-e2e.test.ts): the sample
 * lives in the sibling `FreeCAD-library` checkout; when absent the suite skips.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertFcstdFile } from './convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(
  here, '..', '..', '..', '..',
  'FreeCAD-library', 'Mechanical Parts', 'Enclosures', 'HBS', 'HBS_assembly.FCStd',
);
const sampleAvailable = existsSync(SAMPLE);

describe.skipIf(!sampleAvailable)('C2 root shape-asset Placement (HBS_assembly)', () => {
  it('re-applies the ROOT Cut002 Placement (+3) and keeps the CHILD Cut001 skip', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    expect(summary.ok, `conversion failed: ${JSON.stringify(summary.gaps)}`).toBe(true);
    if (!summary.zip) throw new Error('no product');

    const { loader } = openContainer(summary.zip);
    const src = await loader.readSource('main.fai.js');

    // ROOT Cut002: the +3 Document Placement must be re-applied on top of the
    // .brp-read shape (the .brp header's embedded +3 does NOT license a skip).
    const placeCalls = [...src.matchAll(/cad\.place\((\w+), \{[^}]*position: \[([^\]]*)\]/g)];
    const placed = placeCalls.map((m) => ({ input: m[1]!, position: m[2]! }));
    expect(placed, `expected exactly one cad.place, got: ${JSON.stringify(placed)}\n${src}`).toEqual([
      { input: 'Cut002', position: '0,0,3' },
    ]);
    // CHILD Cut001 (embedded +0.5 == its Placement) must stay unplaced.
    expect(src).not.toMatch(/cad\.place\(Cut001/);
  });

  it('runs end to end and produces a non-empty STEP', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    if (!summary.zip) throw new Error('no product');
    const { loader, assets } = openContainer(summary.zip);

    const scratch = mkdtempSync(join(tmpdir(), 'c2-hbs-e2e-'));
    const assetsDir = join(scratch, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    for (const [name, bytes] of Object.entries(assets)) {
      writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
    }
    for (const moduleKey of loader.listModules()) {
      const p = join(scratch, 'model', moduleKey);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, await loader.readSource(moduleKey));
    }

    const run = await cliRun(
      join(scratch, 'model', 'main.fai.js'),
      join(scratch, 'out.step'),
      { mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: createApiNamespace() } },
    );
    expect(run.ok, `run failed: ${JSON.stringify((run as { error?: unknown }).error ?? '')}`).toBe(true);
    const steps = readdirSync(scratch).filter((f) => f.endsWith('.step'));
    expect(steps.length).toBeGreaterThan(0);
    const bytes = steps.reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
    expect(bytes).toBeGreaterThan(0);
  });
});
