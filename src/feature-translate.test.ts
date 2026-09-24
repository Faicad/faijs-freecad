/**
 * M4 tests — whitelist feature translation (M4.1 table, M4.2 primitives,
 * M4.3 booleans, M4.6 Pad/Pocket).
 */
import { describe, it, expect } from 'vitest';
import { translateObject, isWhitelisted, placementPos, isJsExpr } from './feature-translate.js';
import type { FcstdObject, FcstdProperty } from './document.js';
import { parseFilletEdges, type FilletEdgeEntry } from './fillet-edges.js';

function prop(name: string, child: { name: string; attrs: Record<string, string> } | null = null): [string, FcstdProperty] {
  return [
    name,
    {
      name,
      type: '',
      tagName: 'Property',
      children: child ? [{ name: child.name, type: '', tagName: child.name, children: [], valueXml: '', valueText: '', attributes: child.attrs }] : [],
      valueText: '',
      attributes: {},
    },
  ];
}

function obj(type: string, name: string, props: [string, FcstdProperty][]): FcstdObject {
  return { type, name, properties: new Map(props) };
}

/**
 * An `App::PropertyLinkSub` with sub-element names, exactly as FreeCAD saves it:
 * `<LinkSub value="Pad001" count="2"><Sub value="Edge17"/><Sub value="Edge18"/></LinkSub>`.
 */
function linkSubProp(name: string, target: string, subs: string[]): [string, FcstdProperty] {
  return [
    name,
    {
      name,
      type: 'App::PropertyLinkSub',
      tagName: 'Property',
      children: [{
        name: 'LinkSub',
        type: '',
        tagName: 'LinkSub',
        children: subs.map((s) => ({
          name: 'Sub', type: '', tagName: 'Sub', children: [], valueXml: '', valueText: '', attributes: { value: s },
        })),
        valueXml: '',
        valueText: '',
        attributes: { value: target, count: String(subs.length) },
      }],
      valueXml: '',
      valueText: '',
      attributes: {},
    },
  ];
}

/** Raw `cad.edgeRef(...)` expressions carried in a call's params (M6.1 edge anchors). */
function edgeExprs(call: { params: Record<string, unknown> }): string[] {
  const edges = call.params['edges'];
  if (!Array.isArray(edges)) throw new Error('edges param is not an array');
  return edges.map((e) => (isJsExpr(e) ? e.__jsExpr : JSON.stringify(e)));
}

describe('M4.1 whitelist', () => {
  it('admits listed types and rejects others', () => {
    expect(isWhitelisted('Part::Box')).toBe(true);
    expect(isWhitelisted('PartDesign::Pad')).toBe(true);
    expect(isWhitelisted('Part::FeaturePython')).toBe(false);
    expect(isWhitelisted('PartDesign::Revolution')).toBe(true);
    expect(isWhitelisted('Part::Extrusion')).toBe(true);
  });
});

describe('M4.2 primitives', () => {
  it('translates Part::Box with placement corner', () => {
    const box = obj('Part::Box', 'Box', [
      prop('Length', { name: 'Float', attrs: { value: '30' } }),
      prop('Width', { name: 'Float', attrs: { value: '20' } }),
      prop('Height', { name: 'Float', attrs: { value: '10' } }),
      prop('Placement', { name: 'PropertyPlacement', attrs: {} }),
    ]);
    // inject placement values: Property → PropertyPlacement (real structure)
    const placement = box.properties.get('Placement')!;
    placement.children = [{
      name: 'PropertyPlacement', type: '', tagName: 'PropertyPlacement',
      children: [], valueXml: '', valueText: '',
      attributes: { Px: '5', Py: '0', Pz: '1', Q0: '0', Q1: '0', Q2: '0', Q3: '1' },
    }];
    void placement;
    expect(placementPos(box)).toEqual([5, 0, 1]);
    const v = translateObject(box, () => undefined);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.box');
      expect(v.calls[0]!.params).toMatchObject({ width: 20, depth: 30, height: 10, at: [5, 0, 1] });
    }
  });

  it('translates Part::Cylinder', () => {
    const cyl = obj('Part::Cylinder', 'Cyl', [
      prop('Radius', { name: 'Float', attrs: { value: '7.5' } }),
      prop('Height', { name: 'Float', attrs: { value: '40' } }),
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
      prop('Placement', { name: 'PropertyPlacement', attrs: {} }),
    ]);
    const v = translateObject(cyl, () => undefined);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') expect(v.calls[0]!.op).toBe('cad.cylinder');
  });
});

