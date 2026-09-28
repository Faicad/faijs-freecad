import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertFcstdFile } from './convert.js';
import { openContainer } from './container-read.js';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
// A2 (2026-09-28): converted models now emit `cad.sketch` (parametric
// sketches) — the run host must merge the sketch library into the cad
// namespace and install the planegcs solver, exactly as a real host would.
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';

// A2: install once for the whole suite — every cliRun below inherits the
// solver through the module-level install.
installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeSketchNamespace(createApiNamespace());

/**
 * P2/P3 — unified container acceptance (2026-09-27, format v3).
 *
 * Replaces the manual materialize-to-temp-directory approach: a converted
 * product is opened with `openContainer`, every model's entry is read through
 * the returned ProjectLoader, and each model executes via the BREP chain and
 * produces geometry. This is the same entry a host (editor / fcstd-port) will
 * use, so it pins the writer↔reader contract end to end.
 *
 * GOTCHA (same corpus-skip pattern as cli-smoke.test.ts): the sample comes
 * from the sibling fcstd-port repository; when it is absent the suite skips.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, '..', '..', '..', '..', 'fcstd-port', 'test', 'FreeCAD', 'fixtures');
const SAMPLE = join(FIXTURE_DIR, 'taperedballnose.fcstd');
const sampleAvailable = existsSync(SAMPLE);

describe.skipIf(!sampleAvailable)('unified .fai.zip openContainer acceptance (format v3)', () => {
  it('converted product opens via openContainer and every model executes to geometry', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    expect(summary.ok, `conversion failed: ${JSON.stringify(summary.gaps)}`).toBe(true);
    expect(summary.zip).toBeDefined();
    if (!summary.zip) return;

    const { manifest, activeModel, loader, files, assets } = openContainer(summary.zip);

    // manifest declares the unified schema
    expect(manifest.format).toBe(3);
    expect(manifest.units).toBe('mm');
    expect(manifest.models.length).toBeGreaterThanOrEqual(1);
    expect(manifest.requiresBrep).toBe(true);
    expect(activeModel).toBeDefined();

    // models[] covers main + every Body script member (each executes standalone)
    const modelIds = manifest.models.map((m) => m.id);
    expect(modelIds).toContain('main');
    expect(new Set(modelIds).size).toBe(modelIds.length);
    for (const m of manifest.models) {
      expect(m.entry.startsWith('model/')).toBe(true);
      expect(loader.listModules()).toContain(m.entry.slice('model/'.length));
      const src = await loader.readSource(m.entry.slice('model/'.length));
      expect(src.length).toBeGreaterThan(0);
    }

    // BREP assets referenced by the scripts must be present in assets/
    expect(Object.keys(assets).length).toBeGreaterThan(0);
    for (const m of manifest.models) {
      const entryKey = m.entry.slice('model/'.length);
      const scratch = mkdtempSync(join(tmpdir(), 'fai-zip-e2e-'));
      const assetsDir = join(scratch, 'assets');
      for (const [name, bytes] of Object.entries(assets)) {
        mkdirSync(assetsDir, { recursive: true });
        writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
      }
      // materialize the whole module graph under scratch (same layout as the
      // container), so relative imports resolve through projectRoot
      for (const moduleKey of loader.listModules()) {
        const p = join(scratch, 'model', moduleKey);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, await loader.readSource(moduleKey));
      }
      const script = join(scratch, m.entry);
      const outStep = join(scratch, 'out.step');
      const run = await cliRun(script, outStep, { mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS } });
      expect(run.ok, `model "${m.id}" (${m.entry}) failed: ${JSON.stringify((run as { error?: unknown }).error ?? '')}`).toBe(true);
      // 单终端 → out.step；多终端 → out.step_<i>_<name>.step；两者任一存在且非空即可
      const stepFiles = readdirSync(scratch).filter((f) => f.endsWith('.step'));
      expect(stepFiles.length, `model "${m.id}" produced no STEP output (dir: ${readdirSync(scratch).join(', ')})`).toBeGreaterThan(0);
      let totalBytes = 0;
      for (const f of stepFiles) totalBytes += readFileSync(join(scratch, f)).length;
      expect(totalBytes, `model "${m.id}" produced empty STEP outputs`).toBeGreaterThan(0);
    }
  });

  it('referencing a conditionally-required asset that is absent is an error, not a silent skip (§2.1.4-3)', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    expect(summary.ok).toBe(true);
    expect(summary.zip).toBeDefined();
    if (!summary.zip) return;
    const { manifest, loader, assets } = openContainer(summary.zip);
    const scratch = mkdtempSync(join(tmpdir(), 'fai-zip-missing-asset-'));
    const assetsDir = join(scratch, 'assets');
    for (const [name, bytes] of Object.entries(assets)) {
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
    }
    for (const moduleKey of loader.listModules()) {
      const p = join(scratch, 'model', moduleKey);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, await loader.readSource(moduleKey));
    }
    // entry script references an asset key that does not exist in the container
    const script = join(scratch, manifest.models[0]!.entry);
    const broken = join(scratch, 'broken.fai.js');
    writeFileSync(broken, `let ghost = cad.import_brep({ asset: "no-such-asset" });\n`);
    const outStep = join(scratch, 'out.step');
    const run = await cliRun(broken, outStep, { mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS } });
    expect(run.ok, 'missing asset must surface as an execution error').toBe(false);
    expect(JSON.stringify((run as { error?: unknown }).error ?? '')).toMatch(/no-such-asset|asset/i);
  });
});
