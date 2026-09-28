/**
 * C1/C2/C4 (2026-09-28 plan) — leaf-parameter collection and naming.
 *
 * The three lifted sources are asserted one by one, plus the negative rules
 * that keep non-drivable things OUT of the parameter list (a Bool VarSet
 * variable, an unnamed or reference-driven constraint, an axis/external ref).
 * Those negatives matter as much as the positives: a `const` that nothing can
 * drive is noise in the UI, and a reference-driven constraint lifted to a
 * `const` would invert FreeCAD's dependency.
 */
import { describe, expect, it } from 'vitest';
import type { FcstdObject, FcstdProperty } from './document.js';
import { collectLeafParams, sketchConstraintCandidate } from './params.js';
import { ConstraintType } from './sketch-parse.js';

function el(tagName: string, attrs: Record<string, string>): FcstdProperty {
  return { name: tagName, type: '', tagName, children: [], valueXml: '', valueText: '', attributes: attrs };
}

function prop(name: string, childTag: string, attrs: Record<string, string>): [string, FcstdProperty] {
  return [name, { name, type: '', tagName: 'Property', children: [el(childTag, attrs)], valueXml: '', valueText: '', attributes: {} }];
}

/** A Spreadsheet::Sheet carrying `<Cell address content alias/>` entries. */
function sheet(label: string, cells: { address: string; content: string; alias?: string }[]): FcstdObject {
  const cellsProp: FcstdProperty = {
    name: 'cells', type: 'Spreadsheet::PropertySheet', tagName: 'Property',
    children: [{
      name: 'cells', type: '', tagName: 'cells', valueXml: '', valueText: '', attributes: {},
      children: cells.map((c) => el('Cell', {
        address: c.address,
        content: c.content,
        ...(c.alias === undefined ? {} : { alias: c.alias }),
      })),
    }],
    valueXml: '', valueText: '', attributes: {},
  };
  const o: FcstdObject = { name: label, type: 'Spreadsheet::Sheet', properties: new Map([['cells', cellsProp]]) };
  o.properties.set('Label', prop('Label', 'String', { value: label })[1]);
  return o;
}

function varSet(name: string, props: [string, FcstdProperty][]): FcstdObject {
  const o: FcstdObject = { name, type: 'App::VarSet', properties: new Map(props) };
  o.properties.set('Label', prop('Label', 'String', { value: name })[1]);
  return o;
}

function sketch(name: string, label: string): FcstdObject {
  const o: FcstdObject = { name, type: 'Sketcher::SketchObject', properties: new Map() };
  o.properties.set('Label', prop('Label', 'String', { value: label })[1]);
  return o;
}

describe('C1: Spreadsheet aliases and VarSet variables become leaf parameters', () => {
  it('lifts every aliased cell, evaluating its content (leading = stripped, units applied)', () => {
    const doc = [sheet('Data', [
      { address: 'F2', content: '=5.9mm', alias: 'Wt' },
      { address: 'B2', content: '=6.4mm', alias: 'Wc' },
      { address: 'C2', content: '=B2*2', alias: 'Double' },
      { address: 'D2', content: '=1mm' }, // unaliased → not addressable, skipped
    ])];
    const t = collectLeafParams(doc);
    expect(t.list.map((p) => [p.name, p.value])).toEqual([
      ['p_Wt', 5.9], ['p_Wc', 6.4], ['p_Double', 12.8],
    ]);
    expect(t.list[0]!.source).toBe('Spreadsheet::Sheet.Alias:Data.Wt');
    // both the Label and the object name address the same parameter
    expect(t.refName('Data', 'Wt')).toBe('p_Wt');
    expect(t.refName('Data', 'Double')).toBe('p_Double');
  });

  it('lifts numeric VarSet variables only (a Bool variable is not a dimension)', () => {
    const doc = [
      varSet('VarSet', [
        prop('Base_dimensions_B_Length', 'Float', { value: '800' }),
        prop('Drawers_A_Side_drawer_set', 'Bool', { value: 'false' }),
      ]),
    ];
    const t = collectLeafParams(doc);
    expect(t.list.map((p) => [p.name, p.value])).toEqual([['p_Base_dimensions_B_Length', 800]]);
    expect(t.list[0]!.source).toBe('App::VarSet.Property:VarSet.Base_dimensions_B_Length');
    expect(t.refName('VarSet', 'Base_dimensions_B_Length')).toBe('p_Base_dimensions_B_Length');
    expect(t.refName('VarSet', 'Drawers_A_Side_drawer_set')).toBeUndefined();
  });

  it('dedupes identifiers that sanitize to the same name (suffix scheme matches emitVar)', () => {
    const doc = [sheet('Data', [
      { address: 'A1', content: '=1mm', alias: 'gap size' },
      { address: 'A2', content: '=2mm', alias: 'gap-size' },
    ])];
    const t = collectLeafParams(doc);
    expect(t.list.map((p) => p.name)).toEqual(['p_gap_size', 'p_gap_size_2']);
  });

  it('never allocates a name that collides with a JS reserved word body', () => {
    const doc = [sheet('Data', [{ address: 'A1', content: '=3mm', alias: 'class' }])];
    // sanitizeIdent appends `_` for a reserved body, then the `p_` prefix is added
    expect(collectLeafParams(doc).list[0]!.name).toBe('p_class_');
  });
});

