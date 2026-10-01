/**
 * A1 (2026-09-29 plan) — the analytic Draft rebuild, end to end and BY EXECUTION.
 *
 * The regression this file exists for: `Sprocket ANSI simplex 1¾x1¼ z21` is a
 * Draft object (`Part::Part2DObjectPython`) whose frozen `.brp` holds 1 wire of
 * **168 analytic edges — 126 circle + 42 line, zero param curves** (measured with
 * `tools/probe-draft-curves.ts` against `PartShape1.brp`). The old rebuild
 * tessellated all of them into one `pen.polyline([…])` of 7010 points and OCC
 * never finished the wire: 420 s, not even a STEP. Every Sprocket in the library
 * (449 of 3131 corpus products) died the same way.
 *
 * Two facts this file pins, and neither can be faked by a green conversion
 * summary (the standing rule: a gap-free conversion proves nothing, the product
 * must RUN):
 *   · the emitted contour is ANALYTIC — exactly 126 `arc` + 42 `line` segments,
 *     i.e. every edge kept its source curve kind instead of being sampled;
 *   · the product executes and writes a STEP.
 *
 * Corpus-dependent like the sibling e2e files: the FreeCAD library lives in the
 * sibling checkout, so this SKIPS (never fails) when it is absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readZipEntries } from '@faicad/faijs/io/zip';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '@faicad/faijs-draw';
import { convertFcstdFile } from './convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';

installSketchSolver(createNodePlanegcsSolver);

// The host a real `.fai.zip` consumer must provide. `draw` is still registered
// because the fcstd package declares it as a runtime dependency — after A1 no
// Draft emission calls `cad.draw` any more (the contours travel as `ProfileLoop`
// data), which is worth knowing when that dependency is next reviewed.
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/fcstd → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');
const REL = join(
  'Mechanical Parts', 'Chains', 'Sprocket', 'ISO 606', 'Simplex 1¾x1¼',
  'Sprocket ANSI simplex 1¾x1¼ z21.FCStd',
);

/** Every emitted model module's source, concatenated. */
function modelSource(zip: Uint8Array): string {
  const members = readZipEntries(zip);
  return [...members]
    .filter(([n]) => n.endsWith('.fai.js'))
    .map(([, b]) => new TextDecoder().decode(b))
    .join('\n');
}

/** Materialise the product into a scratch project and execute every model. */
async function runProduct(zip: Uint8Array): Promise<string | undefined> {
  const { manifest, loader, assets } = openContainer(zip);
  const scratch = mkdtempSync(join(tmpdir(), 'fai-a1-'));
  const assetsDir = join(scratch, 'assets');
  for (const [name, bytes] of Object.entries(assets)) {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
  }
  for (const mk of loader.listModules()) {
    const q = join(scratch, 'model', mk);
    mkdirSync(join(q, '..'), { recursive: true });
    writeFileSync(q, await loader.readSource(mk));
  }
  for (const m of manifest.models) {
    const out = join(scratch, `out-${m.id}.step`);
    const r = await cliRun(join(scratch, m.entry), out, {
      mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS },
    });
    if (!r.ok) return `${m.id} failed: ${String((r as { error?: unknown }).error ?? '')}`;
    const stepBytes = readdirSync(scratch)
      .filter((f) => f.endsWith('.step'))
      .reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
    if (stepBytes === 0) return `${m.id} wrote no STEP`;
  }
  return undefined;
}

describe.skipIf(!existsSync(CORPUS))('A1 analytic Draft rebuild (real FreeCAD documents)', () => {
  describe.skipIf(!existsSync(join(CORPUS, REL)))('Sprocket ANSI simplex 1¾x1¼ z21 (168 analytic Draft edges)', () => {
    it('GOTCHA: emits one analytic segment per source edge — 126 arc + 42 line, no tessellated polyline', async () => {
      const summary = await convertFcstdFile(join(CORPUS, REL));
      expect(summary.ok, `gaps: ${JSON.stringify(summary.gaps)} error: ${summary.error}`).toBe(true);
      const src = modelSource(summary.zip!);
      // The old emission: ONE `pen.polyline([…7010 points…])` per contour. Assert
      // the broken shape is GONE, not just that the new one is present, or a
      // regression could reintroduce it alongside.
      expect(src).not.toMatch(/pen\.polyline/);
      expect(src).not.toMatch(/cad\.draw\(/);
      // The drawn loop must reach the run time as a `ProfileLoop`, which is what
      // `cad.sketchOnPlane` feeds into `profileSegToCurve` → makeLineEdge/makeArcEdge.
      expect(src).toMatch(/cad\.sketchOnPlane\(\{ contours: \[\{/);
      // GOTCHA: count INSIDE the Draft loop only. The same module also carries a
      // parametric `cad.sketch({ geoms: [{ "kind": "arc", … }] })` for the Groove
      // profile (A2 path) — a document-wide `"kind":"arc"` grep counts that too and
      // reads 128 instead of 126.
      const loopStart = src.indexOf('cad.sketchOnPlane(');
      expect(loopStart).toBeGreaterThan(-1);
      const loop = src.slice(loopStart, src.indexOf(', plane:', loopStart));
      // The counts are the whole point: they equal the .brp's own edge histogram
      // (`tools/probe-draft-curves.ts` on PartShape1.brp: circle=126 line=42), so
      // they fail if ANY edge is sampled instead of kept analytic.
      expect((loop.match(/"kind":"arc"/g) ?? []).length).toBe(126);
      expect((loop.match(/"kind":"line"/g) ?? []).length).toBe(42);
    }, 600_000);

    it('runs the product end to end (the old emission never produced a STEP at all)', async () => {
      const summary = await convertFcstdFile(join(CORPUS, REL));
      expect(summary.zip).toBeDefined();
      const err = await runProduct(summary.zip!);
      expect(err, String(err ?? '')).toBeUndefined();
    }, 600_000);
  });
});
