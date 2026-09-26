/**
 * M5 tests — dependency ordering (M5.1), code lowering (M5.2), statement
 * ids sN / variables partN, multi-root grouping, and M6 sketch→cad.profile
 * wiring (Pad/Pocket become real cad.extrude / cad.subtract calls).
 */
import { describe, it, expect } from 'vitest';
import { generateModel } from './codegen.js';
import type { Contour } from '@faicad/faijs-sketch';
import type { FcstdDocument, FcstdObject, FcstdProperty } from './document.js';

function simpleObj(type: string, name: string, props: Record<string, Record<string, string>> = {}): FcstdObject {
  const properties = new Map(
    Object.entries(props).map(([k, attrs]) => [
      k,
      {
        name: k,
        type: '',
        tagName: 'Property',
        children: [{ name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: attrs }],
        valueXml: '',
        valueText: '',
        attributes: {},
      } as never,
    ]),
  );
  return { type, name, properties };
}

/** An App::PropertyLinkSub (with `<Sub>` children) as FreeCAD saves it. */
function withLinkSub(obj: FcstdObject, name: string, target: string, subs: string[]): FcstdObject {
  const linkSub: FcstdProperty = {
    name: 'LinkSub',
    type: '',
    tagName: 'LinkSub',
    children: subs.map((s) => ({
      name: 'Sub', type: '', tagName: 'Sub', children: [], valueXml: '', valueText: '', attributes: { value: s },
    })),
    valueXml: '',
    valueText: '',
    attributes: { value: target, count: String(subs.length) },
  };
  obj.properties.set(name, {
    name, type: 'App::PropertyLinkSub', tagName: 'Property',
    children: [linkSub], valueXml: '', valueText: '', attributes: {},
  });
  return obj;
}

/** An App::PropertyLinkList (`<LinkList><Link value=…/>…`) as FreeCAD saves it. */
function withLinkList(type: string, name: string, prop: string, members: string[]): FcstdObject {
  const o = simpleObj(type, name, {});
  o.properties.set(prop, {
    name: prop, type: 'App::PropertyLinkList', tagName: 'Property',
    children: [{
      name: prop, type: '', tagName: 'LinkList',
      children: members.map((m) => ({
        name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: m },
      })),
      valueXml: '', valueText: '', attributes: { count: String(members.length) },
    }],
    valueXml: '', valueText: '', attributes: {},
  });
  return o;
}

