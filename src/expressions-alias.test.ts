/**
 * P1-1 参数载体（2026-09-23）：Spreadsheet 别名三跳解析 + 引用算术。
 *
 * 语料锚点：Sprocket ANSI simplex ½x¼ z08.FCStd（B2 §3.9 代表样本）——
 * `Pad.Length` 绑定 `<<Data>>.Wt`，Data 是 Spreadsheet::Sheet，单元格
 * `<Cell address="F2" content="=5.9mm" alias="Wt"/>`。旧链路 evalConstantExpression
 * 不认引用 → Pad bake（pad-length-expression-non-constant）→ Pocket 级联
 * （pocket-missing-dependency）——三条 reason 是同一件事的三个面。
 *
 * GOTCHA：`<<Label>>` 按 **Label**（不是对象 name）找数据源；单元格 content 的
 * 前导 `=` 要去掉；同表地址（`=B2*2` 的 `B2`）按 address 再跳一次。
 */

import { describe, expect, it } from 'vitest';
import type { FcstdObject, FcstdProperty } from './document.js';
import { evalWithDoc, spreadsheetAliasValue } from './expressions.js';
import { expressionBindingOf, hasNonConstantBinding, translateObject } from './feature-translate.js';

function prop(name: string, attrs: Record<string, string>): [string, FcstdProperty] {
  return [name, {
    name, type: '', tagName: 'Property',
    children: [{ name, type: '', tagName: 'Element', children: [], valueXml: '', valueText: '', attributes: attrs }],
    valueXml: '', valueText: '', attributes: {},
  }];
}

function sheet(label: string): FcstdObject {
  const cells = {
    name: 'cells', type: 'Spreadsheet::PropertySheet', tagName: 'Property',
    children: [{
      name: 'cells', type: '', tagName: 'cells', valueXml: '', valueText: '', attributes: {},
      children: [
        { name: 'Cell', type: '', tagName: 'Cell', children: [], valueXml: '', valueText: '', attributes: { address: 'F2', content: '=5.9mm', alias: 'Wt' } },
        { name: 'Cell', type: '', tagName: 'Cell', children: [], valueXml: '', valueText: '', attributes: { address: 'B2', content: '=6.4mm', alias: 'Wc' } },
        { name: 'Cell', type: '', tagName: 'Cell', children: [], valueXml: '', valueText: '', attributes: { address: 'C2', content: '=B2*2', alias: 'Double' } },
      ],
    }],
    valueXml: '', valueText: '', attributes: {},
  } as never as FcstdProperty;
  const o: FcstdObject = { name: 'Spreadsheet', type: 'Spreadsheet::Sheet', properties: new Map([['cells', cells]]) };
  o.properties.set('Label', prop('Label', { value: label })[1]);
  return o;
}

const DOC = [sheet('Data')];

describe('P1-1: Spreadsheet alias three-hop resolution', () => {
  it('GOTCHA: resolves <<Label>>.Alias through the cell content (leading = stripped)', () => {
    // 三跳：<<Data>> → Label="Data" 的表 → alias="Wt" → "=5.9mm" → 5.9
    expect(spreadsheetAliasValue(DOC, 'Data', 'Wt')).toBeCloseTo(5.9, 9);
    // 带文档上下文的引用算术（657 条语料头部形态）
    expect(evalWithDoc('<<Data>>.Wt + <<Data>>.Wc', DOC)).toBeCloseTo(12.3, 9);
    // 同表地址：C2 = B2*2 = 12.8
    expect(spreadsheetAliasValue(DOC, 'Data', 'Double')).toBeCloseTo(12.8, 9);
  });

  it('GOTCHA: unresolvable reference stays undefined (no heuristic fallback)', () => {
    expect(spreadsheetAliasValue(DOC, 'NoTable', 'Wt')).toBeUndefined();
    expect(evalWithDoc('<<Data>>.Missing', DOC)).toBeUndefined();
    // 函数族不猜
    expect(evalWithDoc('tuple(1, 2)', DOC)).toBeUndefined();
  });

  it('Pad.Length bound to <<Data>>.Wt is no longer non-constant (Sprocket chain root fix)', () => {
    const pad: FcstdObject = {
      name: 'Pad', type: 'PartDesign::Pad',
      properties: new Map([
        prop('Length', { value: '0' }) as [string, FcstdProperty],
        // GOTCHA（Map 形态，2026-09-23）：Map 条目必须是 [key, value] 元组——
        // 裸属性对象会被 Map 当成 key=对象/undefined，ExpressionEngine 静默丢失。
        ['ExpressionEngine', {
          name: 'ExpressionEngine', type: '', tagName: 'Property',
          children: [{
            name: 'ExpressionEngine', type: '', tagName: 'ExpressionEngine', valueXml: '', valueText: '',
            attributes: { count: '1' },
            children: [
              { name: 'Expression', type: '', tagName: 'Expression', children: [], valueXml: '', valueText: '', attributes: { path: 'Length', expression: '<<Data>>.Wt' } },
            ],
          }],
          valueXml: '', valueText: '', attributes: {},
        } as FcstdProperty] as [string, FcstdProperty],
      ]),
    };
    // translateObject 注入 docContext（这里直接经 translateObject 走一遍真实入口）
    translateObject(pad, () => undefined, DOC);
    const b = expressionBindingOf(pad, 'Length');
    expect(b?.value).toBeCloseTo(5.9, 9);
    expect(hasNonConstantBinding(pad, 'Length')).toBe(false);
  });

  it('Spreadsheet::Sheet is a structural (preserved-only) type, not a gap', () => {
    // 动态 import 避免与上面的 docContext 注入互相干扰（顺序无关，仅防提升）
    return import('./structural-types.js').then(({ isNonModelingType }) => {
      expect(isNonModelingType('Spreadsheet::Sheet')).toBe(true);
      expect(isNonModelingType('App::VarSet')).toBe(true);
    });
  });

  it('P1-3: non-geometric types are preserved-only, not type-not-whitelisted gaps', () => {
    return import('./structural-types.js').then(({ isNonModelingType }) => {
      // batch-report census (2026-09-23): these blocked 40+ convert-buckets.
      expect(isNonModelingType('App::LinkGroup')).toBe(true);
      expect(isNonModelingType('App::MeasureDistance')).toBe(true);
      expect(isNonModelingType('Image::ImagePlane')).toBe(true);
      expect(isNonModelingType('Mesh::Feature')).toBe(true);
      // namespace rules: 81 TechDraw::* + 20 Drawing::* objects
      expect(isNonModelingType('TechDraw::DrawViewSection')).toBe(true);
      expect(isNonModelingType('Drawing::DrawViewPart')).toBe(true);
      // modeling types must NOT be swallowed
      expect(isNonModelingType('Part::Mirroring')).toBe(false);
      expect(isNonModelingType('PartDesign::Groove')).toBe(false);
    });
  });
});
