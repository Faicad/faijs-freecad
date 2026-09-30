/**
 * Probe: for each converted product, actually EXECUTE it (the only valid
 * criterion per the project rules — a gap-free summary proves nothing).
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-products.ts <list.txt>
 *   list.txt: one corpus-relative (or absolute) FCStd path per line.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { convertFcstdFile } from '../src/convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeSketchNamespace(createApiNamespace());
const CORPUS = 'D:/Faicad/FreeCAD-library';

const listFile = process.argv[2]!;
const paths = readFileSync(listFile, 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => (l.includes('\t') ? l.split('\t').slice(1).join('\t') : l))
  .map((p) => (isAbsolute(p) ? p : join(CORPUS, p)));

let convOk = 0, runOk = 0, runFail = 0;
const errs = new Map<string, number>();
for (const [i, p] of paths.entries()) {
  try {
    const s = await convertFcstdFile(p);
    if (!s.ok || !s.zip) { console.log(`[${i + 1}/${paths.length}] CONV-GAP  ${basename(p)}`); continue; }
    convOk++;
    const { manifest, loader, assets } = openContainer(s.zip);
    const scratch = mkdtempSync(join(tmpdir(), 'fai-prod-'));
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
    let allOk = true;
    let firstErr = '';
    for (const m of manifest.models) {
      const out = join(scratch, `out-${m.id}.step`);
      let r: { ok: boolean; error?: unknown };
      try {
        r = await cliRun(join(scratch, m.entry), out, {
          mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS },
        });
      } catch (e) {
        r = { ok: false, error: 'THREW: ' + String((e as Error).message ?? e) };
      }
      const stepBytes = readdirSync(scratch).filter((f) => f.endsWith('.step'))
        .reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
      if (!r.ok || stepBytes === 0) {
        allOk = false;
        firstErr = firstErr || `${m.id}: ${String(r.error ?? 'empty STEP')}`;
      }
    }
    if (allOk) { runOk++; console.log(`[${i + 1}/${paths.length}] RUN-OK    ${basename(p)}`); }
    else {
      runFail++;
      const key = firstErr.slice(0, 110);
      errs.set(key, (errs.get(key) ?? 0) + 1);
      console.log(`[${i + 1}/${paths.length}] RUN-FAIL  ${basename(p)} :: ${firstErr.slice(0, 160)}`);
    }
  } catch (e) {
    runFail++;
    const key = 'PROBE-THREW: ' + String((e as Error).message ?? e).slice(0, 100);
    errs.set(key, (errs.get(key) ?? 0) + 1);
    console.log(`[${i + 1}/${paths.length}] RUN-FAIL  ${basename(p)} :: ${key}`);
  }
}

console.log(`\n=== converted ok: ${convOk}/${paths.length}; ran ok: ${runOk}; ran failed: ${runFail} ===`);
console.log('--- failure reasons ---');
for (const [k, v] of [...errs.entries()].sort((a, b) => b[1] - a[1])) console.log(`${v}\t${k}`);
