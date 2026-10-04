// 约束拓扑闭合判别器单测（K 组 2026-10-04）。
// 背景 GOTCHA（Kitchen_cabinet vs Maxim Air）：转换期 loopCount=0 不能区分
// 「运行期重解后 coincident 吸合成环」（Kitchen 型，必须照常参数化发射）与
// 「真开口轮廓」（Maxim 型，运行期必抛 E_SKETCHC_NO_CONTOUR）。唯一可靠判别器
// 是约束拓扑环检测——本测试把两型的判别行为锁死，防回归。
import { describe, it, expect } from 'vitest';
import { hasConstraintClosedLoop } from './sketch-loop-topology.js';
import type { SketchGeom, SketchConstraint } from '@faicad/faijs-sketch';

/** Maxim Air Sketch188 的形态：两条轮廓线组成开口 V，无 coincident 闭合约束。 */
function openV(): { geoms: SketchGeom[]; constraints: SketchConstraint[] } {
  return {
    geoms: [
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 20 },
      { kind: 'line', x1: 10, y1: 20, x2: 20, y2: 0 },
    ],
    constraints: [],
  };
}

/** Kitchen 型：三条线经 coincident 首尾相接成闭合三角环（转换期数值未吸合也行）。 */
function coincidentTriangle(): { geoms: SketchGeom[]; constraints: SketchConstraint[] } {
  return {
    geoms: [
      { kind: 'line', x1: 0, y1: 0, x2: 40, y2: 0, tag: 'g0' },
      { kind: 'line', x1: 41, y1: 0, x2: 20, y2: 35, tag: 'g1' }, // 数值上断开，靠约束吸合
      { kind: 'line', x1: 19, y1: 34, x2: 0, y2: 0, tag: 'g2' },
    ],
    constraints: [
      { kind: 'coincident', a: { tag: 'g0', at: 'end' }, b: { tag: 'g1', at: 'start' } },
      { kind: 'coincident', a: { tag: 'g1', at: 'end' }, b: { tag: 'g2', at: 'start' } },
      { kind: 'coincident', a: { tag: 'g2', at: 'end' }, b: { tag: 'g0', at: 'start' } },
    ],
  };
}

describe('hasConstraintClosedLoop (K 组发射门禁判别器)', () => {
  it('GOTCHA Kitchen 型：coincident 链闭合 → true（照常参数化发射，不得 bake）', () => {
    const { geoms, constraints } = coincidentTriangle();
    expect(hasConstraintClosedLoop(geoms, constraints)).toBe(true);
  });

  it('GOTCHA Maxim 型：真开口 V（无闭合约束）→ false（运行期必抛 NO_CONTOUR，应 bake）', () => {
    const { geoms, constraints } = openV();
    expect(hasConstraintClosedLoop(geoms, constraints)).toBe(false);
  });

  it('数值重合（≤1e-7）也建立端点同一性——与运行期 JOIN_TOL 链接一致', () => {
    // 正方形四边坐标精确首尾相接，零约束
    const geoms: SketchGeom[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
      { kind: 'line', x1: 10, y1: 10, x2: 0, y2: 10 },
      { kind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
    ];
    expect(hasConstraintClosedLoop(geoms, [])).toBe(true);
  });

  it('非构造 circle 自闭合 → true（extractContours 的圆语义）', () => {
    const geoms: SketchGeom[] = [{ kind: 'circle', cx: 0, cy: 0, r: 5 }];
    expect(hasConstraintClosedLoop(geoms, [])).toBe(true);
  });

  it('construction circle 不算轮廓（extractContours 同判）', () => {
    const geoms: SketchGeom[] = [{ kind: 'circle', cx: 0, cy: 0, r: 5, construction: true }];
    expect(hasConstraintClosedLoop(geoms, [])).toBe(false);
  });

  it('GOTCHA：经构造线介导的 coincident 链不算闭合——构造段不在运行期轮廓池里', () => {
    // 两条轮廓线各有一端连到同一条构造线的两端：构造介导的"闭合"是假象
    const geoms: SketchGeom[] = [
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0, tag: 'p0' },
      { kind: 'line', x1: 0, y1: 5, x2: 10, y2: 5, tag: 'p1' },
      { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 5, tag: 'c0', construction: true },
    ];
    const constraints: SketchConstraint[] = [
      { kind: 'coincident', a: { tag: 'p0', at: 'start' }, b: { tag: 'c0', at: 'start' } },
      { kind: 'coincident', a: { tag: 'p1', at: 'start' }, b: { tag: 'c0', at: 'end' } },
    ];
    expect(hasConstraintClosedLoop(geoms, constraints)).toBe(false);
  });

  it('开口链 + 构造圆：轮廓仍开口 → false', () => {
    const { geoms, constraints } = openV();
    geoms.push({ kind: 'circle', cx: 5, cy: 5, r: 2, construction: true });
    expect(hasConstraintClosedLoop(geoms, constraints)).toBe(false);
  });

  it('真开口 + 一个独立闭合 circle → true（circle 本身就是环，草图可出轮廓）', () => {
    const { geoms, constraints } = openV();
    geoms.push({ kind: 'circle', cx: 5, cy: 5, r: 2 });
    expect(hasConstraintClosedLoop(geoms, constraints)).toBe(true);
  });

  it('bspline 经极值点数值重合闭合 → true（镜像 segEnds 的首末极值点链接）', () => {
    const geoms: SketchGeom[] = [
      {
        kind: 'bspline',
        poles: [{ x: 0, y: 0 }, { x: 5, y: 10 }],
        knots: [0, 0, 1, 1],
        degree: 1,
      },
      { kind: 'line', x1: 5, y1: 10, x2: 0, y2: 0 },
    ];
    expect(hasConstraintClosedLoop(geoms, [])).toBe(true);
  });
});
