/**
 * Re-baseline sweep — the measurement door for the C3c family.
 *
 * Why it exists: every corpus verdict on disk (`faijs-invariants.jsonl`,
 * `parity-*.json`) was produced from `out/batch/*.fai.zip`, i.e. the codegen of
 * SOME EARLIER faijs revision. A code change in `packages/fcstd/src` is
 * invisible to those artefacts until the corpus is converted AND executed AND
 * re-measured — and the fcstd-port side cannot do that from this workspace
 * (its `@faicad/faijs-fcstd` is a `file:` tgz, and its worker shells out to
 * `npx tsx`, which this sandbox blocks).
 *
 * So this runs the same three steps in-process, against THIS working tree:
 *
 *   1. `convertFcstdFile` (this repo's src, not the published tgz)
 *   2. materialize the product and `cliRun` it on the BREP path
 *   3. copy every exported STEP terminal out as
 *      `<product-stem>.step` / `<product-stem>__<i>_<name>.step`
 *
 * The output directory is then fed to fcstd-port's own
 * `tools/step-invariants.py --batch <dir> <jsonl>` and
 * `tools/parity-judge.py <truth> <jsonl> <out>`, so the numbers are computed by
 * the same OCP interpreter and judged by the same tolerance as the canonical
 * run — only the CODE that produced the STEPs differs. That is exactly the
 * variable under test.
 *
 * STDOUT DISCIPLINE: one JSON line per product, flushed as it finishes, so a
 * long subset run can be watched without waiting for the report file.
 *
 * Serial by construction (one product at a time, one scratch dir each), scratch
 * always under the OS temp dir — the workspace safe-delete guard counts
 * recursive deletions per turn and refuses past 50, so corpus scratch never
 * lives in the repo.
 *
 * Usage (from packages/fcstd, no npx needed):
 *   node ../../node_modules/tsx/dist/cli.mjs scripts/rebased-sweep.ts \
 *     --only <list.txt> [--out <stepsDir>] [--limit N] [--report <json>]
 *
 * The `--only` list holds corpus-relative paths (either separator); products
 * are named from fcstd-port's `state/manifest.jsonl` so STEP stems line up with
 * the truth records without recomputing the content hash.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliRun, cliCheck } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '@faicad/faijs-draw';
import { convertFcstdFile } from '../src/convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const onlyList = arg('--only');
if (!onlyList) {
  console.error('usage: rebased-sweep.ts --only <rel-list.txt> [--out dir] [--limit N] [--report json]');
  process.exit(2);
}
const CORPUS = resolve(arg('--corpus') ?? join(repoRoot, '..', 'FreeCAD-library'));
const MANIFEST = resolve(arg('--manifest') ?? 'D:/Faicad/fcstd-port/state/manifest.jsonl');
const OUT = resolve(arg('--out') ?? 'D:/Faicad/fcstd-port/out/rebased-steps');
const REPORT = resolve(arg('--report') ?? join(repoRoot, 'out', 'rebased-sweep.json'));
const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;

/** rel (`/`-separated, lowercased) → product stem (`<sha12>-<base>`). */
const manifest = existsSync(MANIFEST)
  ? (readFileSync(MANIFEST, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { rel?: string; product?: string }))
  : [];
const stemByRel = new Map<string, string>();
for (const rec of manifest) {
  if (rec.rel && rec.product) {
    stemByRel.set(norm(rec.rel), rec.product.slice(0, -'.fai.zip'.length));
  }
}
function norm(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

const targets = readFileSync(onlyList, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

mkdirSync(OUT, { recursive: true });

interface Row {
  rel: string;
  stem?: string;
  converted: boolean;
  ran: boolean;
  steps: string[];
  convertError?: string;
  runError?: string;
  checkErrors?: string[];
}

const rows: Row[] = [];
let done = 0;
for (const rel of targets) {
  if (done >= limit) break;
  done++;
  const abs = join(CORPUS, rel);
  const row: Row = { rel, stem: stemByRel.get(norm(rel)), converted: false, ran: false, steps: [] };
  if (!existsSync(abs)) {
    row.convertError = 'missing file';
    rows.push(row);
    console.log(JSON.stringify({ ...row, status: 'MISSING' }));
    continue;
  }
  if (!row.stem) {
    row.convertError = 'no manifest product for rel (id will not align with truth)';
    rows.push(row);
    console.log(JSON.stringify({ ...row, status: 'NO-STEM' }));
    continue;
  }
  try {
    const summary = await convertFcstdFile(abs);
    row.converted = summary.ok;
    row.convertError = summary.error;
    if (!summary.ok || !summary.zip) {
      rows.push(row);
      console.log(JSON.stringify({ ...row, status: 'CONV-FAIL' }));
      continue;
    }
    const { loader, assets, activeModel, manifest: ctrManifest } = openContainer(summary.zip);
    const scratch = mkdtempSync(join(tmpdir(), 'rebased-'));
    for (const key of loader.listModules()) {
      const p = join(scratch, 'model', key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, await loader.readSource(key));
    }
    const assetsDir = join(scratch, 'assets');
    mkdirSync(assetsDir, { recursive: true });
    for (const [name, bytes] of Object.entries(assets)) {
      writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
    }
    const model = activeModel ?? ctrManifest.models[0];
    const entry = join(scratch, model.entry);
    row.checkErrors = cliCheck(entry).errors.map((e) => `${e.stage}: ${e.message}`);
    const productOut = join(scratch, 'product');
    mkdirSync(productOut, { recursive: true });
    try {
      const r = await cliRun(entry, join(productOut, 'out.step'), {
        mode: 'brep',
        assetsDir,
        projectRoot: scratch,
        libs: { cad: CAD_NS },
      });
      if (!r.ok) {
        row.runError = String(r.error ?? '(no error text)');
      } else {
        // Mirror run-sweep.ts's collection rule: `out.step` for a single
        // terminal, `out.step__<i>_<name>.step` for N terminals, copied out as
        // `<stem>.step` / `<stem>__<i>_<name>.step` so parity-judge's
        // `startswith(stem + '__')` grouping works unchanged.
        for (const f of readdirSync(productOut)) {
          if (f !== 'out.step' && !f.startsWith('out.step_')) continue;
          const dest =
            f === 'out.step' ? `${row.stem}.step` : `${row.stem}__${f.slice('out.step_'.length)}`;
          copyFileSync(join(productOut, f), join(OUT, dest));
          row.steps.push(dest);
        }
        row.ran = row.steps.length > 0;
        if (!row.ran) row.runError = 'cliRun ok but wrote no STEP terminal';
      }
    } catch (e) {
      row.runError = `THREW: ${String((e as Error)?.message ?? e)}`;
    }
  } catch (e) {
    row.convertError = `THREW: ${String((e as Error)?.message ?? e)}`;
  }
  rows.push(row);
  const status = row.ran ? 'RUN-OK' : row.converted ? 'RUN-FAIL' : 'CONV-FAIL';
  console.log(JSON.stringify({ rel: row.rel, stem: row.stem, status, steps: row.steps.length, runError: row.runError, convertError: row.convertError }));
}

writeFileSync(REPORT, JSON.stringify(rows, null, 2));
const ok = rows.filter((r) => r.ran);
console.log(`\n=== RUN-OK ${ok.length}/${rows.length} · steps copied to ${OUT} ===`);
console.log(`report: ${REPORT}`);