/** A unit square contour (closed loop of 4 lines) used for sketch wiring. */
function square(): Contour[] {
  return [{
    closed: true,
    segments: [
      { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
      { kind: 'line', x1: 10, y1: 10, x2: 0, y2: 10 },
      { kind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
    ],
  }];
}

/** Empty contour map (no sketch wired). */
const NO_CONTOURS = new Map<string, Contour[]>();

describe('M5 codegen', () => {
  it('orders Box → Cut in dependency order and lowers to sN/partN', () => {
    const doc: FcstdDocument = {
      objects: [
        // deliberately out of dependency order: Cut first
        simpleObj('Part::Cut', 'Cut', { Base: { value: 'Box' }, Tool: { value: 'Cyl' } }),
        simpleObj('Part::Box', 'Box', {}),
        simpleObj('Part::Cylinder', 'Cyl', {}),
        simpleObj('App::Origin', 'Origin', {}),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const result = generateModel(doc, new Map(), NO_CONTOURS, 'test');
    expect(result.calls.map((c) => c.op)).toEqual(['cad.box', 'cad.cylinder', 'cad.subtract']);
    expect(result.calls[2]!.inputs).toEqual(['part0', 'part1']);
    expect(result.code).toContain('let part0 = cad.box(');
    expect(result.code).toContain('s0');
    expect(result.code).toContain('part2');
    // Origin preserved-only
    const origin = result.objects.find((o) => o.name === 'Origin');
    expect(origin).toMatchObject({ disposition: 'preserved-only' });
  });

  it('bakes sketches without verdicts/contours; wires them to cad.profile when solved', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    // no verdict, no contours → sketch baked, Pad can't resolve profile → baked
    const r1 = generateModel(doc, new Map(), NO_CONTOURS, 't');
    const pad1 = r1.objects.find((o) => o.name === 'Pad');
    expect(pad1).toMatchObject({ disposition: 'baked' });

    // L0 verdict + contours → sketch emits cad.profile, Pad resolves the
    // profile face and becomes a real cad.extrude call (M6 wiring).
    const r2 = generateModel(
      doc,
      new Map([['Sketch', { level: 'L0', loopCount: 1 }]]),
      new Map([['Sketch', square()]]),
      't',
    );
    const sketch2 = r2.objects.find((o) => o.name === 'Sketch');
    expect(sketch2).toMatchObject({ disposition: 'translated' });
    const pad2 = r2.objects.find((o) => o.name === 'Pad');
    expect(pad2).toMatchObject({ disposition: 'translated' });
    expect(r2.code).toContain('cad.profile');
    expect(r2.code).toContain('cad.extrude');
    // 分层红线：FCStd 链路一律落 cad.extrude（up-to 亦在平台 op 上）。历史上
    // 曾把 up-to 落到已废弃的 cad.fai_extrude 路线（M4.6 明确废弃），这条断言
    // 就是防它回流。
    expect(r2.code).not.toContain('cad.fai_extrude');
  });

  // GOTCHA (P3-4, Slab adjustable scaffolder 2026-09-24): an L0 verdict with
  // ZERO extracted contours (solve succeeded, dangling segments → no closed
  // loop) used to fall into the `sketch-not-solved` fallback — a lie about
  // the cause (the solver was fine). It must bake with the explicit
  // `sketch-solved-no-closed-loop` reason instead.
  it('bakes an L0 sketch with no closed loop as sketch-solved-no-closed-loop (not sketch-not-solved)', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    // L0 verdict but empty contours map entry (extractContours returned 0 loops)
    const r = generateModel(
      doc,
      new Map([['Sketch', { level: 'L0' as const, loopCount: 0 }]]),
      new Map([['Sketch', []]]),
      't',
    );
    const sketch = r.objects.find((o) => o.name === 'Sketch');
    expect(sketch).toMatchObject({ disposition: 'baked', reason: 'sketch-solved-no-closed-loop' });
  });

  it('groups multiple roots via cad.compound', () => {
    const doc: FcstdDocument = {
      objects: [simpleObj('Part::Box', 'A', {}), simpleObj('Part::Box', 'B', {})],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    expect(r.code).toContain('cad.compound({ members: [part0, part1] })');
  });

  it('emits Pad + Pocket as real cad.extrude / cad.subtract when sketch contours are wired', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
        simpleObj('Sketcher::SketchObject', 'Sketch001', {}),
        simpleObj('PartDesign::Pocket', 'Pocket', { Profile: { value: 'Sketch001' }, BaseFeature: { value: 'Pad' }, Length: { value: '5' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const verdicts = new Map([
      ['Sketch', { level: 'L0' as const, loopCount: 1 }],
      ['Sketch001', { level: 'L0' as const, loopCount: 1 }],
    ]);
    const contours = new Map([
      ['Sketch', square()],
      ['Sketch001', square()],
    ]);
    const r = generateModel(doc, verdicts, contours, 't');
    const sketch = r.objects.find((o) => o.name === 'Sketch');
    const sketch001 = r.objects.find((o) => o.name === 'Sketch001');
    const pad = r.objects.find((o) => o.name === 'Pad');
    const pocket = r.objects.find((o) => o.name === 'Pocket');
    expect(sketch).toMatchObject({ disposition: 'translated' });
    expect(sketch001).toMatchObject({ disposition: 'translated' });
    expect(pad).toMatchObject({ disposition: 'translated' });
    expect(pocket).toMatchObject({ disposition: 'translated' });
    // both sketches become faces; Pad extrudes, Pocket extrudes+cuts
    expect(r.code).toContain('cad.profile');
    expect(r.code).toContain('cad.extrude');
    expect(r.code).toContain('cad.subtract');
    expect(r.code).not.toContain('cad.fai_extrude');
  });

  it('renders JsExpr edge anchors verbatim for Fillet/Chamfer (M6.1)', () => {
    const fillet = withLinkSub(
      simpleObj('PartDesign::Fillet', 'Fillet', { Radius: { value: '4' } }),
      'Base', 'Box', ['Edge17', 'Edge18'],
    );
    const doc: FcstdDocument = {
      objects: [simpleObj('Part::Box', 'Box', {}), fillet],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    const f = r.objects.find((o) => o.name === 'Fillet');
    expect(f).toMatchObject({ disposition: 'translated' });
    // the edge refs must survive as live calls against the base variable,
    // not as JSON-encoded literals.
    expect(r.code).toContain('let part1 = cad.fillet(part0, { edges: [cad.edgeRef(part0, 17), cad.edgeRef(part0, 18)], radius: 4 });');
    expect(r.code).not.toContain('"__jsExpr"');
  });

  it('keeps plain array params byte-identical (no JsExpr present)', () => {
    const doc: FcstdDocument = {
      objects: [simpleObj('Part::Box', 'A', {}), simpleObj('Part::Box', 'B', {})],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    expect(r.code).toContain('cad.compound({ members: [part0, part1] })');
  });

  // GOTCHA: renderArgs used to emit `cad.profile(, { ... })` for calls with no
  // positional args (inputs+literals empty) — a leading comma → SyntaxError.
  // Correct form: named-only params render as the first argument, no comma.
  it('emits no leading comma for calls with only named params (M7.1b)', () => {
    const doc: FcstdDocument = {
      objects: [simpleObj('Sketcher::SketchObject', 'Sketch', {})],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc,
      new Map([['Sketch', { level: 'L0' as const, loopCount: 1 }]]),
      new Map([['Sketch', square()]]),
      't',
    );
    expect(r.code).toContain('cad.profile({ contours:');
    expect(r.code).not.toContain('(, ');
  });

  // M9.4 (D-C): features inside one Body fuse cumulatively in Body.Group
  // order — Pad unions onto the chain, Pocket subtracts from it. Product
  // aggregation (cad.compound) must NOT appear for a single Body's chain.
  it('chains same-Body features via union/subtract, no aggregation (M9.4)', () => {
    const body = simpleObj('PartDesign::Body', 'Body');
    body.properties.set('Group', {
      name: 'Group', type: 'App::PropertyLinkList', tagName: 'Property',
      // real FCStd shape: Property > LinkList > Link*
      children: [{
        name: 'LinkList', type: '', tagName: 'LinkList',
        children: [
          { name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: 'Pad' } },
          { name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: 'Pocket' } },
          { name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: 'Pad001' } },
        ],
        valueXml: '', valueText: '', attributes: { count: '3' },
      }],
      valueXml: '', valueText: '', attributes: {},
    });
    const doc: FcstdDocument = {
      objects: [
        body,
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
        simpleObj('Sketcher::SketchObject', 'Sketch001', {}),
        simpleObj('PartDesign::Pocket', 'Pocket', { Profile: { value: 'Sketch001' }, BaseFeature: { value: 'Pad' }, Length: { value: '5' } }),
        simpleObj('Sketcher::SketchObject', 'Sketch002', {}),
        simpleObj('PartDesign::Pad', 'Pad001', { Profile: { value: 'Sketch002' }, BaseFeature: { value: 'Pocket' }, Length: { value: '3' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const verdicts = new Map([
      ['Sketch', { level: 'L0' as const, loopCount: 1 }],
      ['Sketch001', { level: 'L0' as const, loopCount: 1 }],
      ['Sketch002', { level: 'L0' as const, loopCount: 1 }],
    ]);
    const contours = new Map([
      ['Sketch', square()],
      ['Sketch001', square()],
      ['Sketch002', square()],
    ]);
    const r = generateModel(doc, verdicts, contours, 't');
    // Exactly 2 chain-level ops, no double-subtract: Pocket's own subtract
    // (base − cut, BaseFeature resolved to the chain head) advances the chain,
    // then Pad001 unions onto the new head. The Pocket base feature does NOT
    // get a second cad.subtract against the chain.
    const chainOps = r.calls.filter((c) => (c.op === 'cad.union' || c.op === 'cad.subtract') && !c.out.includes('__'));
    expect(chainOps.map((c) => c.op)).toEqual(['cad.subtract', 'cad.union']);
    // Pad001's union consumes the Pocket output (chain head), not the raw Pad
    const pocketOut = chainOps[0]!.out;
    expect(chainOps[1]!.inputs).toContain(pocketOut);
    expect(r.code).not.toContain('cad.compound({ members: [part0');
  });

  // M10.3: two Bodies with geometry → one file per Body + aggregate main
  // referencing <Body>_out terminals via cad.compound.
  it('splits multi-Body models into per-Body files + aggregate main (M10.3)', () => {
    const mkBody = (name: string, members: string[]): FcstdObject => {
      const b = simpleObj('PartDesign::Body', name);
      b.properties.set('Group', {
        name: 'Group', type: 'App::PropertyLinkList', tagName: 'Property',
        children: [{
          name: 'LinkList', type: '', tagName: 'LinkList',
          children: members.map((m) => ({
            name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: m },
          })),
          valueXml: '', valueText: '', attributes: { count: String(members.length) },
        }],
        valueXml: '', valueText: '', attributes: {},
      });
      return b;
    };
    const doc: FcstdDocument = {
      objects: [
        mkBody('Body', ['Pad']),
        mkBody('Body001', ['Pad001']),
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
        simpleObj('Sketcher::SketchObject', 'Sketch001', {}),
        simpleObj('PartDesign::Pad', 'Pad001', { Profile: { value: 'Sketch001' }, Length: { value: '5' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const verdicts = new Map([
      ['Sketch', { level: 'L0' as const, loopCount: 1 }],
      ['Sketch001', { level: 'L0' as const, loopCount: 1 }],
    ]);
    const contours = new Map([
      ['Sketch', square()],
      ['Sketch001', square()],
    ]);
    const r = generateModel(doc, verdicts, contours, 't');
    expect(r.files.length).toBe(2);
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual(['model/Body.fai.js', 'model/Body001.fai.js']);
    for (const f of r.files) {
      expect(f.code).toContain(`let ${f.body}_out =`);
    }
    // M10c: aggregate entry imports each Body's terminal via the standard
    // relative-import contract, then groups them
    expect(r.code).toContain(`import { Body_out } from './Body.fai.js';`);
    expect(r.code).toContain(`import { Body001_out } from './Body001.fai.js';`);
    expect(r.code).toContain('let part_out = cad.compound({ members: [Body_out, Body001_out] });');
    expect(r.rootVar).toBe('part_out');
  });

  // M10.5: loose Part features (no Body) stay in main.fai.js even when
  // Bodies exist.
  it('keeps loose non-Body features in main alongside the aggregate (M10.5)', () => {
    const mkBody = (name: string, members: string[]): FcstdObject => {
      const b = simpleObj('PartDesign::Body', name);
      b.properties.set('Group', {
        name: 'Group', type: 'App::PropertyLinkList', tagName: 'Property',
        children: [{
          name: 'LinkList', type: '', tagName: 'LinkList',
          children: members.map((m) => ({
            name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: m },
          })),
          valueXml: '', valueText: '', attributes: { count: String(members.length) },
        }],
        valueXml: '', valueText: '', attributes: {},
      });
      return b;
    };
    const doc: FcstdDocument = {
      objects: [
        mkBody('Body', ['Pad']),
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
        simpleObj('Part::Box', 'LooseBox', {}),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc,
      new Map([['Sketch', { level: 'L0' as const, loopCount: 1 }]]),
      new Map([['Sketch', square()]]),
      't',
    );
    expect(r.files.length).toBe(1);
    expect(r.files[0]!.path).toBe('model/Body.fai.js');
    // LooseBox call remains in main
    expect(r.code).toContain('cad.box');
  });

  // GOTCHA (test_geomop corpus, 2026-09-20): a Part::Cut whose Tool is a
  // PartDesign::Body container — the dependency resolver used to look only
  // at `variables`, which never holds a Body name (Body results live in
  // chainVar), so the Cut gapped with cut-missing-dependency even though
  // both Base and Tool were translatable.
  it('resolves a dependency on a Body container against its chain head', () => {
    const mkBody = (name: string, members: string[]): FcstdObject => {
      const b = simpleObj('PartDesign::Body', name);
      b.properties.set('Group', {
        name: 'Group', type: 'App::PropertyLinkList', tagName: 'Property',
        children: [{
          name: 'LinkList', type: '', tagName: 'LinkList',
          children: members.map((m) => ({
            name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: m },
          })),
          valueXml: '', valueText: '', attributes: { count: String(members.length) },
        }],
        valueXml: '', valueText: '', attributes: {},
      });
      return b;
    };
    const doc: FcstdDocument = {
      objects: [
        mkBody('Body', ['Pad']),
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
        simpleObj('Part::Box', 'Box', {}),
        simpleObj('Part::Cut', 'Cut', { Base: { value: 'Box' }, Tool: { value: 'Body' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc,
      new Map([['Sketch', { level: 'L0' as const, loopCount: 1 }]]),
      new Map([['Sketch', square()]]),
      't',
    );
    const cut = r.calls.find((c) => c.source === 'Cut');
    expect(cut, 'Cut must translate, not gap').toBeDefined();
    expect(cut!.op).toBe('cad.subtract');
    // the Tool input resolves to the Body's chain head variable
    expect(cut!.inputs.length).toBe(2);
    expect(cut!.inputs[1]).not.toBe('Body');
  });

  // GOTCHA (EngineBlock corpus, 2026-09-20): a Part::Extrusion whose Base is
  // a Draft circle (Part::Part2DObjectPython with a Shape asset) — the
  // shape-asset import makes the base an addressable variable and the
  // Extrusion must lower to cad.extrude, not gap.
  it('lowers Part::Extrusion over a shape-asset Draft base', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Part::Part2DObjectPython', 'Circle003', { Shape: { file: 'Circle003.Shape.brp' } }),
        simpleObj('Part::Extrusion', 'Extrude', { Base: { value: 'Circle003' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't', undefined, new Set(['Circle003']));
    const ext = r.calls.find((c) => c.source === 'Extrude');
    expect(ext, 'Extrude must translate, not gap').toBeDefined();
    expect(ext!.op).toBe('cad.extrude');
    expect(ext!.inputs[0]).not.toBe('Circle003'); // resolved to a partN var
  });

  // GOTCHA (ArchDetail corpus, 2026-09-21): `Links` is an App::PropertyLinkList
  // and Part::Compound's member list. It was absent from depsOf(), so a
  // Compound carried NO ordering edge to its members. ArchDetail declares all
  // five compounds at doc index 10-14 and every member at 269+ (FreeCAD sorts
  // the file by object name, not by build order), so every compound ran before
  // its members, inputVar() found nothing and the whole file gapped with
  // `compound-missing-members` — a pure ordering bug, no missing capability.
  it('orders Part::Compound after its Links members even when declared first', () => {
    const doc: FcstdDocument = {
      objects: [
        withLinkList('Part::Compound', 'Compound', 'Links', ['Box1', 'Box2']),
        simpleObj('Part::Box', 'Box1', {}),
        simpleObj('Part::Box', 'Box2', {}),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    expect(r.calls.map((c) => c.op)).toEqual(['cad.box', 'cad.box', 'cad.compound']);
    const compound = r.calls[2]!;
    expect(compound.source).toBe('Compound');
    expect(compound.inputs).toEqual([r.calls[0]!.out, r.calls[1]!.out]);
    // inputs are a dependency registration only — the op is called with named
    // params, so they must not be rendered positionally (noPositionalArgs).
    expect(compound.noPositionalArgs).toBe(true);
    expect(r.code).toContain('cad.compound({ members: [');
    expect(r.objects.find((o) => o.name === 'Compound')!.disposition).toBe('translated');
  });

  // ArchDetail's actual member shape: Draft wires (Part::Part2DObjectPython)
  // carrying a real Shape .brp — non-whitelisted, so they lower to a real
  // `cad.import_brep` of the frozen BREP asset. The compound must consume those
  // variables, which only works once the Links edge exists.
  it('ArchDetail shape: compound over shape-asset Draft wires lowers to cad.compound', () => {
    const doc: FcstdDocument = {
      objects: [
        withLinkList('Part::Compound', 'Compound006', 'Links', ['Wire045', 'Wire046']),
        simpleObj('Part::Part2DObjectPython', 'Wire045', { Shape: { file: 'Wire045.Shape.brp' } }),
        simpleObj('Part::Part2DObjectPython', 'Wire046', { Shape: { file: 'Wire046.Shape.brp' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't', undefined, new Set(['Wire045', 'Wire046']));
    const imports = r.calls.filter((c) => c.op === 'cad.import_brep');
    expect(imports.length).toBe(2);
    // GOTCHA: the asset key follows the container's directory-mode rule
    // (basename without extension). No `format` hint and no `allowNonSolid`
    // switch — the platform import op goes straight to the OCCT kernel and
    // treats non-solid topology as first-class (C6).
    expect(imports[0]!.params).toEqual({ asset: 'Wire045.Shape' });
    const compound = r.calls.find((c) => c.source === 'Compound006')!;
    expect(compound.op).toBe('cad.compound');
    expect(compound.inputs.length).toBe(2);
    expect(compound.inputs.every((i) => /^part\d+$/.test(i))).toBe(true);
    expect(r.calls.indexOf(compound)).toBe(r.calls.length - 1);
  });

  // C6 (non-solid first-class, 2026-09-21): the frozen asset of a Draft wire is
  // a wireframe, not a solid. The lowering used to read the asset TEXT at
  // conversion time (`brepTextHasSolid`) and emit `allowNonSolid: true` for
  // those 346-of-698 sites — a per-asset switch at the *import* site. The
  // platform import op needs no such switch: it always imports non-solid
  // topology, and ops that genuinely require a solid fail at the USE site.
  // The point of this test is that the wire and the solid lower IDENTICALLY:
  // a leftover probe or format hint on one of them fails here.
  it('lowers wire and solid frozen assets identically — no per-asset non-solid switch', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Part::Part2DObjectPython', 'Wire045', { Shape: { file: 'Wire045.Shape.brp' } }),
        simpleObj('Part::Part2DObjectPython', 'Structure119', { Shape: { file: 'Structure119.Shape.brp' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc, new Map(), NO_CONTOURS, 't', undefined,
      new Set(['Wire045', 'Structure119']),
    );
    const imports = r.calls.filter((c) => c.op === 'cad.import_brep');
    expect(imports.length).toBe(2);
    const wire = imports.find((c) => c.source === 'Wire045')!;
    const solid = imports.find((c) => c.source === 'Structure119')!;
    expect(wire.params).toEqual({ asset: 'Wire045.Shape' });
    expect(solid.params).toEqual({ asset: 'Structure119.Shape' });
    expect(r.code).not.toContain('allowNonSolid');
    expect(r.code).not.toContain("format: 'brep'");
  });

  // GOTCHA (PadTest, 2026-09-21): a Body's `Model` list contains its datum
  // planes, and a `PartDesign::Plane` stores a `Shape` .brp — the plane FACE,
  // not a solid. The "any object with shape evidence is a shape asset" rule
  // therefore imported the datum and folded it into the Body chain
  // (`cad.union(pad, datumPlane)`), which is both semantically wrong and fatal
  // at the use site: a bare datum-plane face cannot take part in a boolean.
  // Datum and
  // container types must be short-circuited to preserved-only BEFORE the
  // translator, and the Body's own Shape asset must not be imported either.
  it('datum planes and Bodies never become shape assets nor enter the Body chain', () => {
    const mkBody = (name: string, members: string[]): FcstdObject => {
      const b = simpleObj('PartDesign::Body', name, { Shape: { file: 'PartShape6.brp' } });
      b.properties.set('Group', {
        name: 'Group', type: 'App::PropertyLinkList', tagName: 'Property',
        children: [{
          name: 'LinkList', type: '', tagName: 'LinkList',
          children: members.map((m) => ({
            name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: m },
          })),
          valueXml: '', valueText: '', attributes: { count: String(members.length) },
        }],
        valueXml: '', valueText: '', attributes: {},
      });
      return b;
    };
    const doc: FcstdDocument = {
      objects: [
        mkBody('Body', ['Pad', 'DatumPlane']),
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
        simpleObj('PartDesign::Plane', 'DatumPlane', { Shape: { file: 'PartShape7.brp' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc,
      new Map([['Sketch', { level: 'L0' as const, loopCount: 1 }]]),
      new Map([['Sketch', square()]]),
      't',
      undefined,
      new Set(['Body', 'DatumPlane']), // both carry a .brp in the container
    );
    expect(r.calls.filter((c) => c.op === 'cad.import_brep'), 'no datum/container import').toEqual([]);
    // the Pad is the chain base; with the datum excluded there is nothing to
    // union it with
    expect(r.calls.filter((c) => c.op === 'cad.union' || c.op === 'cad.subtract')).toEqual([]);
    expect(r.objects.find((o) => o.name === 'DatumPlane')!.disposition).toBe('preserved-only');
    expect(r.objects.find((o) => o.name === 'Body')!.disposition).toBe('preserved-only');
  });

  // GOTCHA (H13 REVISED, Beds.FCStd 2026-09-26): the old rule skipped
  // `cad.place` for shape-asset objects (TO92 looked pre-placed). Beds'
  // root Sections save the .brp in the LOCAL frame — skipping place left
  // them at the origin (solids 10vs6, bbox z 2850 vs 450). The truth tool
  // applies the Placement exactly once for every object, so codegen must
  // ALWAYS re-emit `cad.place` for a non-identity Placement, shape asset
  // or not. Pinned here against regression.
  it('shape-asset object with non-identity Placement emits cad.place (H13 revised, Beds)', () => {
    const doc: FcstdDocument = {
      objects: [
        // pure-Shape carrier imported via cad.import_brep, carrying a placed
        // Placement (like Beds' root Sections: translation-only offset)
        simpleObj('Part::Feature', 'Cut001', { Shape: { file: 'Cut001.Shape.brp' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc,
      new Map(),
      NO_CONTOURS,
      't',
      // non-identity placement on the object — must surface as cad.place
      new Map([['Cut001', { p: [0, 0, 2.8] as [number, number, number], q: [0, 0, 0.7071067811865476, 0.7071067811865476] as [number, number, number, number] }]]),
      new Set(['Cut001']),
    );
    expect(r.calls.filter((c) => c.op === 'cad.import_brep').length).toBe(1);
    const places = r.calls.filter((c) => c.op === 'cad.place');
    expect(places.length, 'non-identity Placement must emit exactly one cad.place').toBe(1);
    expect(places[0]!.params.position).toEqual([0, 0, 2.8]);
  });

  // GOTCHA (2026-09-25, A1 mirror E_OP_FAILED / A3 revolve REVOLVE_FAILED):
  // `cad.mirror(input, options)` and `cad.revolve(input, options)` take the
  // SOURCE SHAPE as a POSITIONAL argument. The translate branch must NOT set
  // `noPositionalArgs` — that flag is only valid for zero-positional-input ops
  // (e.g. cad.compound({ members })). Setting it made renderArgs drop
  // inputs[0], emitting `cad.mirror({ normal, at })` with no geometry →
  // E_OP_FAILED / REVOLVE_FAILED at run time. The source must stay positional.
  it('Part::Mirroring lowers to cad.mirror(<input>, { normal, at }) with the source as a positional arg', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Part::Box', 'Box', {}),
        simpleObj('Part::Mirroring', 'Mir', {
          Source: { value: 'Box' },
          Base: { valueX: '0', valueY: '0', valueZ: '0' },
          Normal: { valueX: '1', valueY: '0', valueZ: '0' },
        }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    const call = r.calls.find((c) => c.op === 'cad.mirror');
    expect(call, 'mirror must translate').toBeDefined();
    expect(call!.inputs[0], 'source shape must be a positional input').toBe('part0');
    expect(call!.noPositionalArgs, 'GOTCHA: source must NOT be suppressed by noPositionalArgs').toBeFalsy();
    expect(r.code).toContain('cad.mirror(part0, {');
  });

  it('Part::Revolution lowers to cad.revolve(<input>, { axis, at, angle }) with the source as a positional arg', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Part::Box', 'Box', {}),
        simpleObj('Part::Revolution', 'Rev', {
          Source: { value: 'Box' },
          Axis: { valueX: '0', valueY: '0', valueZ: '1' },
          Angle: { value: '360' },
        }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    const call = r.calls.find((c) => c.op === 'cad.revolve');
    expect(call, 'revolve must translate').toBeDefined();
    expect(call!.inputs[0], 'source shape must be a positional input').toBe('part0');
    expect(call!.noPositionalArgs, 'GOTCHA: source must NOT be suppressed by noPositionalArgs').toBeFalsy();
    expect(r.code).toContain('cad.revolve(part0, {');
  });

  // GOTCHA (B2, Beds.FCStd `Loft002`, 2026-09-26): `Sections` is an
  // App::PropertyLinkList, so it was absent from depsOf() — exactly the
  // ArchDetail `Links` defect one layer down. Without that ordering edge Kahn
  // placed the loft at its document position (FreeCAD sorts Document.xml by
  // object name, so `Loft002` precedes `Sketch262`), inputVar() found nothing
  // and the loft baked as `loft-section-baked-upstream:Sketch262` — reported as
  // an upstream gap when the sketch was in fact translated and solved.
  // `Loft002` is the only thing standing between Beds.FCStd and a product.
  it('orders Part::Loft after its Sections profiles even when declared first', () => {
    const doc: FcstdDocument = {
      objects: [
        withLinkList('Part::Loft', 'Loft002', 'Sections', ['Sketch262', 'Sketch263']),
        simpleObj('Sketcher::SketchObject', 'Sketch262', {}),
        simpleObj('Sketcher::SketchObject', 'Sketch263', {}),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const verdicts = new Map([
      ['Sketch262', { level: 'L0' as const, loopCount: 1 }],
      ['Sketch263', { level: 'L0' as const, loopCount: 1 }],
    ]);
    const contours = new Map([['Sketch262', square()], ['Sketch263', square()]]);
    const r = generateModel(doc, verdicts, contours, 't');
    expect(r.calls.map((c) => c.op)).toEqual(['cad.profile', 'cad.profile', 'cad.loft']);
    const loft = r.calls[2]!;
    expect(loft.source).toBe('Loft002');
    expect(r.objects.find((o) => o.name === 'Loft002')!.disposition).toBe('translated');
    // Sections are rendered as a positional array literal of the profile vars.
    expect(r.code).toContain(`cad.loft([${r.calls[0]!.out}, ${r.calls[1]!.out}]`);
  });

  // GOTCHA (B2, 2026-09-26): the Kahn loop DROPPED every object caught in a
  // dependency cycle — they never reached the translator and kept the
  // container's initial `feature-translation-pending` disposition, so the
  // ledger blamed translation for an ordering deadlock. Worse, any new
  // dependency edge added to depsOf() (see the Sections/Links GOTCHAs) could
  // silently make objects vanish. Cycles must break into iteration order so
  // each object degrades to its own honest bake reason instead.
  it('breaks dependency cycles instead of dropping the objects from the ledger', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Part::Cut', 'Cut1', { Base: { value: 'Cut2' } }),
        simpleObj('Part::Cut', 'Cut2', { Base: { value: 'Cut1' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    // Both objects must be accounted for (a dropped object would be missing).
    expect(r.objects.map((o) => o.name).sort()).toEqual(['Cut1', 'Cut2']);
    // Neither can resolve its base in a cycle → each bakes with its own reason.
    for (const o of r.objects) {
      expect(o.disposition).toBe('baked');
      expect(o.reason).toBe('cut-missing-dependency');
    }
  });
});
