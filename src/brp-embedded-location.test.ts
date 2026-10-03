// GOTCHA 留档（2026-10-03, FCBL_chair_upholstered）：brpEmbeddedLocation 的旋转盲区。
//
// 错误用法（旧行为）：只返回平移、把零平移当恒等 —— 纯旋转内嵌（90°X，tx=ty=tz=0）
// 被报成 null → prePlacedAssets skip 不命中 → child 资产被 cad.place 二次施放 →
// 挤出方向躺在轮廓面内 → 退化零体积薄片 → 下游 kernel fuse 全链失败。
//
// 正确用法：返回完整 3×4 变换（旋转行 + 平移列）；恒等（旋转 AND 平移都恒等）才返回 null。
// 调用方（convert.ts prePlacedAssets）必须比较「旋转 + 平移全等」。
import { describe, it, expect } from 'vitest';
import { brpEmbeddedLocation } from './unpack.js';

/** Build a minimal .brp header with the given first-location rows. */
function brpHeader(rows: string[]): Uint8Array {
  const text = [
    'CASCADE Topology V1, (c) Matra-Datavision',
    'Locations 1',
    '1',
    ...rows,
    'Curve2ds 0',
  ].join('\n');
  return new TextEncoder().encode(text);
}

describe('brpEmbeddedLocation: full transform (rotation + translation)', () => {
  it('GOTCHA: pure-rotation embed (90°X, zero translation) must NOT read as null — the old translation-only read caused a double-place (FCBL)', () => {
    // 90°X rotation: row0 (1,0,0,0), row1 (0,0,-1,0), row2 (0,1,0,0)
    const data = brpHeader([
      '1.000000000000000 0.000000000000000 0.000000000000000 0.000000000000000 ',
      '0.000000000000000 0.000000000000000 -1.000000000000000 0.000000000000000 ',
      '0.000000000000000 1.000000000000000 0.000000000000000 0.000000000000000 ',
    ]);
    const emb = brpEmbeddedLocation(data);
    // 旧实现在此返回 null（零平移 ⇒ "identity"）——这是 double-apply 的根因
    expect(emb).not.toBeNull();
    // 旋转行原样返回（跳过-place 判定需要与 Placement 的 quatToMatrix 全等比较）
    expect(emb![0]).toEqual([1, 0, 0, 0]);
    expect(emb![1]!.slice(0, 3)).toEqual([0, 0, -1]);
    expect(emb![2]!.slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('identity block (no rotation, zero translation) still returns null → normal place path', () => {
    const data = brpHeader([
      '1 0 0 0 ',
      '0 1 0 0 ',
      '0 0 1 0 ',
    ]);
    expect(brpEmbeddedLocation(data)).toBeNull();
  });

  it('translation-only embed keeps returning the translation (Beds Section case unchanged)', () => {
    const data = brpHeader([
      '1 0 0 0 ',
      '0 1 0 0 ',
      '0 0 1 1500 ',
    ]);
    const emb = brpEmbeddedLocation(data);
    expect(emb).not.toBeNull();
    expect(emb![0]![3]).toBe(0);
    expect(emb![2]![3]).toBe(1500);
  });

  it('absent Locations section returns null', () => {
    const data = new TextEncoder().encode('CASCADE Topology V1\nCurve2ds 0\n');
    expect(brpEmbeddedLocation(data)).toBeNull();
  });
});
