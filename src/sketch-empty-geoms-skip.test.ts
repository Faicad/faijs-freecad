// GOTCHA 留档（2026-10-03, endstop-v1-2-makerbot）：真空草图不是翻译缺口。
//
// 错误认知（旧行为）：`GeometryList count="0"` 的空 sketch 被记为
// `sketch-empty-geoms` gap，整个产品转不出容器（ok=false, exit 2）。
// 空草图对几何零贡献——它不该把 28 个语料文件拉成 stage1 gap。
//
// 正确行为：auditMapping 把该 reason 归为 `skipped-empty` disposition
// （ALLOWED_DISPOSITIONS 白名单成员），counts 桶 `skippedEmpty` 承接计数；
// 消费空草图的 Pad/Pocket 会各自按 missing-dependency 记账，不在此处替它们保红。
//
// 防回归锚分两层：`sketch-empty-geoms` 的再分类只发生在 auditMapping 里，而它
// 不是导出函数——只有 convertFcstdFile 整条流水线能碰到它。所以主锚点必须造一个
// 真的 .fcstd（合成 Document.xml，零几何草图）跑完整条链路，不能只测 codegen 半边。
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeZipEntries } from '@faicad/faijs/io';
import { convertFcstdFile, ALLOWED_DISPOSITIONS } from './convert.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), 'faijs-freecad-empty-sketch-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A minimal but REAL .fcstd: one `Sketcher::SketchObject` whose
 * `GeometryList count="0"` / `ConstraintList count="0"` — the exact shape
 * `endstop-v1-2-makerbot` Document.xml carries. No consumer feature, so the
 * product must come out gap-free once the sketch is reclassified.
 */
const EMPTY_SKETCH_FCSTD = join(tmpRoot, 'empty-sketch.fcstd');

writeFileSync(EMPTY_SKETCH_FCSTD, writeZipEntries({
  'Document.xml': new TextEncoder().encode(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<Document SchemaVersion="4" ProgramVersion="1.0">\n'
    + '  <Properties Count="0"/>\n'
    + '  <Objects Count="1">\n'
    + '    <Object type="Sketcher::SketchObject" name="Sketch" id="1"/>\n'
    + '  </Objects>\n'
    + '  <ObjectData Count="1">\n'
    + '    <Object name="Sketch" id="1">\n'
    + '      <Properties Count="2">\n'
    + '        <Property name="Geometry" type="Part::PropertyGeometryList">\n'
    + '          <GeometryList count="0"/>\n'
    + '        </Property>\n'
    + '        <Property name="Constraints" type="Sketcher::PropertyConstraintList">\n'
    + '          <ConstraintList count="0"/>\n'
    + '        </Property>\n'
    + '      </Properties>\n'
    + '    </Object>\n'
    + '  </ObjectData>\n'
    + '</Document>\n',
  ),
}));

// Real-document anchor. The FreeCAD-library corpus is an external checkout —
// sibling of this repo by default, or wherever FAIJS_CORPUS points (it used to be
// a hardcoded D:/Faicad path, unreachable for anyone but that machine). CI has no
// corpus, so this case skips there; the synthetic anchor above always runs.
const CORPUS = process.env.FAIJS_CORPUS ?? join(here, '..', '..', 'FreeCAD-library');
const SAMPLE = join(CORPUS, 'Electrical Parts', 'Endstop', 'endstop-v1-2-makerbot.fcstd');

describe('K 组: sketch-empty-geoms is a skip, not a gap', () => {
  it('GOTCHA: a真空 sketch (GeometryList count=0) no longer fails the product — disposition skipped-empty, counts.skippedEmpty=1', async () => {
    const summary = await convertFcstdFile(EMPTY_SKETCH_FCSTD);
    // 旧实现在此 ok=false 且 gaps 含 sketch-empty-geoms —— 防回归锚点
    expect(summary.error).toBeUndefined();
    expect(summary.ok).toBe(true);
    expect(summary.gaps.map((g) => g.reason)).not.toContain('sketch-empty-geoms');
    expect((summary.counts as Record<string, number>).skippedEmpty).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it.skipIf(!existsSync(SAMPLE))('same verdict on the corpus document that started it (endstop-v1-2-makerbot)', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    expect(summary.ok).toBe(true);
    expect(summary.gaps.map((g) => g.reason)).not.toContain('sketch-empty-geoms');
    expect((summary.counts as Record<string, number>).skippedEmpty).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('skipped-empty is a whitelisted disposition (CLI contract tripwire)', () => {
    expect(ALLOWED_DISPOSITIONS.has('skipped-empty')).toBe(true);
  });
});