describe('M4.3 booleans', () => {
  it('translates Part::Cut into cad.subtract with resolved inputs', () => {
    const cut = obj('Part::Cut', 'Cut', [
      prop('Base', { name: 'Link', attrs: { value: 'Box' } }),
      prop('Tool', { name: 'Link', attrs: { value: 'Cyl' } }),
    ]);
    const v = translateObject(cut, (dep) => (dep === 'Box' ? 'part0' : dep === 'Cyl' ? 'part1' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.subtract');
      expect(v.calls[0]!.inputs).toEqual(['part0', 'part1']);
    }
  });

  it('bakes Part::Cut with unresolved dependency', () => {
    const cut = obj('Part::Cut', 'Cut', [
      prop('Base', { name: 'Link', attrs: { value: 'Box' } }),
      prop('Tool', { name: 'Link', attrs: { value: 'Ghost' } }),
    ]);
    const v = translateObject(cut, () => undefined);
    expect(v).toMatchObject({ kind: 'baked', reason: 'cut-missing-dependency' });
  });
});

describe('P5 Part::Mirroring', () => {
  // GOTCHA: Mirroring Base/Normal are <PropertyVector valueX= valueY= valueZ=/>
  // CHILD elements — the `value="x y z"` attribute form used by Extrusion.Dir
  // is a DIFFERENT serialization. Reading attributes for these returns NaN.
  function vecXYZ(name: string, x: number, y: number, z: number): [string, FcstdProperty] {
    return prop(name, { name: 'PropertyVector', attrs: { valueX: String(x), valueY: String(y), valueZ: String(z) } });
  }

  it('translates Source + Base/Normal plane into cad.mirror (P5)', () => {
    const mir = obj('Part::Mirroring', 'Mir', [
      prop('Source', { name: 'Link', attrs: { value: 'Fillet007' } }),
      vecXYZ('Base', 0, 0, 0),
      vecXYZ('Normal', 0, 2, 0), // unnormalized on purpose
      prop('Placement', { name: 'PropertyPlacement', attrs: { Px: '0', Py: '190', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' } }),
    ]);
    const v = translateObject(mir, (dep) => (dep === 'Fillet007' ? 'part7' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.mirror');
    expect(v.calls[0]!.inputs).toEqual(['part7']);
    // normal normalized; plane point = Base + Placement translation
    expect(v.calls[0]!.params).toMatchObject({ normal: [0, 1, 0], at: [0, 190, 0] });
  });

  it('bakes with explicit reason when Source is missing', () => {
    const mir = obj('Part::Mirroring', 'Mir', [
      vecXYZ('Base', 0, 0, 0),
      vecXYZ('Normal', 0, 1, 0),
    ]);
    const v = translateObject(mir, () => undefined);
    expect(v).toMatchObject({ kind: 'baked', reason: 'mirroring-missing-source' });
  });

  it('bakes with explicit reason when Normal is zero/missing', () => {
    const mir = obj('Part::Mirroring', 'Mir', [
      prop('Source', { name: 'Link', attrs: { value: 'A' } }),
      vecXYZ('Base', 0, 0, 0),
    ]);
    const v = translateObject(mir, (dep) => (dep === 'A' ? 'partA' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'mirroring-missing-normal' });
  });

  it('is whitelisted (P5)', () => {
    expect(isWhitelisted('Part::Mirroring')).toBe(true);
  });
});

describe('P8 Part::Chamfer', () => {
  // GOTCHA: edge selection AND sizes live in the binary PropertyFilletEdges
  // ZIP member (int32 count + per-entry {int32 edge, float64 size1,
  // float64 size2}, 20 bytes/entry), NOT in Document.xml — the `Edges`
  // property only carries <FilletEdges file="EdgesN"/>. There is no Size
  // property to read; XML-only parsing yields no chamfer size at all.
  function filletEdgesBin(entries: Array<[number, number, number]>): Uint8Array {
    const buf = new ArrayBuffer(4 + entries.length * 20);
    const view = new DataView(buf);
    view.setInt32(0, entries.length, true);
    entries.forEach(([e, s1, s2], k) => {
      const off = 4 + k * 20;
      view.setInt32(off, e, true);
      view.setFloat64(off + 4, s1, true);
      view.setFloat64(off + 12, s2, true);
    });
    return new Uint8Array(buf);
  }

  function chamferObj(): FcstdObject {
    return obj('Part::Chamfer', 'Chamfer007', [
      prop('Base', { name: 'Link', attrs: { value: 'Cut048' } }),
      prop('Edges', { name: 'FilletEdges', attrs: { file: 'Edges' } }),
    ]);
  }

  it('GOTCHA: parseFilletEdges reads the binary member format', () => {
    expect(parseFilletEdges(filletEdgesBin([[38, 7, 7], [12, 2, 2]]))).toEqual([
      { edge: 38, size1: 7, size2: 7 },
      { edge: 12, size1: 2, size2: 2 },
    ]);
  });

  it('parseFilletEdges returns undefined for missing/truncated data (no silent loss)', () => {
    expect(parseFilletEdges(undefined)).toBeUndefined();
    expect(parseFilletEdges(new Uint8Array(2))).toBeUndefined();
    // count claims 3 entries but only 1 is present
    const buf = new ArrayBuffer(24);
    const view = new DataView(buf);
    view.setInt32(0, 3, true);
    view.setInt32(4, 1, true);
    view.setFloat64(8, 1, true);
    view.setFloat64(16, 1, true);
    expect(parseFilletEdges(new Uint8Array(buf))).toBeUndefined();
  });

  it('translates Base + binary edges into cad.chamfer equal (P8)', () => {
    const data = new Map<string, FilletEdgeEntry[]>([
      ['Chamfer007', [{ edge: 38, size1: 7, size2: 7 }, { edge: 12, size1: 7, size2: 7 }]],
    ]);
    const v = translateObject(chamferObj(), (dep) => (dep === 'Cut048' ? 'part6' : undefined), undefined, undefined, undefined, data);
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.chamfer');
    expect(v.calls[0]!.inputs).toEqual(['part6']);
    expect(edgeExprs(v.calls[0]!)).toEqual(['cad.edgeRef(part6, 38)', 'cad.edgeRef(part6, 12)']);
    expect(v.calls[0]!.params).toMatchObject({ type: 'equal', width: 7 });
  });

  it('bakes with explicit reason when the binary edges data is absent', () => {
    const v = translateObject(chamferObj(), (dep) => (dep === 'Cut048' ? 'part6' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'chamfer-edges-data-missing' });
  });

  it('bakes on mixed per-edge sizes (edge ordinals shift after each chamfer)', () => {
    const data = new Map<string, FilletEdgeEntry[]>([
      ['Chamfer007', [{ edge: 38, size1: 7, size2: 7 }, { edge: 12, size1: 2, size2: 2 }]],
    ]);
    const v = translateObject(chamferObj(), (dep) => (dep === 'Cut048' ? 'part6' : undefined), undefined, undefined, undefined, data);
    expect(v).toMatchObject({ kind: 'baked', reason: 'chamfer-mixed-sizes' });
  });

  it('bakes on asymmetric size1 != size2 (two-distance, unverified mapping)', () => {
    const data = new Map<string, FilletEdgeEntry[]>([
      ['Chamfer007', [{ edge: 38, size1: 7, size2: 3 }]],
    ]);
    const v = translateObject(chamferObj(), (dep) => (dep === 'Cut048' ? 'part6' : undefined), undefined, undefined, undefined, data);
    expect(v).toMatchObject({ kind: 'baked', reason: 'chamfer-asymmetric-sizes' });
  });

  it('is whitelisted (P8)', () => {
    expect(isWhitelisted('Part::Chamfer')).toBe(true);
  });
});

describe('P9 Part::Fillet', () => {
  // GOTCHA: identical binary PropertyFilletEdges member as Part::Chamfer
  // (int32 count + per-entry {int32 edge, float64 size1, float64 size2}, 20
  // bytes/entry). For a constant fillet size1 === size2 === radius.
  function filletObj(): FcstdObject {
    return obj('Part::Fillet', 'Fillet007', [
      prop('Base', { name: 'Link', attrs: { value: 'Sweep014' } }),
      prop('Edges', { name: 'FilletEdges', attrs: { file: 'Edges2' } }),
    ]);
  }

  it('translates Base + binary edges into cad.fillet (uniform radius, P9)', () => {
    const data = new Map<string, FilletEdgeEntry[]>([
      ['Fillet007', [
        { edge: 1, size1: 2, size2: 2 },
        { edge: 3, size1: 2, size2: 2 },
        { edge: 13, size1: 2, size2: 2 },
      ]],
    ]);
    const v = translateObject(filletObj(), (dep) => (dep === 'Sweep014' ? 'part6' : undefined), undefined, undefined, undefined, data);
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.fillet');
    expect(v.calls[0]!.inputs).toEqual(['part6']);
    expect(edgeExprs(v.calls[0]!)).toEqual([
      'cad.edgeRef(part6, 1)',
      'cad.edgeRef(part6, 3)',
      'cad.edgeRef(part6, 13)',
    ]);
    expect(v.calls[0]!.params).toMatchObject({ radius: 2 });
  });

  it('bakes with explicit reason when the binary edges data is absent', () => {
    const v = translateObject(filletObj(), (dep) => (dep === 'Sweep014' ? 'part6' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'fillet-edges-data-missing' });
  });

  it('bakes on asymmetric size1 != size2 (malformed fillet, P9)', () => {
    const data = new Map<string, FilletEdgeEntry[]>([
      ['Fillet007', [{ edge: 1, size1: 2, size2: 3 }]],
    ]);
    const v = translateObject(filletObj(), (dep) => (dep === 'Sweep014' ? 'part6' : undefined), undefined, undefined, undefined, data);
    expect(v).toMatchObject({ kind: 'baked', reason: 'fillet-asymmetric-sizes' });
  });

  it('bakes on variable radius (differing size1 across edges, M1 unsupported)', () => {
    const data = new Map<string, FilletEdgeEntry[]>([
      ['Fillet007', [{ edge: 1, size1: 2, size2: 2 }, { edge: 3, size1: 5, size2: 5 }]],
    ]);
    const v = translateObject(filletObj(), (dep) => (dep === 'Sweep014' ? 'part6' : undefined), undefined, undefined, undefined, data);
    expect(v).toMatchObject({ kind: 'baked', reason: 'fillet-variable-radius' });
  });

  it('is whitelisted (P9)', () => {
    expect(isWhitelisted('Part::Fillet')).toBe(true);
  });
});

describe('P7 Part::Fuse', () => {
  it('translates Base + Tool into cad.union (P7)', () => {
    const fuse = obj('Part::Fuse', 'Fusion', [
      prop('Base', { name: 'Link', attrs: { value: 'Box' } }),
      prop('Tool', { name: 'Link', attrs: { value: 'Cyl' } }),
    ]);
    const v = translateObject(fuse, (dep) => (dep === 'Box' ? 'part0' : dep === 'Cyl' ? 'part1' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.union');
    expect(v.calls[0]!.inputs).toEqual(['part0', 'part1']);
  });

  it('bakes with explicit reason when a dependency is missing', () => {
    const fuse = obj('Part::Fuse', 'Fusion', [
      prop('Base', { name: 'Link', attrs: { value: 'Box' } }),
      prop('Tool', { name: 'Link', attrs: { value: 'Ghost' } }),
    ]);
    const v = translateObject(fuse, () => undefined);
    expect(v).toMatchObject({ kind: 'baked', reason: 'fuse-missing-dependency' });
  });

  it('is whitelisted (P7)', () => {
    expect(isWhitelisted('Part::Fuse')).toBe(true);
  });
});

describe('P6 Part::Revolution', () => {
  // GOTCHA: Part::Revolution stores the axis as Base/Axis PropertyVector
  // CHILD elements (valueX/Y/Z) — PartDesign::Revolution instead stores a
  // ReferenceAxis STRING. Different serializations, different branches.
  function vecXYZ(name: string, x: number, y: number, z: number): [string, FcstdProperty] {
    return prop(name, { name: 'PropertyVector', attrs: { valueX: String(x), valueY: String(y), valueZ: String(z) } });
  }

  it('translates Source + Base/Axis into cad.revolve (P6)', () => {
    const rev = obj('Part::Revolution', 'Revolve', [
      prop('Source', { name: 'Link', attrs: { value: 'Sketch1242' } }),
      vecXYZ('Base', 0, -5, 712.877),
      vecXYZ('Axis', 0, 0.0000000000000002, 1), // near-axis noise → normalized
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
      prop('Symmetric', { name: 'Bool', attrs: { value: 'false' } }),
      prop('Placement', { name: 'PropertyPlacement', attrs: { Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' } }),
    ]);
    const v = translateObject(rev, (dep) => (dep === 'Sketch1242' ? 'sk0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.revolve');
    expect(v.calls[0]!.inputs).toEqual(['sk0']);
    const p = v.calls[0]!.params as { axis: number[]; at: number[]; angle: number };
    expect(p.axis[2]).toBeCloseTo(1, 10);
    expect(p.angle).toBeCloseTo(Math.PI * 2, 10);
    expect(p.at).toEqual([0, -5, 712.877]);
  });

  it('bakes with explicit reason when Source is missing', () => {
    const rev = obj('Part::Revolution', 'Revolve', [
      vecXYZ('Base', 0, 0, 0),
      vecXYZ('Axis', 0, 0, 1),
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
    ]);
    const v = translateObject(rev, () => undefined);
    expect(v).toMatchObject({ kind: 'baked', reason: 'part-revolution-missing-source' });
  });

  it('bakes with upstream reason when Source link exists but is not translated', () => {
    const rev = obj('Part::Revolution', 'Revolve', [
      prop('Source', { name: 'Link', attrs: { value: 'Ghost' } }),
      vecXYZ('Axis', 0, 0, 1),
    ]);
    const v = translateObject(rev, () => undefined);
    expect(v).toMatchObject({ kind: 'baked', reason: 'part-revolution-source-baked-upstream:Ghost' });
  });

  it('bakes on Symmetric=true (unsupported)', () => {
    const rev = obj('Part::Revolution', 'Revolve', [
      prop('Source', { name: 'Link', attrs: { value: 'S' } }),
      vecXYZ('Axis', 0, 0, 1),
      prop('Symmetric', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    const v = translateObject(rev, (dep) => (dep === 'S' ? 'sk0' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'part-revolution-symmetric-unsupported' });
  });

  it('is whitelisted (P6)', () => {
    expect(isWhitelisted('Part::Revolution')).toBe(true);
  });
});

describe('M4.6 Pad/Pocket', () => {
  it('translates Pad over a sketch profile', () => {
    const pad = obj('PartDesign::Pad', 'Pad', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Length', { name: 'Float', attrs: { value: '12' } }),
      prop('Reversed', { name: 'Bool', attrs: { value: 'false' } }),
      prop('Midplane', { name: 'Bool', attrs: { value: 'false' } }),
    ]);
    const v = translateObject(pad, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.extrude');
      expect(v.calls[0]!.inputs).toEqual(['sketch0']);
      // length is carried as a directional literal (Vec3 along +Z)
      expect(v.calls[0]!.literals).toEqual([[0, 0, 12]]);
      expect(v.calls[0]!.params).toEqual({});
    }
  });

  it('translates Part::Extrusion over a base with directional length', () => {
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Length', { name: 'Float', attrs: { value: '10' } }),
      prop('Dir', { name: 'Vector', attrs: { value: '0 0 1' } }),
      prop('Reverse', { name: 'Bool', attrs: { value: 'false' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.extrude');
      expect(v.calls[0]!.inputs).toEqual(['sketch0']);
      expect(v.calls[0]!.literals).toEqual([[0, 0, 10]]);
    }
  });

  // GOTCHA (E4, corpus 2026-09-23): Part::Extrusion serializes in three
  // shapes. New format (626 sampled objects): LengthFwd/LengthRev + unit Dir.
  // Old format (76): only Dir, whose magnitude IS the length. Legacy
  // (~0): Length + Dir. The legacy-only code produced len=0 →
  // E_EXTRUDE_ZERO_VECTOR on 918 corpus runs.
  it('translates new-format Part::Extrusion via LengthFwd/LengthRev with unit Dir', () => {
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('LengthFwd', { name: 'Float', attrs: { value: '50' } }),
      prop('LengthRev', { name: 'Float', attrs: { value: '0' } }),
      prop('Dir', { name: 'Vector', attrs: { value: '0 0 1' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.literals).toEqual([[0, 0, 50]]);
    }
  });

  it('GOTCHA: old-format Part::Extrusion has no Length — |Dir| IS the extrusion vector', () => {
    // Wrong (legacy) reading: Length missing → len 0 → zero vector.
    // Correct: Dir itself is the extrude vector (Flat Bar truth: vol
    // 162500 = 130×25×50 with Dir=(0,0,50), no Length).
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Dir', { name: 'Vector', attrs: { value: '0 0 50' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.literals).toEqual([[0, 0, 50]]);
    }
  });

  // GOTCHA (E4 corpus 2026-09-24): FCStd serializes App::PropertyVector as
  // <PropertyVector valueX=… valueY=… valueZ=…/> child element, NOT the
  // value="x y z" attribute form. propVec reads value="…"; propVecXYZ reads
  // valueX/Y/Z. The old-format Dir (no LengthFwd/LengthRev/Length) must use
  // propVecXYZ first, else Dir falls back to [0,0,1] default → extrude len 1
  // instead of |Dir|. This caused 918 E4 zero-vector runs to remain unfixed
  // after P0-4 because the single-test used value="0 0 50" (wrong form).
  it('GOTCHA: Part::Extrusion Dir uses valueX/valueY/valueZ child-element form', () => {
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Dir', { name: 'PropertyVector', attrs: { valueX: '0', valueY: '0', valueZ: '50' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.literals).toEqual([[0, 0, 50]]);
    }
  });

  it('normalizes Dir and applies Reversed for new-format Part::Extrusion', () => {
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('LengthFwd', { name: 'Float', attrs: { value: '10' } }),
      prop('Dir', { name: 'Vector', attrs: { value: '0 3 4' } }),
      prop('Reversed', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      // Reversed with no LengthRev → extrude 10 backwards along unit Dir.
      expect(v.calls[0]!.literals).toEqual([[0, -6, -8]]);
    }
  });

  it('bakes TaperAngle≠0 Part::Extrusion with an explicit reason (no silent ignore)', () => {
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('LengthFwd', { name: 'Float', attrs: { value: '50' } }),
      prop('Dir', { name: 'Vector', attrs: { value: '0 0 1' } }),
      prop('TaperAngle', { name: 'Float', attrs: { value: '5' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'extrusion-taper-unsupported' });
  });

  it('GOTCHA: symmetric new-format Extrusion unions fwd+rev prisms of LengthFwd each', () => {
    const ext = obj('Part::Extrusion', 'Ext', [
      prop('Base', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('LengthFwd', { name: 'Float', attrs: { value: '20' } }),
      prop('Dir', { name: 'Vector', attrs: { value: '0 0 1' } }),
      prop('Symmetric', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    const v = translateObject(ext, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls).toHaveLength(3);
      expect(v.calls[0]!.literals).toEqual([[0, 0, 20]]);
      expect(v.calls[1]!.literals).toEqual([[0, 0, -20]]);
      expect(v.calls[2]!.op).toBe('cad.union');
    }
  });

  // GOTCHA (P1-1b, corpus 2026-09-23): Pocket Midplane was baked as
  // `pocket-midplane-unsupported` (30-file bucket + blocked Sprocket z08).
  // Symmetric cut = two half-prisms fused then subtracted (same construction
  // as the Pad midplane branch).
  it('translates Pocket Midplane as symmetric ±len/2 prisms unioned then subtracted', () => {
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('Length', { name: 'Float', attrs: { value: '8' } }),
      prop('BaseFeature', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Midplane', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    const v = translateObject(pocket, (dep) => (dep === 'Sketch001' ? 'sketch1' : dep === 'Pad' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls).toHaveLength(4);
      expect(v.calls[0]!.literals).toEqual([[0, 0, 4]]);
      expect(v.calls[1]!.literals).toEqual([[0, 0, -4]]);
      expect(v.calls[2]!.op).toBe('cad.union');
      expect(v.calls[3]!.op).toBe('cad.subtract');
      expect(v.calls[3]!.inputs).toEqual(['part2', 'Pocket_cut']);
    }
  });

  // GOTCHA (P3-1, corpus 2026-09-23): FreeCAD serializes Transformed features
  // with the patterned features in `Originals` (PropertyLinkList) — `Source`
  // only exists on some versions. Reading Source only baked 113+16+8 files
  // with polar/linear-pattern-missing-source.
  it('resolves LinearPattern source from Originals when Source is absent', () => {
    const pat = obj('PartDesign::LinearPattern', 'Pat', [
      prop('Occurrences', { name: 'Integer', attrs: { value: '4' } }),
      prop('Length', { name: 'Float', attrs: { value: '30' } }),
      prop('Direction', { name: 'LinkSub', attrs: { value: 'N_Axis' } }),
    ]);
    pat.properties.set('Originals', {
      name: 'Originals',
      type: 'App::PropertyLinkList',
      tagName: 'Property',
      children: [{
        name: 'LinkList', type: '', tagName: 'LinkList', children: [
          { name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: 'Pocket' } },
        ], valueXml: '', valueText: '', attributes: { count: '1' },
      }],
      valueText: '',
      attributes: {},
    });
    const v = translateObject(pat, (dep) => (dep === 'Pocket' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.linearPattern');
      expect(v.calls[0]!.inputs).toEqual(['part2']);
      expect(v.calls[0]!.literals).toEqual([expect.anything(), 4, 10]);
    }
  });

  it('translates PartDesign::Revolution around the body Z axis', () => {
    const rev = obj('PartDesign::Revolution', 'Rev', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
      prop('ReferenceAxis', { name: 'LinkSub', attrs: { value: 'V_Axis' } }),
    ]);
    const v = translateObject(rev, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.revolve');
      expect(v.calls[0]!.inputs).toEqual(['sketch0']);
      expect(v.calls[0]!.params).toMatchObject({ axis: [0, 0, 1], at: [0, 0, 0] });
    }
  });

  it('bakes Revolution referencing an edge/vertex axis (unsupported)', () => {
    const rev = obj('PartDesign::Revolution', 'Rev', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
      prop('ReferenceAxis', { name: 'LinkSub', attrs: { value: 'Edge1' } }),
    ]);
    const v = translateObject(rev, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'revolution-edge-axis-unsupported' });
  });

  // GOTCHA (P2-1, Mannequin_mp 2026-09-24): a Revolution with a VALID Profile
  // link whose target sketch was baked upstream (unsupported-geometry) used
  // to bake as `revolution-missing-profile` — a cascade lie (the link was
  // there). It must bake with `revolution-profile-baked-upstream:<name>` so
  // the report points at the upstream sketch, not at a phantom missing link.
  it('bakes Revolution whose profile was baked upstream with an explicit cascade reason', () => {
    const rev = obj('PartDesign::Revolution', 'Rev', [
      prop('Profile', { name: 'LinkSub', attrs: { value: 'Sketch061' } }),
      prop('Angle', { name: 'Angle', attrs: { value: '360' } }),
      prop('ReferenceAxis', { name: 'LinkSub', attrs: { value: 'Sketch061' } }),
    ]);
    const v = translateObject(rev, () => undefined);
    expect(v).toMatchObject({ kind: 'baked', reason: 'revolution-profile-baked-upstream:Sketch061' });
  });

  // GOTCHA (P2-2, Mannequin_mp 2026-09-24): PartDesign::Groove was NOT in the
  // whitelist, so all 26 Grooves silently fell to preservedOnly — never even
  // reaching the translate layer. Groove = Revolution + subtract.
  it('translates PartDesign::Groove as revolve + subtract from base', () => {
    const groove = obj('PartDesign::Groove', 'Groove', [
      prop('Profile', { name: 'LinkSub', attrs: { value: 'Sketch' } }),
      prop('BaseFeature', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Angle', { name: 'Angle', attrs: { value: '360' } }),
      prop('ReferenceAxis', { name: 'LinkSub', attrs: { value: 'V_Axis' } }),
    ]);
    const v = translateObject(groove, (dep) => (dep === 'Sketch' ? 'sketch0' : dep === 'Pad' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls).toHaveLength(2);
      expect(v.calls[0]!.op).toBe('cad.revolve');
      expect(v.calls[0]!.params).toMatchObject({ axis: [0, 0, 1], at: [0, 0, 0] });
      expect(v.calls[1]!.op).toBe('cad.subtract');
      expect(v.calls[1]!.inputs).toEqual(['part2', 'Groove_groove']);
    }
  });

  it('bakes Groove missing its base feature with an explicit reason', () => {
    const groove = obj('PartDesign::Groove', 'Groove', [
      prop('Profile', { name: 'LinkSub', attrs: { value: 'Sketch' } }),
      prop('Angle', { name: 'Angle', attrs: { value: '360' } }),
      prop('ReferenceAxis', { name: 'LinkSub', attrs: { value: 'V_Axis' } }),
    ]);
    const v = translateObject(groove, (dep) => (dep === 'Sketch' ? 'sketch0' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'groove-missing-base' });
  });

  it('translates Pocket as extrude + subtract from base', () => {
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('Length', { name: 'Float', attrs: { value: '5' } }),
      prop('BaseFeature', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Reversed', { name: 'Bool', attrs: { value: 'false' } }),
      prop('Midplane', { name: 'Bool', attrs: { value: 'false' } }),
    ]);
    const v = translateObject(pocket, (dep) => (dep === 'Sketch001' ? 'sketch1' : dep === 'Pad' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls.length).toBe(2);
      expect(v.calls[1]!.op).toBe('cad.subtract');
      expect(v.calls[1]!.inputs).toEqual(['part2', 'Pocket_cut']);
    }
  });

  it('GOTCHA (hole_puzzle corpus 2026-09-20): Pocket WITHOUT a BaseFeature property must NOT be a dependency gap — codegen resolves the base from the Body chain', () => {
    // FreeCAD 0.20+ PartDesign files routinely omit BaseFeature on interior
    // features: the base is implied by the Body's feature order (chain head).
    // hole_puzzle has 9 Pockets, ALL without BaseFeature — every one gapped
    // with pocket-missing-dependency even though their Profile sketches were
    // translated + solved. The translator must treat a missing BaseFeature
    // property as "no explicit base" (kind of translated), NOT as a missing
    // dependency; codegen then retargets the subtract at the chain head.
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('Length', { name: 'Float', attrs: { value: '5' } }),
      prop('Reversed', { name: 'Bool', attrs: { value: 'true' } }),
      prop('Midplane', { name: 'Bool', attrs: { value: 'false' } }),
    ]);
    const v = translateObject(pocket, (dep) => (dep === 'Sketch001' ? 'sketch1' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls.length).toBe(2);
      expect(v.calls[1]!.op).toBe('cad.subtract');
      // the subtract's base input must carry the chain-head marker so codegen
      // can retarget it; it must NOT be the profile var
      expect(v.calls[1]!.inputs[0]).not.toBe('sketch1');
    }
  });

  it('Pocket with a BaseFeature property whose target is unresolvable is STILL a gap (explicit base must resolve)', () => {
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('Length', { name: 'Float', attrs: { value: '5' } }),
      prop('BaseFeature', { name: 'Link', attrs: { value: 'Ghost' } }),
    ]);
    const v = translateObject(pocket, (dep) => (dep === 'Sketch001' ? 'sketch1' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'pocket-missing-dependency' });
  });

  it('GOTCHA (hole_puzzle corpus 2026-09-20): Pocket Type=ThroughAll translates like Length with a deep prism, not a gap', () => {
    // ThroughAll means "cut through the whole base" — FreeCAD truncates the
    // prism against the base solid, so a depth larger than the base bbox is
    // safe. The corpus CAM demo parts (hole_puzzle ×9, motor_mount_inch ×2,
    // strange_part_with_holes ×2) use ThroughAll exclusively; without this
    // they gap with pocket-type-ThroughAll-unsupported.
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('Type', { name: 'String', attrs: { value: 'ThroughAll' } }),
      prop('BaseFeature', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Reversed', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    const v = translateObject(pocket, (dep) => (dep === 'Sketch001' ? 'sketch1' : dep === 'Pad' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls.length).toBe(2);
      expect(v.calls[0]!.op).toBe('cad.extrude');
      // the through prism must be deep in the cut direction (Reversed → +Z)
      const lit = v.calls[0]!.literals?.[0];
      expect((lit as number[])?.[2]).toBeGreaterThan(0);
      expect(v.calls[1]!.op).toBe('cad.subtract');
      expect(v.calls[1]!.inputs).toEqual(['part2', 'Pocket_cut']);
    }
  });

  it('bakes Python-feature types with reason', () => {
    const py = obj('Part::FeaturePython', 'Py1', []);
    const v = translateObject(py, () => undefined);
    expect(v.kind).toBe('baked');
    if (v.kind === 'baked') expect(v.reason).toContain('type-not-whitelisted');
  });
});

describe('M4.6b UpToFace datum-plane (extrude-upto-face §4.3-C1)', () => {
  // PadTest Pad001 geometry: sketch normal = +X, datum plane is TILTED
  // (normal ≈ [0.705, 0.071, 0.705]); the signed distance to it along the
  // sketch normal is +10 (the naive (Δp·dir) form wrongly yields −50).
  function placementProp(px: number, py: number, pz: number, q0: number, q1: number, q2: number, q3: number): [string, FcstdProperty] {
    return ['Placement', {
      name: 'Placement', type: 'App::PropertyPlacement', tagName: 'Property',
      children: [{ name: 'PropertyPlacement', type: '', tagName: 'PropertyPlacement', children: [], valueXml: '', valueText: '', attributes: { Px: String(px), Py: String(py), Pz: String(pz), Q0: String(q0), Q1: String(q1), Q2: String(q2), Q3: String(q3) } }],
      valueText: '', attributes: {},
    }];
  }
  function linkProp(name: string, target: string): [string, FcstdProperty] {
    return [name, {
      name, type: 'App::PropertyLink', tagName: 'Property',
      children: [{ name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: target } }],
      valueText: '', attributes: {},
    }];
  }
  // App::PropertyEnumeration as a `[name, prop]` tuple (NOT a bare object —
  // `obj()` does `new Map(props)`, so a bare object is silently dropped and
  // featureTypeOf falls back to the Length default).
  function enumProp(name: string, value: string): [string, FcstdProperty] {
    return [name, {
      name, type: 'App::PropertyEnumeration', tagName: 'Property',
      children: [{ name: 'Integer', type: '', tagName: 'Integer', children: [], valueXml: '', valueText: '', attributes: { value } }],
      valueText: '', attributes: {},
    }];
  }
  const datumPlane = obj('PartDesign::Plane', 'DatumPlane', [placementProp(-40, 100, 50, -0.038192735828, 0.381927358277, 0, 0.923402841629)]);
  const sketch001 = obj('Sketcher::SketchObject', 'Sketch001', [placementProp(10, 0, 0, 0, 0.707106781187, 0, 0.707106781187)]);
  const pad001 = obj('PartDesign::Pad', 'Pad001', [
    linkProp('Profile', 'Sketch001'),
    enumProp('Type', '3'),
    linkSubProp('UpToFace', 'DatumPlane', ['Plane']),
  ]);

  it('translates UpToFace→datum plane as cad.extrude with an explicit plane target (tilted-datum GOTCHA)', () => {
    const v = translateObject(pad001, (dep) => (dep === 'Sketch001' ? 'sketch0' : undefined), [pad001, datumPlane, sketch001]);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      const call = v.calls[0]!;
      expect(call.op).toBe('cad.extrude');
      expect(call.inputs).toEqual(['sketch0']);
      // GOTCHA (PadTest V6): a TILTED datum plane must NOT become a fixed
      // length (flat top disc 1874.83 vs truth slanted 4860.42) — it becomes
      // an explicit plane target; the kernel half-space cut yields the slant.
      // The plane is expressed in SKETCH-LOCAL coords (extrude frame).
      const upTo = (call.params as { upTo?: { plane?: { point: number[]; normal: number[] } } }).upTo;
      expect(upTo?.plane).toBeDefined();
      // GOTCHA: the sketch origin is NOT on the tilted datum plane (signed
      // distance along local +Z is t = 10, the old flat-length value). Any
      // point ON the plane is valid for a plane spec — verify semantics via
      // the axis intersection: t = (point·n)/n[2] must be +10.
      const pt = upTo!.plane!.point!;
      const n = upTo!.plane!.normal!;
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 6);
      expect(n[2]!).toBeGreaterThan(0);
      const t = (pt[0]! * n[0]! + pt[1]! * n[1]! + pt[2]! * n[2]!) / n[2]!;
      expect(t).toBeCloseTo(10, 3);
      expect(v.reason).toBe('uptoface-via-datum-plane-distance');
    }
  });

  it('bakes with uptoface-datum-plane-parallel when the datum plane is parallel to the extrude dir', () => {
    // datum plane normal = +Y, sketch normal = +X → dir·n = 0
    const parallelPlane = obj('PartDesign::Plane', 'DatumPlane', [placementProp(0, 0, 0, -0.707106781187, 0, 0, 0.707106781187)]);
    const p = obj('PartDesign::Pad', 'Pad001', [
      linkProp('Profile', 'Sketch001'),
      enumProp('Type', '3'),
      linkSubProp('UpToFace', 'DatumPlane', ['Plane']),
    ]);
    const v = translateObject(p, (dep) => (dep === 'Sketch001' ? 'sketch0' : undefined), [p, parallelPlane, sketch001]);
    expect(v).toMatchObject({ kind: 'baked', reason: 'uptoface-datum-plane-parallel' });
  });

  it('bakes with uptoface-solid-face-unsupported when the UpToFace target is a solid, not a datum plane', () => {
    const solid = obj('PartDesign::Pad', 'OtherPad', []);
    const p = obj('PartDesign::Pad', 'Pad001', [
      linkProp('Profile', 'Sketch001'),
      enumProp('Type', '3'),
      linkSubProp('UpToFace', 'OtherPad', ['Face1']),
    ]);
    const v = translateObject(p, (dep) => (dep === 'Sketch001' ? 'sketch0' : undefined), [p, solid, sketch001]);
    expect(v).toMatchObject({ kind: 'baked', reason: 'uptoface-solid-face-unsupported' });
  });
});

describe('M4.6c Pad UpToLast/UpToFirst (extrude-upto-face §4.3-C2)', () => {
  // Helpers (kept local; M4.6b defines its own copies).
  function linkProp(name: string, target: string): [string, FcstdProperty] {
    return [name, {
      name, type: 'App::PropertyLink', tagName: 'Property',
      children: [{ name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: target } }],
      valueText: '', attributes: {},
    }];
  }
  function enumProp(name: string, value: string): [string, FcstdProperty] {
    return [name, {
      name, type: 'App::PropertyEnumeration', tagName: 'Property',
      children: [{ name: 'Integer', type: '', tagName: 'Integer', children: [], valueXml: '', valueText: '', attributes: { value } }],
      valueText: '', attributes: {},
    }];
  }

  it('translates Pad UpToLast as cad.extrude upTo:"last" with baseFeature ref', () => {
    const base = obj('PartDesign::Pad', 'BasePad', [enumProp('Type', '0'), linkProp('Profile', 'Sketch0')]);
    const pad = obj('PartDesign::Pad', 'Pad002', [
      linkProp('Profile', 'Sketch001'),
      linkProp('BaseFeature', 'BasePad'),
      enumProp('Type', '1'),
    ]);
    const v = translateObject(
      pad,
      (dep) => (dep === 'Sketch001' ? 'sketch0' : dep === 'BasePad' ? 'base0' : undefined),
      [pad, base],
    );
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      const call = v.calls[0]!;
      expect(call.op).toBe('cad.extrude');
      expect(call.inputs).toEqual(['sketch0']);
      expect(call.params.upTo).toBe('last');
      const bf = call.params.baseFeature;
      expect(isJsExpr(bf) ? bf.__jsExpr : bf).toBe('base0');
      expect(v.reason).toBe('pad-UpToLast-via-baseFeature');
    }
  });

  it('translates Pad UpToFirst as cad.extrude upTo:"first"', () => {
    const base = obj('PartDesign::Pad', 'BasePad', [enumProp('Type', '0'), linkProp('Profile', 'Sketch0')]);
    const pad = obj('PartDesign::Pad', 'Pad001', [
      linkProp('Profile', 'Sketch001'),
      linkProp('BaseFeature', 'BasePad'),
      enumProp('Type', '2'),
    ]);
    const v = translateObject(
      pad,
      (dep) => (dep === 'Sketch001' ? 'sketch0' : dep === 'BasePad' ? 'base0' : undefined),
      [pad, base],
    );
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      const call = v.calls[0]!;
      expect(call.op).toBe('cad.extrude');
      expect(call.params.upTo).toBe('first');
      const bf = call.params.baseFeature;
      expect(isJsExpr(bf) ? bf.__jsExpr : bf).toBe('base0');
      expect(v.reason).toBe('pad-UpToFirst-via-baseFeature');
    }
  });

  it('bakes UpToLast/UpToFirst without a resolvable BaseFeature (no silent fallback)', () => {
    const pad = obj('PartDesign::Pad', 'Pad002', [
      linkProp('Profile', 'Sketch001'),
      enumProp('Type', '1'),
    ]);
    const v = translateObject(pad, (dep) => (dep === 'Sketch001' ? 'sketch0' : undefined), [pad]);
    expect(v).toMatchObject({ kind: 'baked', reason: 'pad-upTo-missing-base' });
  });
});

describe('M4.6d Pad UpToFace solid-face (extrude-upto-face §4.3-C2.2)', () => {
  // Helpers (kept local; M4.6b/M4.6c define their own copies).
  function linkProp(name: string, target: string): [string, FcstdProperty] {
    return [name, {
      name, type: 'App::PropertyLink', tagName: 'Property',
      children: [{ name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: target } }],
      valueText: '', attributes: {},
    }];
  }
  function enumProp(name: string, value: string): [string, FcstdProperty] {
    return [name, {
      name, type: 'App::PropertyEnumeration', tagName: 'Property',
      children: [{ name: 'Integer', type: '', tagName: 'Integer', children: [], valueXml: '', valueText: '', attributes: { value } }],
      valueText: '', attributes: {},
    }];
  }
  // linkSubProp is module-level (defined near the top of this file).

  it('translates Pad UpToFace solid-face as cad.extrude upTo: cad.faceRef(targetVar, N)', () => {
    const target = obj('PartDesign::Pad', 'OtherPad', [enumProp('Type', '0'), linkProp('Profile', 'Sketch0')]);
    const pad = obj('PartDesign::Pad', 'Pad001', [
      linkProp('Profile', 'Sketch001'),
      enumProp('Type', '3'),
      linkSubProp('UpToFace', 'OtherPad', ['Face3']),
    ]);
    const v = translateObject(
      pad,
      (dep) => (dep === 'Sketch001' ? 'sketch0' : dep === 'OtherPad' ? 'other0' : undefined),
      [pad, target],
    );
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      const call = v.calls[0]!;
      expect(call.op).toBe('cad.extrude');
      expect(call.inputs).toEqual(['sketch0']);
      // FaceN ordinal passes through verbatim into the faceRef argument;
      // faceRef's enum order is calibrated to FreeCAD's FaceN (plan R-A).
      const upTo = call.params.upTo;
      expect(isJsExpr(upTo) ? upTo.__jsExpr : upTo).toBe('cad.faceRef(other0, 3)');
      expect(v.reason).toBe('uptoface-via-faceRef');
    }
  });

  it('bakes uptoface-sub-unparseable when the sub is not a plain FaceN reference', () => {
    // FreeCAD TNaming-modified face names (e.g. "Face__20f_...") are not a
    // stable ordinal → explicit bake, never guess.
    const target = obj('PartDesign::Pad', 'OtherPad', []);
    const pad = obj('PartDesign::Pad', 'Pad001', [
      linkProp('Profile', 'Sketch001'),
      enumProp('Type', '3'),
      linkSubProp('UpToFace', 'OtherPad', ['Face__20f_']),
    ]);
    const v = translateObject(
      pad,
      (dep) => (dep === 'Sketch001' ? 'sketch0' : dep === 'OtherPad' ? 'other0' : undefined),
      [pad, target],
    );
    expect(v).toMatchObject({ kind: 'baked', reason: 'uptoface-sub-unparseable' });
  });

  it('still bakes uptoface-solid-face-unsupported when the target var is unresolvable', () => {
    // regression: target is a solid but its var cannot be resolved → bake the
    // same reason as before C2.2 (no silent faceRef against an unknown shape).
    const solid = obj('PartDesign::Pad', 'OtherPad', []);
    const pad = obj('PartDesign::Pad', 'Pad001', [
      linkProp('Profile', 'Sketch001'),
      enumProp('Type', '3'),
      linkSubProp('UpToFace', 'OtherPad', ['Face1']),
    ]);
    const v = translateObject(pad, (dep) => (dep === 'Sketch001' ? 'sketch0' : undefined), [pad, solid]);
    expect(v).toMatchObject({ kind: 'baked', reason: 'uptoface-solid-face-unsupported' });
  });
});

describe('M4.7 patterns (LinearPattern / PolarPattern)', () => {
  it('translates LinearPattern over a source with axis + spacing', () => {
    const lp = obj('PartDesign::LinearPattern', 'LP', [
      prop('Source', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Direction', { name: 'LinkSub', attrs: { value: 'X_Axis' } }),
      prop('Length', { name: 'Float', attrs: { value: '20' } }),
      prop('Occurrences', { name: 'Integer', attrs: { value: '3' } }),
    ]);
    const v = translateObject(lp, (dep) => (dep === 'Pad' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.linearPattern');
      expect(v.calls[0]!.inputs).toEqual(['part2']);
      // X axis, count 3, spacing = length/(occ-1) = 20/2 = 10
      expect(v.calls[0]!.literals).toEqual([[1, 0, 0], 3, 10]);
    }
  });

  it('bakes LinearPattern referencing an edge direction (unsupported)', () => {
    const lp = obj('PartDesign::LinearPattern', 'LP', [
      prop('Source', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Direction', { name: 'LinkSub', attrs: { value: 'Edge12' } }),
      prop('Length', { name: 'Float', attrs: { value: '20' } }),
      prop('Occurrences', { name: 'Integer', attrs: { value: '3' } }),
    ]);
    const v = translateObject(lp, (dep) => (dep === 'Pad' ? 'part2' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'linear-pattern-edge-dir-unsupported' });
  });

  it('translates PolarPattern over a source around the Z axis', () => {
    const pp = obj('PartDesign::PolarPattern', 'PP', [
      prop('Source', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Axis', { name: 'LinkSub', attrs: { value: 'V_Axis' } }),
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
      prop('Occurrences', { name: 'Integer', attrs: { value: '4' } }),
    ]);
    const v = translateObject(pp, (dep) => (dep === 'Pad' ? 'part2' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.op).toBe('cad.circularPattern');
      expect(v.calls[0]!.inputs).toEqual(['part2']);
      expect(v.calls[0]!.literals).toEqual([[0, 0, 1], 4, 360]);
    }
  });

  it('bakes PolarPattern referencing an edge/vertex axis (unsupported)', () => {
    const pp = obj('PartDesign::PolarPattern', 'PP', [
      prop('Source', { name: 'Link', attrs: { value: 'Pad' } }),
      prop('Axis', { name: 'LinkSub', attrs: { value: 'Vertex1' } }),
      prop('Angle', { name: 'Float', attrs: { value: '360' } }),
      prop('Occurrences', { name: 'Integer', attrs: { value: '4' } }),
    ]);
    const v = translateObject(pp, (dep) => (dep === 'Pad' ? 'part2' : undefined));
    expect(v).toMatchObject({ kind: 'baked', reason: 'polar-pattern-edge-axis-unsupported' });
  });
});

describe('M6.1 Fillet / Chamfer (edge anchors via cad.edgeRef)', () => {
  const base = (target: string, subs: string[]): [string, FcstdProperty] => linkSubProp('Base', target, subs);
  const dep = (d: string): string | undefined => (d === 'Pad001' ? 'part3' : undefined);

  it('translates Fillet into cad.fillet over cad.edgeRef anchors', () => {
    const f = obj('PartDesign::Fillet', 'Fillet', [
      base('Pad001', ['Edge17', 'Edge18']),
      prop('Radius', { name: 'Float', attrs: { value: '4' } }),
    ]);
    const v = translateObject(f, dep);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      const call = v.calls[0]!;
      expect(call.op).toBe('cad.fillet');
      expect(call.inputs).toEqual(['part3']);
      expect(edgeExprs(call)).toEqual(['cad.edgeRef(part3, 17)', 'cad.edgeRef(part3, 18)']);
      expect(call.params['radius']).toBe(4);
    }
  });

  it('translates Chamfer (no ChamferType → Equal distance) with Size as width', () => {
    const c = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Edge11']),
      prop('Size', { name: 'Float', attrs: { value: '1' } }),
    ]);
    const v = translateObject(c, dep);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      const call = v.calls[0]!;
      expect(call.op).toBe('cad.chamfer');
      expect(edgeExprs(call)).toEqual(['cad.edgeRef(part3, 11)']);
      expect(call.params).toMatchObject({ type: 'equal', width: 1 });
    }
  });

  it('translates ChamferType=1 as twoDistances (Size + Size2)', () => {
    const c = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Edge10', 'Edge4']),
      prop('ChamferType', { name: 'Integer', attrs: { value: '1' } }),
      prop('Size', { name: 'Float', attrs: { value: '1' } }),
      prop('Size2', { name: 'Float', attrs: { value: '3' } }),
    ]);
    const v = translateObject(c, dep);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(edgeExprs(v.calls[0]!)).toEqual(['cad.edgeRef(part3, 10)', 'cad.edgeRef(part3, 4)']);
      expect(v.calls[0]!.params).toMatchObject({ type: 'twoDistances', width1: 1, width2: 3 });
    }
  });

  it('translates ChamferType=2 as distanceAngle (Size + Angle in degrees)', () => {
    const c = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Edge7']),
      prop('ChamferType', { name: 'Integer', attrs: { value: '2' } }),
      prop('Size', { name: 'Float', attrs: { value: '2' } }),
      prop('Angle', { name: 'Float', attrs: { value: '30' } }),
    ]);
    const v = translateObject(c, dep);
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') {
      expect(v.calls[0]!.params).toMatchObject({ type: 'distanceAngle', width: 2, angle: 30 });
    }
  });

  it('bakes Chamfer with Angle outside cad.chamfer (0, 90)', () => {
    const c = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Edge7']),
      prop('ChamferType', { name: 'Integer', attrs: { value: '2' } }),
      prop('Size', { name: 'Float', attrs: { value: '2' } }),
      prop('Angle', { name: 'Float', attrs: { value: '90' } }),
    ]);
    expect(translateObject(c, dep)).toMatchObject({ kind: 'baked', reason: 'chamfer-bad-distance-angle' });
  });

  it('bakes UseAllEdges for both Fillet and Chamfer', () => {
    const f = obj('PartDesign::Fillet', 'Fillet', [
      base('Pad001', ['Edge1']),
      prop('Radius', { name: 'Float', attrs: { value: '1' } }),
      prop('UseAllEdges', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    expect(translateObject(f, dep)).toMatchObject({ kind: 'baked', reason: 'fillet-all-edges-unsupported' });
    const c = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Edge1']),
      prop('Size', { name: 'Float', attrs: { value: '1' } }),
      prop('UseAllEdges', { name: 'Bool', attrs: { value: 'true' } }),
    ]);
    expect(translateObject(c, dep)).toMatchObject({ kind: 'baked', reason: 'chamfer-all-edges-unsupported' });
  });

  it('bakes Fillet/Chamfer referencing a non-edge sub-element', () => {
    const f = obj('PartDesign::Fillet', 'Fillet', [
      base('Pad001', ['Face1']),
      prop('Radius', { name: 'Float', attrs: { value: '1' } }),
    ]);
    expect(translateObject(f, dep)).toMatchObject({ kind: 'baked', reason: 'fillet-non-edge-sub' });
    const c = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Vertex1']),
      prop('Size', { name: 'Float', attrs: { value: '1' } }),
    ]);
    expect(translateObject(c, dep)).toMatchObject({ kind: 'baked', reason: 'chamfer-non-edge-sub' });
  });

  it('bakes Fillet/Chamfer with an unresolved base or a bad size', () => {
    const orphan = obj('PartDesign::Fillet', 'Fillet', [
      base('Ghost', ['Edge1']),
      prop('Radius', { name: 'Float', attrs: { value: '1' } }),
    ]);
    expect(translateObject(orphan, dep)).toMatchObject({ kind: 'baked', reason: 'fillet-missing-base' });

    const zeroRadius = obj('PartDesign::Fillet', 'Fillet', [
      base('Pad001', ['Edge1']),
      prop('Radius', { name: 'Float', attrs: { value: '0' } }),
    ]);
    expect(translateObject(zeroRadius, dep)).toMatchObject({ kind: 'baked', reason: 'fillet-bad-radius' });

    const zeroSize = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', ['Edge1']),
      prop('Size', { name: 'Float', attrs: { value: '0' } }),
    ]);
    expect(translateObject(zeroSize, dep)).toMatchObject({ kind: 'baked', reason: 'chamfer-bad-size' });

    const emptySubs = obj('PartDesign::Chamfer', 'Chamfer', [
      base('Pad001', []),
      prop('Size', { name: 'Float', attrs: { value: '1' } }),
    ]);
    expect(translateObject(emptySubs, dep)).toMatchObject({ kind: 'baked', reason: 'chamfer-no-edges' });
  });

  it('whitelists Fillet/Chamfer', () => {
    expect(isWhitelisted('PartDesign::Fillet')).toBe(true);
    expect(isWhitelisted('PartDesign::Chamfer')).toBe(true);
  });
});

