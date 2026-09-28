/**
 * C1/C2/C3/C4 (2026-09-28 plan) — the emitted `.fai.js` end of the parameter
 * work: the `const p_*` header, the inline parameter expression in the op
 * argument, and the parameter reference inside a `cad.sketch` constraint.
 *
 * Runs the real wiring (`collectLeafParams` → `setParamContext` →
 * `generateModel`), not a mock, so a regression in any of the three hops shows
 * up here. The negative case below is the important one: a binding that cannot
 * be resolved must keep the explicit bake instead of silently emitting the
 * stored `<Float>` (that was a real bug in the first cut of `propScalar`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FcstdDocument, FcstdObject, FcstdProperty } from './document.js';
import { collectLeafParams } from './params.js';
import { setParamContext, jsExpr } from './feature-translate.js';
import { generateModel } from './codegen.js';

function el(tagName: string, attrs: Record<string, string>): FcstdProperty {
  return { name: tagName, type: '', tagName, children: [], valueXml: '', valueText: '', attributes: attrs };
}

/** A `<Property>` wrapping one element, as FreeCAD serializes it. */
function prop(name: string, inner: FcstdProperty): [string, FcstdProperty] {
  return [name, {
    name, type: '', tagName: 'Property', children: [inner], valueXml: '', valueText: '', attributes: {},
  }];
}

/** A `<Property>` whose single child is `<Link value=…/>`. */
function linkProp(name: string, target: string): [string, FcstdProperty] {
  return prop(name, el('Link', { value: target }));
}

/** A `<Property>` whose single child is `<Float value=…/>`. */
function floatProp(name: string, value: string): [string, FcstdProperty] {
  return prop(name, el('Float', { value }));
}

/** An `<ExpressionEngine>` binding one property to an expression. */
function engineProp(path: string, expression: string): [string, FcstdProperty] {
  return prop('ExpressionEngine', {
    name: 'ExpressionEngine', type: '', tagName: 'ExpressionEngine',
    valueXml: '', valueText: '', attributes: { count: '1' },
    children: [el('Expression', { path, expression })],
  });
}

function sheet(name: string, cells: { address: string; content: string; alias: string }[]): FcstdObject {
  const cellsProp: FcstdProperty = {
    name: 'cells', type: 'Spreadsheet::PropertySheet', tagName: 'Property',
    children: [{
      name: 'cells', type: '', tagName: 'cells', valueXml: '', valueText: '', attributes: {},
      children: cells.map((c) => el('Cell', { address: c.address, content: c.content, alias: c.alias })),
    }],
    valueXml: '', valueText: '', attributes: {},
  };
  return {
    name, type: 'Spreadsheet::Sheet',
    properties: new Map([['cells', cellsProp], prop('Label', el('String', { value: name }))] as [string, FcstdProperty][]),
  };
}

const NO_CONTOURS = new Map();

afterEach(() => setParamContext(undefined));

describe('C3: bound properties stay symbolic in the emitted code', () => {
  function padDoc(expression: string, storedLength = '0'): FcstdDocument {
    return {
      objects: [
        sheet('Data', [{ address: 'F1', content: '=40mm', alias: 'width' }]),
        {
          name: 'Sketch', type: 'Sketcher::SketchObject',
          properties: new Map([prop('Label', el('String', { value: 'Sketch' }))] as [string, FcstdProperty][]),
        },
        {
          name: 'Pad', type: 'PartDesign::Pad',
          properties: new Map([
            linkProp('Profile', 'Sketch'),
            floatProp('Length', storedLength),
            engineProp('Length', expression),
          ] as [string, FcstdProperty][]),
        },
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
  }

  const sketchInputs = new Map([['Sketch', { geoms: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 40, y2: 0 }], constraints: [] }]]);

  it('emits the const parameter header and inlines the expression into the op argument', () => {
    const doc = padDoc('<<Data>>.width * 2');
    const table = collectLeafParams(doc.objects);
    expect(table.list.map((p) => [p.name, p.value])).toEqual([['p_width', 40]]);
    setParamContext(table);
    const r = generateModel(
      doc, new Map(), NO_CONTOURS, 't', undefined, undefined, undefined, undefined, undefined,
      sketchInputs, undefined, table.list,
    );
    // C1: the parameter block, with its provenance comment
    expect(r.code).toContain('const p_width = 40; // Spreadsheet::Sheet.Alias:Data.width');
    // C3: the Pad length is the expression, not the baked 80
    expect(r.code).toContain('cad.extrude(Sketch, [0, 0, p_width * 2])');
    expect(r.code).not.toContain('0, 0, 80');
  });

  it('emits the parameter block only in modules that reference it', () => {
    const doc = padDoc('10 mm'); // constant binding → no parameter at all
    const table = collectLeafParams(doc.objects);
    setParamContext(table);
    const r = generateModel(
      doc, new Map(), NO_CONTOURS, 't', undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined,
    );
    expect(r.code).not.toContain('const p_width');
  });

  it('GOTCHA: an unresolvable binding still bakes — never falls back to the stored value', () => {
    // `foo(1)` is a function-family expression: not evaluable, not expressible
    // as parameters. The stored `<Float>` is a stale placeholder; using it would
    // emit wrong geometry with no failure record.
    const doc = padDoc('foo(1)', '999');
    setParamContext(collectLeafParams(doc.objects));
    const r = generateModel(
      doc, new Map(), NO_CONTOURS, 't', undefined, undefined, undefined, undefined, undefined,
      sketchInputs, undefined, undefined,
    );
    const pad = r.objects.find((o) => o.name === 'Pad');
    expect(pad).toMatchObject({ disposition: 'baked', reason: 'pad-length-expression-non-constant' });
    expect(r.code).not.toContain('999');
  });
});

describe('C2: a lifted sketch constraint renders as its parameter reference', () => {
  it('emits `value: p_…` inside cad.sketch instead of the baked number', () => {
    const doc: FcstdDocument = {
      objects: [
        {
          name: 'Sketch', type: 'Sketcher::SketchObject',
          properties: new Map([prop('Label', el('String', { value: 'Sketch' }))] as [string, FcstdProperty][]),
        },
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    // convert.ts rewrites the projected constraint's value to a JsExpr holding
    // the parameter name (see convert.ts); renderValue must emit it verbatim,
    // nested inside the constraints array.
    const constraints = [
      { kind: 'length' as const, of: { index: 0 }, value: jsExpr('p_Sketch229_Length') as unknown as number },
      { kind: 'horizontal' as const, of: { index: 0 } },
    ];
    const inputs = new Map([['Sketch', {
      geoms: [{ kind: 'line' as const, x1: 0, y1: 0, x2: 40, y2: 0 }],
      constraints,
    }]]);
    const r = generateModel(
      doc, new Map(), NO_CONTOURS, 't', undefined, undefined, undefined, undefined, undefined,
      inputs, undefined, [{ name: 'p_Sketch229_Length', value: 40, source: 'Sketcher::SketchObject.Constraint:Sketch229.Length' }],
    );
    expect(r.code).toContain('value: p_Sketch229_Length');
    expect(r.code).not.toContain('"value":40');
    expect(r.code).toContain('const p_Sketch229_Length = 40;');
  });
});
