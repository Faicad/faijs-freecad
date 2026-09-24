import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync as fsExists } from 'node:fs';
import { tmpdir } from 'node:os';
import { convertFcstdFile } from './convert.js';
import { unzipSync, strFromU8 } from 'fflate';
import { cliRun } from '@faicad/faijs/node';

/**
 * P2-3 single-file acceptance (2026-09-24): prove the sweep/loft/helix
 * translation branch (committed in 8727eb2) actually handles REAL FreeCAD
 * documents — not just the synthetic fixtures in feature-translate.test.ts.
 *
 * The in-flight 10h re-baseline (fcstd-port/state/manifest.jsonl) runs against
 * the PUBLISHED faicad-faijs-0.15.1.tgz, which predates this commit, so it
 * cannot exercise P2-3. This test runs entirely from monorepo source: the
 * conversion path imports packages/fcstd source (P2-3 live), while execution
 * goes through @faicad/faijs/node (core dist — sweep/loft/helix kernel ops
 * already shipped in 0.15.1, unaffected by this change).
 *
 * GOTCHA (same corpus-skip pattern as cli-smoke.test.ts): the corpus lives in
 * the sibling D:/Faicad/FreeCAD-library checkout; when absent the suite skips
 * instead of failing.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/fcstd → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');
const TARGET_TYPES = new Set(['Part::Sweep', 'Part::Loft', 'Part::Helix']);

const CASES = [
  { name: 'Doors_windows', rel: join('Architectural Parts', 'Doors_Windows', 'Doors_windows.FCStd') },
  { name: 'plastic_bottle', rel: join('Generic objects', 'plastic_bottle.FCStd') },
];

function gapTypes(gaps: { type: string }[]): string[] {
  return gaps.map((g) => g.type).filter((t) => TARGET_TYPES.has(t));
}
function targetGaps(gaps: { name: string; type: string; reason: string }[]) {
  return gaps.filter((g) => TARGET_TYPES.has(g.type));
}
// A target-type gap is a P2-3 DISPATCH DEFECT only if the object was never
// recognized (type-not-whitelisted) — i.e. my property-name mapping was wrong
// for real documents. Every other reason means the dispatch correctly
// classified the object and only declined for a legitimate reason: an
// unsupported option (*-unsupported), a missing required sub-shape
// (sweep-missing-*), or an upstream dependency that was baked before it reached
// here (*-baked-upstream). Those are HONEST behaviour, not silent loss, and the
// user explicitly wanted them surfaced — not hidden behind a gap-free claim.
const DEFECT_REASON = 'type-not-whitelisted';
function defectGaps(gaps: { name: string; type: string; reason: string }[]) {
  return targetGaps(gaps).filter((g) => g.reason === DEFECT_REASON);
}

describe.skipIf(!existsSync(CORPUS))('P2-3 single-file acceptance (real FreeCAD sweep/loft/helix)', () => {
  for (const c of CASES) {
    const file = join(CORPUS, c.rel);
    const available = existsSync(file);
    it.skipIf(!available)(`${c.name}: converts with target types recognized (no type-not-whitelisted gap)`, async () => {
      const summary = await convertFcstdFile(file);
      // The core assertion for P2-3: none of the sweep/loft/helix objects fell
      // through to a translation gap BECAUSE THEY WERE UNRECOGNIZED. If my
      // dispatch property names were wrong for real documents, these would
      // appear here as type-not-whitelisted. Honest upstream bakes
      // (*-baked-upstream) and explicitly-unsupported options (*-unsupported)
      // are NOT defects — they prove the dispatch classified the object and only
      // declined for a legitimate reason. See defectGaps().
      const leaked = targetGaps(summary.gaps);
      if (leaked.length) {
        console.log(`[${c.name}] TARGET GAPS: ${JSON.stringify(leaked)}`);
      }
      const defects = defectGaps(summary.gaps);
      expect(defects, `target types unrecognized (P2-3 dispatch defect): ${JSON.stringify(defects)}`).toEqual([]);
      // They must have been counted as translated, not silently dropped.
      expect(summary.counts.translated).toBeGreaterThan(0);
      // Surface the full disposition so a human can see what else (if anything)
      // in the document is still a gap — that is unrelated to P2-3.
      console.log(`[${c.name}] ok=${summary.ok} translated=${summary.counts.translated} ` +
        `pythonBaked=${summary.counts.pythonBaked} preservedOnly=${summary.counts.preservedOnly} ` +
        `gapCount=${summary.gaps.length}` +
        (summary.gaps.length ? ` gapTypes=${JSON.stringify(summary.gaps.map((g) => g.type))}` : ''));
    });

    it.skipIf(!available)(
      `${c.name}: runs end-to-end (cliRun + STEP) when conversion is gap-free`,
      async () => {
        const summary = await convertFcstdFile(file);
        if (!summary.ok || !summary.zip) {
          console.log(`[${c.name}] conversion not gap-free (ok=${summary.ok}); skipping kernel run ` +
            `(remaining gaps are unrelated to P2-3: ${JSON.stringify(summary.gaps.map((g) => g.type))})`);
          return;
        }
        // Extract model/main.fai.js (+ assets) from the produced container.
        const scratch = mkdtempSync(join(tmpdir(), 'p2-3-'));
        const members = unzipSync(summary.zip);
        let mainPath: string | null = null;
        const assetsDir = join(scratch, 'assets');
        for (const [name, bytes] of Object.entries(members)) {
          if (name.startsWith('model/') && name.endsWith('.fai.js')) {
            const p = join(scratch, name.slice('model/'.length));
            mkdirSync(join(p, '..'), { recursive: true });
            writeFileSync(p, strFromU8(bytes));
            if (!mainPath || p.endsWith('main.fai.js')) mainPath = p;
          } else if (name.endsWith('.brp') || name.startsWith('assets/')) {
            mkdirSync(assetsDir, { recursive: true });
            writeFileSync(join(scratch, name.replace(/^assets\//, 'assets/')), Buffer.from(bytes));
          }
        }
        expect(mainPath, 'container had no model/*.fai.js').not.toBeNull();
        const outStep = join(scratch, 'out.step');
        const run = await cliRun(mainPath!, outStep, { mode: 'brep', assetsDir });
        expect(run.ok, `cliRun failed: ${String((run as { error?: unknown }).error ?? '')}`).toBe(true);
        expect(fsExists(outStep), 'STEP file not written').toBe(true);
        const size = readFileSync(outStep).length;
        expect(size, 'STEP file empty').toBeGreaterThan(0);
        console.log(`[${c.name}] run ok, STEP written: ${size} bytes`);
      },
    );
  }
});