// H10 (plan §3.1 correction + §3.5): Python-opaque objects are C4-legitimate
// bakes, decided by PROPERTY presence (App::PropertyPythonObject type attr, or
// Python/Proxy property name) — never by the `Python` type-name suffix alone.
// Before H10 the producer was missing and every Python object fell into the
// `type-not-whitelisted` gap (convert.ts:95-97 rename consumer was dead code).
describe('H10 python-opaque verdict (property-based)', () => {
  // local dep: these Python objects reference nothing translatable
  const dep = (d: string): string | undefined => (d === 'Pad001' ? 'part3' : undefined);

  function pythonProp(name: string, attrType: string): [string, FcstdProperty] {
    return [
      name,
      {
        name,
        type: attrType,
        tagName: 'Property',
        children: [],
        valueXml: name === 'Proxy' ? '<Python module="foo" class="Bar"/>' : undefined,
        valueText: '',
        attributes: {},
      },
    ];
  }

  it('GOTCHA: Part::FeaturePython carries PropertyPythonObject → baked python-opaque, NOT type-not-whitelisted', () => {
    const o = obj('Part::FeaturePython', 'Legacy', [
      pythonProp('Proxy', 'App::PropertyPythonObject'),
    ]);
    expect(translateObject(o, dep)).toMatchObject({ kind: 'baked', reason: 'python-opaque' });
  });

  it('type name ending in Python but WITHOUT the property is still a plain gap (suffix alone never qualifies)', () => {
    const o = obj('Some::FeaturePython', 'Suspicious', [
      prop('Length', { name: 'Float', attrs: { value: '1' } }),
    ]);
    const r = translateObject(o, dep);
    expect(r.kind).toBe('baked');
    if (r.kind === 'baked') expect(r.reason).toContain('type-not-whitelisted');
  });

  it('Proxy property with non-PythonObject storage type also qualifies (FreeCAD saves Proxy as App::PropertyPythonObject; older files may differ)', () => {
    const o = obj('App::FeaturePython', 'Dyn', [pythonProp('Proxy', '')]);
    expect(translateObject(o, dep)).toMatchObject({ kind: 'baked', reason: 'python-opaque' });
  });

  it('V-C6 no free ride: a whitelisted Part::Box WITH a stray Proxy property stays translated', () => {
    const o = obj('Part::Box', 'Box', [
      prop('Length', { name: 'Float', attrs: { value: '30' } }),
      prop('Width', { name: 'Float', attrs: { value: '20' } }),
      prop('Height', { name: 'Float', attrs: { value: '10' } }),
      pythonProp('Proxy', 'App::PropertyPythonObject'),
    ]);
    expect(translateObject(o, dep)).toMatchObject({ kind: 'translated' });
  });
});

