// GOTCHA 留档（2026-10-03, endstop-v1-2-makerbot）：真空草图不是翻译缺口。
//
// 错误认知（旧行为）：`GeometryList count="0"` 的空 sketch 被记为
// `sketch-empty-geoms` gap，整个产品转不出容器（ok=false, exit 2）。
// 空草图对几何零贡献——它不该把 28 个语料文件拉成 stage1 gap。
//
// 正确行为：auditMapping 把该 reason 归为 `skipped-empty` disposition
// （ALLOWED_DISPOSITIONS 白名单成员），counts 桶 `skippedEmpty` 承接计数；
// 消费空草图的 Pad/Pocket 会各自按 missing-dependency 记账，不在此处替它们保红。
import { describe, it, expect } from 'vitest';
import { convertFcstdFile, ALLOWED_DISPOSITIONS } from './convert.js';

const SAMPLE = 'D:/Faicad/FreeCAD-library/Electrical Parts/Endstop/endstop-v1-2-makerbot.fcstd';

describe('K 组: sketch-empty-geoms is a skip, not a gap', () => {
  it('GOTCHA: a真空 sketch (GeometryList count=0) no longer fails the product — disposition skipped-empty, counts.skippedEmpty=1', async () => {
    const summary = await convertFcstdFile(SAMPLE);
    // 旧实现在此 ok=false 且 gaps 含 sketch-empty-geoms —— 防回归锚点
    expect(summary.ok).toBe(true);
    expect(summary.gaps.map((g) => g.reason)).not.toContain('sketch-empty-geoms');
    expect((summary.counts as Record<string, number>).skippedEmpty).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('skipped-empty is a whitelisted disposition (CLI contract tripwire)', () => {
    expect(ALLOWED_DISPOSITIONS.has('skipped-empty')).toBe(true);
  });
});
