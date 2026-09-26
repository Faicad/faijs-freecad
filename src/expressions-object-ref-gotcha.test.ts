/**
 * B1（2026-09-26）：`Object.Property` 与 `Sketch.Constraints.<名称>` 引用解析。
 *
 * 语料锚点：
 *  - `Electrical Parts/Enclosures/RND_455_00194.fcstd`：`Pad010.Length =
 *    Pad_MountingPadEdge.Length` —— 一个 Pad 直接引用另一个 Pad 自己的 Length。
 *    旧链路只认 `对象.别名`（Spreadsheet 三跳），普通对象属性必然落空 →
 *    `pad-length-expression-non-constant`（样本 10 条）。
 *  - `Architectural Parts/Bathroom/Bathroom_cabinet_sink.FCStd`：
 *    `Clone2D001` 的 `.AttachmentOffset.Base.x = -Sketch229.Constraints.Length / 2`，
 *    `Extrude_Sketch094` 的 `Dir.x = Esboco_janela_fixa_persiana.Constraints.Largura_vao
 *    - 2 * …Constraints.Perfil_montante`。草图具名约束（`<Constrain Name="Length"
 *    Value="…"/>`）不是单元格别名。
 *  - 同一个文件的 `VarSet.Base_dimensions_B_Length`：`App::VarSet` 的变量就是
 *    普通属性（`App::PropertyLength`），`spreadsheetAliasValue` 只认
 *    `Spreadsheet::Sheet`，因此 VarSet 之前完全不可达。
 *
 * 环保护：`Object.Property` 可以互相引用（`Pad_A.Length = Pad_B.Length`、
 * `Pad_B.Length = Pad_A.Length`）；必须落到 undefined，不能爆栈。
 */
import { describe, expect, it } from 'vitest';
import type { FcstdObject, FcstdProperty } from './document.js';
import { evalWithDoc } from './expressions.js';

function el(tagName: string, attrs: Record<string, string>): FcstdProperty {
  return {
    name: tagName, type: '', tagName,
    children: [], valueXml: '', valueText: '', attributes: attrs,
  };
}

function prop(name: string, childTag: string, attrs: Record<string, string>): [string, FcstdProperty] {
  return [name, {
    name, type: '', tagName: 'Property',
    children: [el(childTag, attrs)],
    valueXml: '', valueText: '', attributes: {},
  }];
}

function engine(path: string, expression: string): [string, FcstdProperty] {
  return ['ExpressionEngine', {
    name: 'ExpressionEngine', type: '', tagName: 'Property',
    children: [{
      name: 'ExpressionEngine', type: '', tagName: 'ExpressionEngine',
      valueXml: '', valueText: '', attributes: { count: '1' },
      children: [el('Expression', { path, expression })],
    }],
    valueXml: '', valueText: '', attributes: {},
  }];
}

function obj(
  name: string,
  type: string,
  props: [string, FcstdProperty][],
  label?: string,
): FcstdObject {
  const o: FcstdObject = { name, type, properties: new Map(props) };
  if (label !== undefined) o.properties.set('Label', prop('Label', 'String', { value: label })[1]);
  return o;
}

function sketch(name: string, constraints: Record<string, number>): FcstdObject {
  const list: FcstdProperty = {
    name: 'Constraints', type: '', tagName: 'Property',
    children: [{
      name: 'ConstraintList', type: '', tagName: 'ConstraintList',
      valueXml: '', valueText: '', attributes: { count: String(Object.keys(constraints).length) },
      children: Object.entries(constraints).map(([n, v]) => el('Constrain', { Name: n, Value: String(v) })),
    }],
    valueXml: '', valueText: '', attributes: {},
  };
  const o: FcstdObject = { name, type: 'Sketcher::SketchObject', properties: new Map([['Constraints', list]]) };
  o.properties.set('Label', prop('Label', 'String', { value: name })[1]);
  return o;
}

describe('B1: Object.Property references (GOTCHA 2026-09-26)', () => {
  const padEdge = obj('Pad_MountingPadEdge', 'PartDesign::Pad', [prop('Length', 'Float', { value: '12.5' })]);
  const varSet = obj('VarSet', 'App::VarSet', [
    prop('Base_dimensions_B_Length', 'Float', { value: '800' }),
    prop('Drawers_A_Side_drawer_set', 'Bool', { value: 'false' }),
  ]);
  const sk = sketch('Sketch229', { Length: 400, Width: 60 });
  const DOC = [padEdge, varSet, sk];

  it('resolves a plain feature property reference (Pad.Length = PadEdge.Length)', () => {
    expect(evalWithDoc('Pad_MountingPadEdge.Length', DOC)).toBeCloseTo(12.5, 9);
    expect(evalWithDoc('Pad_MountingPadEdge.Length / 2', DOC)).toBeCloseTo(6.25, 9);
  });

  it('GOTCHA: resolves App::VarSet variables (they are plain properties, not spreadsheet cells)', () => {
    expect(evalWithDoc('VarSet.Base_dimensions_B_Length', DOC)).toBeCloseTo(800, 9);
    // a non-numeric property must stay unresolved rather than coerce to NaN/0
    expect(evalWithDoc('VarSet.Drawers_A_Side_drawer_set', DOC)).toBeUndefined();
  });

  it('GOTCHA: resolves Sketch.Constraints.<name> (three-part reference)', () => {
    expect(evalWithDoc('-Sketch229.Constraints.Length / 2', DOC)).toBeCloseTo(-200, 9);
    expect(evalWithDoc('Sketch229.Constraints.Largura_vao', DOC)).toBeUndefined();
  });

  it('follows a bound property on the referenced object (FreeCAD recomputes on load)', () => {
    const bound = obj('Pad_Bound', 'PartDesign::Pad', [
      prop('Length', 'Float', { value: '0' }),
      engine('Length', '3 mm + 1 mm'),
    ]);
    expect(evalWithDoc('Pad_Bound.Length', [bound])).toBeCloseTo(4, 9);
  });

  it('GOTCHA: a reference cycle resolves to undefined instead of overflowing the stack', () => {
    const a = obj('Pad_A', 'PartDesign::Pad', [prop('Length', 'Float', { value: '0' }), engine('Length', 'Pad_B.Length')]);
    const b = obj('Pad_B', 'PartDesign::Pad', [prop('Length', 'Float', { value: '0' }), engine('Length', 'Pad_A.Length')]);
    expect(evalWithDoc('Pad_A.Length', [a, b])).toBeUndefined();
  });
});