// H7 first cut (2026-09-20 corpus probe): Part::Feature in the 56-sample
// corpus is ALWAYS a pure Shape carrier — property surface is Shape
// (+ShapeMaterial) only, geometry lives in the ZIP's .brp member
// (`file="Face005.Shape.brp"`). There is no parameter semantics to
// translate; the shape is an existing fact delivered via assets/.
// Contract: translateObject with a shape-bearing signal → translated
// (no cad calls, reason 'shape-asset'); without it → explicit gap
// (never a silent bake).
describe('H7 Part::Feature pure-Shape carrier', () => {
  const dep = (): string | undefined => undefined;

  function shapeCarrier(name: string, withMaterial = false): FcstdObject {
    const shape = prop('Shape', { name: 'Part', attrs: { file: `${name}.Shape.brp` } });
    return obj('Part::Feature', name, withMaterial ? [shape, prop('ShapeMaterial', { name: 'Mat', attrs: {} })] : [shape]);
  }

  it('GOTCHA: Part::Feature with a Shape property → translated via cad.import_brep (shape delivered via assets/, addressable variable)', () => {
    const r = translateObject(shapeCarrier('Face005'), dep, undefined, new Set(['Face005']));
    expect(r).toMatchObject({ kind: 'translated', reason: 'shape-asset' });
    // 2026-09-20 update: the asset became an addressable solid — one real
    // load call (was: zero calls; downstream consumers could not resolve the
    // variable and gapped with cut-missing-dependency).
    // 2026-09-21 GOTCHA: the op was a made-up `cad.import_shape` (absent from
    // the cad namespace) until the run-level check caught it; it now emits the
    // platform `cad.import_brep` op (asset = extension-less .brp name).
    if (r.kind === 'translated') {
      expect(r.calls.length).toBe(1);
      expect(r.calls[0]!.op).toBe('cad.import_brep');
      expect(r.calls[0]!.params).toEqual({ asset: 'Face005.Shape' });
    }
  });

  it('Part::Feature WITHOUT shape evidence → explicit gap, never silent bake', () => {
    const bare = obj('Part::Feature', 'Ghost', []);
    const r = translateObject(bare, dep, undefined, new Set());
    expect(r.kind).toBe('baked');
    if (r.kind === 'baked') expect(r.reason).toContain('shape-asset-missing');
  });

  it('works for both plain and ShapeMaterial variants (corpus shapes 41× / 29×)', () => {
    for (const carrier of [shapeCarrier('Face001'), shapeCarrier('Face002', true)]) {
      const r = translateObject(carrier, dep, undefined, new Set([carrier.name]));
      expect(r).toMatchObject({ kind: 'translated', reason: 'shape-asset' });
    }
  });

  it('GOTCHA (Body-less CAM corpus 2026-09-20): a feature with SubShape cache evidence → shape-asset (result cache, no cad calls)', () => {
    // Body-less PartDesign files (motor_mount_inch etc.) carry SubShape
    // result caches on their Pockets — the pocketed geometry already exists
    // as a .brp member. shape-asset beats an honest-but-useless
    // pocket-missing-dependency gap.
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('Type', { name: 'String', attrs: { value: 'ThroughAll' } }),
      prop('SubShape', { name: 'Part', attrs: { file: 'PartShape5.brp' } }),
    ]);
    const r = translateObject(pocket, () => undefined, undefined, new Set(['Pocket']));
    expect(r).toMatchObject({ kind: 'translated', reason: 'shape-asset' });
    if (r.kind === 'translated') {
      // 2026-09-20 update: the result cache is an addressable solid —
      // a real load call (was: zero calls; consumers could not resolve
      // the variable and gapped with fillet-missing-base).
      expect(r.calls.length).toBe(1);
      expect(r.calls[0]!.op).toBe('cad.import_brep');
      expect(r.calls[0]!.params).toEqual({ asset: 'PartShape5' });
    }
  });

  it('GOTCHA: a Shape-carrier WITHOUT SubShape (e.g. a Pad) is NOT hijacked into shape-asset — normal translation path applies', () => {
    // Pads also carry a Shape property in Body-less files; only SubShape
    // (the feature's own result cache) qualifies as shape-asset evidence.
    const pad = obj('PartDesign::Pad', 'Pad', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch' } }),
      prop('Length', { name: 'Float', attrs: { value: '10' } }),
      prop('Shape', { name: 'Part', attrs: { file: 'PartShape1.brp' } }),
    ]);
    const r = translateObject(pad, (d) => (d === 'Sketch' ? 'sketch0' : undefined), undefined, new Set(['Pad']));
    expect(r.kind).toBe('translated');
    if (r.kind === 'translated') {
      expect(r.reason).not.toBe('shape-asset');
      expect(r.calls.length).toBeGreaterThan(0);
    }
  });

  it('SubShape evidence ABSENT from the carriers set → normal path (Pocket still gaps on missing base)', () => {
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('SubShape', { name: 'Part', attrs: { file: 'Ghost.brp' } }),
    ]);
    const r = translateObject(pocket, () => undefined, undefined, new Set());
    expect(r).toMatchObject({ kind: 'baked', reason: 'pocket-missing-dependency' });
  });

  it('GOTCHA (ArchDetail 2026-09-20): a NON-whitelisted type with a Shape asset resolves to shape-asset import, not a gap', () => {
    // Draft wires (Part::Part2DObjectPython) as Compound members carry real
    // Shape .brp members — same "geometry is an existing fact" rationale as
    // H7 Part::Feature. Whitelisted types (Box/Pad…) are unaffected: they
    // keep the normal translation path.
    const wire = obj('Part::Part2DObjectPython', 'Wire045', [
      prop('Shape', { name: 'Part', attrs: { file: 'Wire045.Shape.brp' } }),
    ]);
    const r = translateObject(wire, () => undefined, undefined, new Set(['Wire045']));
    expect(r).toMatchObject({ kind: 'translated', reason: 'shape-asset' });
    if (r.kind === 'translated') {
      expect(r.calls[0]!.op).toBe('cad.import_brep');
      expect(r.calls[0]!.params).toEqual({ asset: 'Wire045.Shape' });
    }
    // whitelisted type stays on the normal path (no hijack)
    const box = obj('Part::Box', 'Box', [prop('Shape', { name: 'Part', attrs: { file: 'Box.brp' } })]);
    const rb = translateObject(box, () => undefined, undefined, new Set(['Box']));
    expect(rb.kind).toBe('translated');
    if (rb.kind === 'translated') expect(rb.reason).not.toBe('shape-asset');
  });

  it('GOTCHA (EngineBlock 2026-09-20): Shape-asset evidence PRECEDES python-opaque — a Proxy-bearing Draft circle with a Shape asset imports, not bakes', () => {
    // Draft circles carry Proxy (python-opaque evidence) AND a real Shape
    // .brp member. python-opaque baked them silently, downstream
    // Part::Extrusion got no variable → extrusion-missing-base. The asset
    // check must run first: geometry is an existing fact.
    const circle = obj('Part::Part2DObjectPython', 'Circle003', [
      prop('Proxy', { name: 'PythonObject', attrs: {} }),
      prop('Shape', { name: 'Part', attrs: { file: 'Circle003.Shape.brp' } }),
    ]);
    const r = translateObject(circle, () => undefined, undefined, new Set(['Circle003']));
    expect(r).toMatchObject({ kind: 'translated', reason: 'shape-asset' });
  });

  it('GOTCHA (hole_puzzle 2026-09-20): a shape-asset feature is a REAL variable — consumers (Fillet Base→Pocket) must resolve it', () => {
    // codegen registers variables only from calls (or non-identity
    // placements); a zero-call shape-asset object had NO variable, so a
    // downstream Fillet with Base→Pocket gapped fillet-missing-base even
    // though the dependency exists. The verdict must emit a real
    // cad.import_brep call so the asset becomes an addressable solid.
    const pocket = obj('PartDesign::Pocket', 'Pocket', [
      prop('Profile', { name: 'Link', attrs: { value: 'Sketch001' } }),
      prop('SubShape', { name: 'Part', attrs: { file: 'PartShape5.brp' } }),
    ]);
    const r = translateObject(pocket, () => undefined, undefined, new Set(['Pocket']));
    expect(r).toMatchObject({ kind: 'translated', reason: 'shape-asset' });
    if (r.kind === 'translated') {
      expect(r.calls.length).toBe(1);
      expect(r.calls[0]!.op).toBe('cad.import_brep');
      // source carries the object identity; asset is the .brp member's
      // extension-less name (the asset resolver's directory-mode key rule)
      expect(r.calls[0]!.source).toBe('Pocket');
      expect(r.calls[0]!.params).toEqual({ asset: 'PartShape5' });
    }
  });
});