describe('C2: named dimensional sketch constraints become leaf parameters', () => {
  it('accepts a named, driving, own-geometry dimensional constraint', () => {
    const c = sketchConstraintCandidate('Sketch229', 'Esboco', {
      name: 'Length', type: ConstraintType.Distance, value: 400, isDriving: true,
      refs: [{ geoId: 0 }, { geoId: 0 }],
    });
    expect(c).toEqual({ sketch: 'Sketch229', sketchLabel: 'Esboco', constraint: 'Length', value: 400 });
  });

  it('rejects unnamed, reference-driven, axis/external and non-dimensional constraints', () => {
    const base = { type: ConstraintType.Distance, value: 10, isDriving: true, refs: [{ geoId: 0 }] };
    // unnamed: nothing can address it
    expect(sketchConstraintCandidate('S', 'S', { ...base, name: '' })).toBeUndefined();
    // reference-driven: the value computes FROM geometry, lifting it would invert the dependency
    expect(sketchConstraintCandidate('S', 'S', { ...base, name: 'D', isDriving: false })).toBeUndefined();
    // axis (-1/-2) or external (<= -3): cannot be projected into canonical, so the emitted
    // cad.sketch cannot carry it either — the parameter would be orphaned
    expect(sketchConstraintCandidate('S', 'S', { ...base, name: 'D', refs: [{ geoId: -1 }] })).toBeUndefined();
    expect(sketchConstraintCandidate('S', 'S', { ...base, name: 'D', refs: [{ geoId: -3 }] })).toBeUndefined();
    // pure geometric constraint kinds are not dimensions
    expect(sketchConstraintCandidate('S', 'S', { ...base, name: 'H', type: ConstraintType.Horizontal })).toBeUndefined();
    // a dimension with no refs cannot be projected
    expect(sketchConstraintCandidate('S', 'S', { ...base, name: 'D', refs: [] })).toBeUndefined();
  });

  it('names a lifted constraint p_<Sketch>_<Name> and indexes it by object name and Label', () => {
    const doc = [sketch('Sketch229', 'Esboco_janela')];
    const t = collectLeafParams(doc, [
      { sketch: 'Sketch229', sketchLabel: 'Esboco_janela', constraint: 'Length', value: 400 },
    ]);
    expect(t.list.map((p) => [p.name, p.value])).toEqual([['p_Sketch229_Length', 400]]);
    expect(t.list[0]!.source).toBe('Sketcher::SketchObject.Constraint:Sketch229.Length');
    expect(t.refName('Sketch229', 'Constraints', 'Length')).toBe('p_Sketch229_Length');
    expect(t.refName('Esboco_janela', 'Constraints', 'Length')).toBe('p_Sketch229_Length');
  });

  it('keeps parameter order deterministic and shared across sources (allocator is one instance)', () => {
    const doc = [
      sheet('Data', [{ address: 'A1', content: '=1mm', alias: 'Length' }]),
      sketch('Sketch229', 'Sketch229'),
    ];
    const t = collectLeafParams(doc, [
      { sketch: 'Sketch229', sketchLabel: 'Sketch229', constraint: 'Length', value: 20 },
    ]);
    expect(t.list.map((p) => p.name)).toEqual(['p_Length', 'p_Sketch229_Length']);
  });
});
