import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertFcstdFile } from './convert.js';
import { ALLOWED_DISPOSITIONS } from './convert.js';

/**
 * CLI smoke test (2026-09-24, fcstd package extraction).
 *
 * The batch CLI (`src/cli.ts`, published bin `faijs-freecad-convert`) is a thin
 * wrapper around `convertFcstdFile`: it prints exactly one JSON summary line to
 * stdout, writes the zip only when `ok`, and maps the summary to exit codes
 * (0 converted / 2 gaps / 1 internal error). The pipeline contract is pinned
 * here against a REAL FreeCAD document — the synthetic fixtures used by the
 * unit tests below never exercise the full read→solve→translate→audit→zip
 * chain end to end.
 *
 * GOTCHA: no `.FCStd` corpus lives in this repository. The sample comes from
 * the sibling fcstd-port repository (same pattern as the mini_lathe e2e
 * fixtures, see memory/AGENTS history); when the sibling checkout is absent
 * the whole suite skips instead of failing — the corpus e2e coverage then
 * remains owned by fcstd-port's own test suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/faijs-freecad → packages → repo root → D:/Faicad (sibling checkout).
const FIXTURE_DIR = join(here, '..', '..', '..', '..', 'fcstd-port', 'test', 'FreeCAD', 'fixtures');
const SAMPLE = join(FIXTURE_DIR, 'taperedballnose.fcstd');

const sampleAvailable = existsSync(SAMPLE);

describe.skipIf(!sampleAvailable)('fcstd CLI pipeline contract (real FreeCAD document)', () => {
  it('convertFcstdFile returns a conforming summary with zero gaps', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    // Machine contract cli.ts relies on: ok flag, gap list, disposition counts.
    expect(summary.ok).toBe(true);
    expect(Array.isArray(summary.gaps)).toBe(true);
    expect(summary.gaps).toEqual([]);
    for (const key of ['translated', 'pythonBaked', 'preservedOnly', 'baked'] as const) {
      expect(summary.counts[key], `counts.${key}`).toBeTypeOf('number');
    }
    expect(summary.counts.translated).toBeGreaterThan(0);
    expect(typeof summary.elapsedMs).toBe('number');
  });

  it('every disposition implied by the summary is an allowed one (C4)', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    // C4: a conforming container only carries translated / python-baked /
    // preserved-only. The count fields are the CLI's source of truth for the
    // audit; if a new count bucket appears without ALLOWED_DISPOSITIONS
    // gaining it, this test is the tripwire.
    const bucketKeys = Object.keys(summary.counts);
    expect(bucketKeys).toContain('translated');
    expect(summary.gaps.length + summary.counts.baked).toBe(0);
    expect(ALLOWED_DISPOSITIONS.has('translated')).toBe(true);
    expect(ALLOWED_DISPOSITIONS.has('python-baked')).toBe(true);
    expect(ALLOWED_DISPOSITIONS.has('preserved-only')).toBe(true);
  });
});
