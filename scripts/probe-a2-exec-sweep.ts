/**
 * A2 执行扫描 — 找出「含参数边（bezier/bspline）且真能跑通」的文档。
 *
 * 输入是 `scripts/audit-draft-kinds.ts` 的全库盘点产物 `out/draft-kinds-audit.json`
 * （所以文档清单来自实测盘点，不是手抄）：取其中参数边计数 > 0 的文档，逐个
 * `convertFcstdFile` → 物化产物 → `cliRun` 每个模型，记录「转换 gap / 执行错误」。
 *
 * 为什么需要它：A2 的执行腿（产物必须真跑出 STEP）不能挂在任意文档上——语料里
 * 部分文档的 fillet 选边依赖原 FreeCAD 拓扑序号/角色血统（既有缺口，见
 * `scripts/probe-a2-fillet-baseline.ts` 的 A1-vs-A2 归因），那些文档跑不通与 A2
 * 无关。本扫描给出「哪些文档能作为 A2 执行腿靶子」的实测依据。
 *
 * 串行、只读仓库（草稿目录落 `os.tmpdir()`）。
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-a2-exec-sweep.ts [limit]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { convertFcstdFile } from '../src/convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeSketchNamespace(createApiNamespace());

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const CORPUS = join(repoRoot, '..', 'FreeCAD-library');
const AUDIT = join(repoRoot, 'out', 'draft-kinds-audit.json');
const REPORT = join(repoRoot, 'out', 'a2-exec-sweep.json');

const limit = process.argv[2] ? Number(process.argv[2]) : Infinity;

const audit = JSON.parse(readFileSync(AUDIT, 'utf8')) as {
  records: { doc: string; kinds?: Record<string, number> }[];
};
const param = new Map<string, number>();
for (const r of audit.records) {
  const n = (r.kinds?.bezier ?? 0) + (r.kinds?.bspline ?? 0) + (r.kinds?.ellipse ?? 0);
  if (n > 0) param.set(r.doc, (param.get(r.doc) ?? 0) + n);
}
const docs = [...param.entries()].sort((a, b) => b[1] - a[1]);
console.log(`param-edge documents: ${docs.length}`);

/** Result of one document's convert + execute. */
interface Row {
  doc: string;
  paramEdges: number;
  converted: boolean;
  gaps: unknown;
  convertError?: string;
  ran?: boolean;
  error?: string;
}

const rows: Row[] = [];
let done = 0;
for (const [doc, paramEdges] of docs) {
  if (done >= limit) break;
  done++;
  const abs = join(CORPUS, doc);
  const row: Row = { doc, paramEdges, converted: false, gaps: undefined };
  if (!existsSync(abs)) {
    row.convertError = 'missing file';
    rows.push(row);
    console.log(`[${done}] ${doc} — MISSING`);
    continue;
  }
  try {
    const summary = await convertFcstdFile(abs);
    row.converted = summary.ok;
    row.gaps = summary.gaps;
    row.convertError = summary.error;
    if (summary.ok && summary.zip) {
      const { manifest, loader, assets } = openContainer(summary.zip);
      const scratch = mkdtempSync(join(tmpdir(), 'a2-sweep-'));
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
      row.ran = true;
      for (const m of manifest.models) {
        const out = join(scratch, `out-${m.id}.step`);
        const r = await cliRun(join(scratch, m.entry), out, {
          mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS },
        });
        if (!r.ok) {
          row.ran = false;
          row.error = `${m.id}: ${String((r as { error?: unknown }).error ?? '')}`;
          break;
        }
        const stepBytes = readdirSync(scratch)
          .filter((f) => f.endsWith('.step'))
          .reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
        if (stepBytes === 0) {
          row.ran = false;
          row.error = `${m.id} wrote no STEP`;
          break;
        }
      }
    }
  } catch (e) {
    row.convertError = `threw: ${String(e)}`;
  }
  rows.push(row);
  const status = row.ran === true ? 'RUN-OK' : row.converted ? 'RUN-FAIL' : 'CONV-FAIL';
  console.log(`[${done}/${docs.length}] ${status} param=${paramEdges} ${doc}`);
  if (row.error) console.log(`        ${row.error}`);
  if (row.convertError) console.log(`        convert: ${row.convertError}`);
}

writeFileSync(REPORT, JSON.stringify(rows, null, 2));
const ok = rows.filter((r) => r.ran === true);
console.log(`\n=== RUN-OK: ${ok.length}/${rows.length} ===`);
for (const r of ok) console.log(`  param=${r.paramEdges} ${r.doc}`);
console.log(`report: ${REPORT}`);
