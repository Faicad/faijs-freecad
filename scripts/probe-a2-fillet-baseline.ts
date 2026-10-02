/**
 * A2 归因探针 — 判定 fillet 执行失败是否由 A2（参数边保持解析）引入。
 *
 * 做法：把同一份转换产物物化到草稿目录，跑两次：
 *   A 版 = 产物原样（A2：参数边 → `spline` 段）；
 *   B 版 = 把 main 模块里 `cad.sketchOnPlane` 的每个 `spline` 段按 de Boor
 *         采样替换成连续 `line` 段（A1：逐边离散）。
 * 两版只有「Draft 参数边的发射形态」不同，其余（导入资产、草图、布尔、fillet
 * 选边号）逐字节相同。因此：
 *   - 两版都失败 → fillet 失败与 A2 无关（既有缺口）；
 *   - 仅 A 版失败 → A2 回归（重建立体拓扑改变导致选边号/角色血统失效）。
 *
 * 只读：不写仓库内文件，草稿目录落在 `os.tmpdir()`（safe-delete shim 对临时
 * 目录整体豁免）。
 *
 * Usage: npx tsx packages/faijs-freecad/scripts/probe-a2-fillet-baseline.ts <file.FCStd>
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '@faicad/faijs-draw';
import { convertFcstdFile } from '../src/convert.js';
import { openContainer } from '@faicad/faijs/io/fai-zip';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

/** de Boor evaluation of a clamped/rational NURBS at parameter u (no weights here). */
function deBoor(poles: number[], knots: number[], mults: number[], degree: number, u: number): [number, number] {
  // expand knots by multiplicity
  const U: number[] = [];
  for (let i = 0; i < knots.length; i++) for (let m = 0; m < (mults[i] ?? 1); m++) U.push(knots[i]!);
  const p = degree;
  const n = U.length - p - 2; // last pole index
  let k = n;
  for (let i = p; i <= n; i++) if (u >= U[i]! && u < U[i + 1]!) { k = i; break; }
  const d: [number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const idx = j + k - p;
    if (2 * idx + 1 >= poles.length) return [NaN, NaN];
    d.push([poles[2 * idx]!, poles[2 * idx + 1]!]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = j + k - p;
      const den = (U[i + p - r + 1] ?? 0) - (U[i] ?? 0);
      const a = den === 0 ? 0 : (u - (U[i] ?? 0)) / den;
      d[j] = [(1 - a) * d[j - 1]![0] + a * d[j]![0], (1 - a) * d[j - 1]![1] + a * d[j]![1]];
    }
  }
  return d[p]!;
}

/**
 * Replace every `spline` segment inside `cad.sketchOnPlane({ contours: … })` with
 * consecutive `line` segments sampled from the same control data (the A1 shape).
 *
 * @param src - the emitted module source.
 * @returns [rewritten source, replaced segment count].
 */
function discretizeSplines(src: string): [string, number] {
  const marker = '{ contours: ';
  let out = '';
  let rest = src;
  let replaced = 0;
  for (;;) {
    const at = rest.indexOf(marker);
    if (at < 0) { out += rest; break; }
    const start = at + marker.length;
    out += rest.slice(0, start);
    // scan the balanced JSON array
    let depth = 0;
    let i = start;
    for (; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { i++; break; } }
    }
    const raw = rest.slice(start, i);
    const contours = JSON.parse(raw) as {
      segments: Record<string, unknown>[];
    }[];
    for (const c of contours) {
      const segs: Record<string, unknown>[] = [];
      for (const s of c.segments) {
        if (s.kind !== 'spline') { segs.push(s); continue; }
        const polesFlat = s.poles as number[];
        const knots = s.knots as number[];
        const mults = s.multiplicities as number[];
        const degree = s.degree as number;
        const lo = knots[0]!;
        const hi = knots[knots.length - 1]!;
        const perSpan = 6;
        const spans = Math.max(1, knots.length - 1);
        const count = Math.max(polesFlat.length / 2, spans * perSpan + 1);
        const pts: [number, number][] = [];
        for (let k = 0; k < count; k++) {
          const u = lo + ((hi - lo) * k) / (count - 1);
          pts.push(deBoor(polesFlat, knots, mults, degree, u));
        }
        for (let k = 1; k < pts.length; k++) {
          segs.push({ kind: 'line', x1: pts[k - 1]![0], y1: pts[k - 1]![1], x2: pts[k]![0], y2: pts[k]![1] });
        }
        replaced++;
      }
      c.segments = segs;
    }
    out += JSON.stringify(contours);
    rest = rest.slice(i);
  }
  return [out, replaced];
}

/** Materialise the container into a scratch root and return module list + paths. */
function materialize(zip: Uint8Array) {
  const { manifest, loader, assets } = openContainer(zip);
  const scratch = mkdtempSync(join(tmpdir(), 'a2-attr-'));
  const assetsDir = join(scratch, 'assets');
  for (const [name, bytes] of Object.entries(assets)) {
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, `${name}.brp`), Buffer.from(bytes));
  }
  const pending = new Map<string, string>();
  for (const mk of loader.listModules()) pending.set(mk, '');
  return { manifest, loader, assetsDir, scratch, pending };
}

const file = process.argv[2]!;
const summary = await convertFcstdFile(file);
if (!summary.zip) { console.log('conversion failed'); process.exit(1); }

for (const variant of ['A2', 'A1'] as const) {
  const { manifest, loader, assetsDir, scratch } = materialize(summary.zip);
  for (const mk of loader.listModules()) {
    let src = await loader.readSource(mk);
    if (variant === 'A1') {
      const [rewritten, n] = discretizeSplines(src);
      console.log(`  [${variant}] ${mk}: discretized ${n} spline segment(s)`);
      src = rewritten;
    }
    const q = join(scratch, 'model', mk);
    mkdirSync(join(q, '..'), { recursive: true });
    writeFileSync(q, src);
  }
  const results: string[] = [];
  for (const m of manifest.models) {
    const outStep = join(scratch, `out-${m.id}.step`);
    const r = await cliRun(join(scratch, m.entry), outStep, {
      mode: 'brep', assetsDir, projectRoot: scratch, libs: { cad: CAD_NS },
    });
    if (!r.ok) {
      results.push(`${m.id}: FAIL ${String((r as { error?: unknown }).error ?? '')}`);
    } else {
      const stepBytes = readdirSync(scratch)
        .filter((f) => f.endsWith('.step'))
        .reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
      results.push(`${m.id}: ok (step bytes ${stepBytes})`);
    }
  }
  console.log(`[${variant}]`);
  for (const r of results) console.log(`  ${r}`);
}
