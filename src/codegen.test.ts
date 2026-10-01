/**
 * M5 tests — dependency ordering (M5.1), code lowering (M5.2), statement
 * ids sN / variables (FCStd source object names, sanitized), multi-root
 * grouping, and M6 sketch→cad.profile wiring (Pad/Pocket become real
 * cad.extrude / cad.subtract calls).
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
  it('orders Box → Cut in dependency order and lowers to sN/<source-name>', () => {
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
    expect(result.calls[2]!.inputs).toEqual(['Box', 'Cyl']);
    expect(result.code).toContain('let Box = cad.box(');
    expect(result.code).toContain('s0');
    expect(result.code).toContain('let Cut = cad.subtract(');
    // Origin preserved-only
    const origin = result.objects.find((o) => o.name === 'Origin');
    expect(origin).toMatchObject({ disposition: 'preserved-only' });
  });

  // A2 (2026-09-28 plan, D2 (b)): when the convert-time precheck produced
  // canonical inputs (solve status !== failed), the sketch emits a PARAMETRIC
  // `cad.sketch({ geoms, constraints })` — geometry AND constraints travel
  // into the .fai.js and the run-time op re-solves. The old
  // solved-contour → cad.profile emission is the A5 fallback only.
  it('emits parametric cad.sketch (geoms + constraints) when sketch inputs are provided', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const geoms = [
      { kind: 'line' as const, x1: 0, y1: 0, x2: 40, y2: 0 },
      { kind: 'line' as const, x1: 40, y1: 0, x2: 40, y2: 30 },
      { kind: 'line' as const, x1: 40, y1: 30, x2: 0, y2: 30 },
      { kind: 'line' as const, x1: 0, y1: 30, x2: 0, y2: 0 },
    ];
    const constraints = [
      { kind: 'horizontal' as const, of: { index: 0 } },
      { kind: 'vertical' as const, of: { index: 1 } },
      { kind: 'length' as const, of: { index: 0 }, value: 40 },
    ];
    const inputs = new Map([['Sketch', { geoms, constraints }]]);
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't', undefined, undefined, undefined, undefined, undefined, inputs);
    const sketch = r.objects.find((o) => o.name === 'Sketch');
    expect(sketch).toMatchObject({ disposition: 'translated' });
    expect(r.code).toContain('cad.sketch');
    // constraints must survive verbatim into the generated source
    expect(r.code).toContain('"kind":"length"');
    expect(r.code).toContain('"value":40');
    // no profile fallback for parameterizable sketches
    expect(r.code).not.toContain('cad.profile');
    // the Pad still resolves the sketch as its profile face input
    const pad = r.objects.find((o) => o.name === 'Pad');
    expect(pad).toMatchObject({ disposition: 'translated' });
    expect(r.code).toContain('cad.extrude');
  });

  // A3 (D3 (b), 2026-09-28): a parametric sketch with a NON-identity
  // Placement emits the explicit plane frame { origin, normal, xAxis } inside
  // the cad.sketch call itself (one-step placement via the shared
  // sketchOnPlane core) — the post-hoc cad.place re-orientation must NOT be
  // applied to the sketch statement.
  // GOTCHA (两帧往返): the frame axes come from the SAME placement quaternion
  // the run-time re-solve assumes (u = R·X, n = R·Z) — mixing frames would
  // double-rotate the sketch.
  it('emits a rotated sketch as cad.sketch with an explicit plane frame (no cad.place on the sketch)', () => {
    const sketch = simpleObj('Sketcher::SketchObject', 'Sketch199', {});
    sketch.properties.set('Placement', {
      name: 'Placement', type: 'App::PropertyPlacement', tagName: 'Property',
      children: [{
        name: 'PropertyPlacement', type: '', tagName: 'PropertyPlacement',
        children: [], valueXml: '', valueText: '',
        attributes: { Px: '0', Py: '0', Pz: '250', Q0: '0', Q1: '0.707106781187', Q2: '0', Q3: '0.707106781187' },
      }],
      valueXml: '', valueText: '', attributes: {},
    } as never);
    const pad = simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch199' }, Length: { value: '10' } });
    const doc: FcstdDocument = {
      objects: [sketch, pad],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const geoms = [{ kind: 'line' as const, x1: 0, y1: 0, x2: 40, y2: 0 }];
    const inputs = new Map([['Sketch199', { geoms, constraints: [] }]]);
    const placements = new Map([['Sketch199', { p: [0, 0, 250] as [number, number, number], q: [0, 0.707106781187, 0, 0.707106781187] as [number, number, number, number] }]]);
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't', placements, undefined, undefined, undefined, undefined, inputs);
    const sketchRes = r.objects.find((o) => o.name === 'Sketch199');
    expect(sketchRes).toMatchObject({ disposition: 'translated' });
    // the frame rides INSIDE the cad.sketch params…
    expect(r.code).toContain('cad.sketch');
    expect(r.code).toContain('"normal"');
    expect(r.code).toContain('"origin"');
    // …and the sketch statement is not re-placed afterwards
    expect(r.code).not.toMatch(/cad\.place\([^)]*Sketch199/);
  });

  // A5 (2026-09-28 plan): the cad.profile emission is the FALLBACK branch
  // only — it must carry an explicit reason naming why the sketch was not
  // parameterizable (sketch-profile-fallback[: cause]).
  it('records an explicit reason on the cad.profile fallback branch', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    // L1 verdict (no sketchInputs) with a usable solved contour → fallback
    const r = generateModel(
      doc,
      new Map([['Sketch', { level: 'L1' as const, loopCount: 1, reason: 'delta-exceeds-t1' }]]),
      new Map([['Sketch', square()]]),
      't',
    );
    const sketch = r.objects.find((o) => o.name === 'Sketch');
    expect(sketch).toMatchObject({ disposition: 'translated' });
    expect(sketch!.reason).toBe('sketch-profile-fallback: delta-exceeds-t1');
    // verdict without a reason still gets the bare fallback marker
    const r2 = generateModel(
      doc,
      new Map([['Sketch', { level: 'L1' as const, loopCount: 1 }]]),
      new Map([['Sketch', square()]]),
      't',
    );
    expect(r2.objects.find((o) => o.name === 'Sketch')!.reason).toBe('sketch-profile-fallback');
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

  // P2-1 (2026-09-28): a sketch with canonical inputs but ZERO geoms (all
  // construction / fully trimmed) must NOT reach the parametric emission —
  // the run-time op throws E_SKETCHC_NO_GEOMS on empty geoms (see the GOTCHA
  // in packages/sketch/src/op-entry-schema-gotcha.test.ts). The codegen bakes
  // it with an explicit `sketch-empty-geoms` reason instead.
  it('bakes a sketch with canonical inputs but zero geoms as sketch-empty-geoms (no cad.sketch emission)', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' }, Length: { value: '10' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const inputs = new Map([['Sketch', { geoms: [], constraints: [] }]]);
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't', undefined, undefined, undefined, undefined, undefined, inputs);
    const sketch = r.objects.find((o) => o.name === 'Sketch');
    expect(sketch).toMatchObject({ disposition: 'baked', reason: 'sketch-empty-geoms' });
    expect(r.code).not.toContain('cad.sketch(');
  });

  it('groups multiple roots via cad.compound', () => {
    const doc: FcstdDocument = {
      objects: [simpleObj('Part::Box', 'A', {}), simpleObj('Part::Box', 'B', {})],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    expect(r.code).toContain('cad.compound({ members: [A, B] })');
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

  // GOTCHA (W2, 2026-09-27, Shutter "Double doors with shutters and trim"):
  // Part::Extrusion links its profile via `Base` (not PartDesign's `Sketch`).
  // The M8.3 placement step read only `Sketch`, so an extrude built in the
  // sketch-local frame was never re-oriented by the sketch's rotated
  // Placement — all faces collapsed onto z≈0 (sketch on XZ). Correct usage:
  // resolve the sketch through `Base` too (when the linked object IS a
  // sketch) and emit the re-placing cad.place.
  it('re-orients Part::Extrusion results by a rotated sketch Placement (Base link)', () => {
    const sketch = simpleObj('Sketcher::SketchObject', 'Sketch199', {});
    sketch.properties.set('Placement', {
      name: 'Placement', type: 'App::PropertyPlacement', tagName: 'Property',
      children: [{
        name: 'PropertyPlacement', type: '', tagName: 'PropertyPlacement',
        children: [], valueXml: '', valueText: '',
        attributes: { Px: '0', Py: '0', Pz: '0', Q0: '0.707106781187', Q1: '0', Q2: '0', Q3: '0.707106781187' },
      }],
      valueXml: '', valueText: '', attributes: {},
    } as never);
    const ext = simpleObj('Part::Extrusion', 'Extrude_Sketch199', {
      Base: { value: 'Sketch199' },
      Dir: { valueX: '0', valueY: '-10', valueZ: '0' },
    });
    // give Dir the PropertyVector child shape via raw attributes is not
    // needed here — the translator reads it; this test only pins the
    // placement wiring, so a missing Dir just falls back to [0,0,1].
    const doc: FcstdDocument = {
      objects: [sketch, ext],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(
      doc,
      new Map([['Sketch199', { level: 'L0' as const, loopCount: 1 }]]),
      new Map([['Sketch199', square()]]),
      't',
      new Map([['Sketch199', { p: [0, 0, 0], q: [0.707106781187, 0, 0, 0.707106781187] }]]),
    );
    expect(r.code).toContain('cad.place(');
    // the placed var replaces the raw extrude var for consumers
    expect(r.code).toMatch(/Extrude_Sketch199__place/);
  });

  // GOTCHA (W2 type②, 2026-09-28, Wall-Hung-Toilets): a subtractive feature
  // (Pocket) whose profile sketch carries a non-identity Placement must be
  // re-oriented by placing its CUT, and the feature's own boolean must consume
  // the *placed* cut — NOT the un-placed one (or the pocket lands at the origin
  // and the fillet's edge ordinal is out of range). The placement step must:
  //   (a) emit `cad.place(<original-cut-var>, …)` — never a self-reference
  //       (`cad.place(X, X)`), which is a forward-ref at parse time and also
  //        drops the real input so the call mis-routes to main;
  //   (b) retarget the subtract's tool input at the placed copy;
  //   (c) declare the placed copy BEFORE the subtract that consumes it (faijs
  //       rejects forward refs).
  it('re-orients a Pocket CUT by the profile sketch Placement and retargets the boolean tool', () => {
    const body = simpleObj('PartDesign::Body', 'Body');
    body.properties.set('Group', {
      name: 'Group', type: 'App::PropertyLinkList', tagName: 'Property',
      children: [{
        name: 'LinkList', type: '', tagName: 'LinkList',
        children: [
          { name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: 'Pad' } },
          { name: 'Link', type: '', tagName: 'Link', children: [], valueXml: '', valueText: '', attributes: { value: 'Pocket' } },
        ],
        valueXml: '', valueText: '', attributes: { count: '2' },
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
    const placements = new Map<string, { p: [number, number, number]; q: [number, number, number, number] }>([
      ['Sketch001', { p: [0, 0, 984], q: [0, 0, 0, 1] }],
    ]);
    const r = generateModel(doc, verdicts, contours, 't', placements);
    // (a) the place call takes the ORIGINAL cut var — never a self-reference
    expect(r.code).toMatch(/cad\.place\(Pocket_cut,/);
    expect(r.code).not.toMatch(/cad\.place\(Pocket__place, Pocket__place\)/);
    // (b) the feature's own subtract consumes the placed cut (tool retargeted)
    expect(r.code).toMatch(/cad\.subtract\(Pad, Pocket__place\)/);
    // (c) the placed cut is declared BEFORE the subtract (no forward ref)
    const placeIdx = r.code.indexOf('cad.place(Pocket_cut');
    const subIdx = r.code.indexOf('cad.subtract(Pad, Pocket__place');
    expect(placeIdx).toBeGreaterThanOrEqual(0);
    expect(subIdx).toBeGreaterThan(placeIdx);
    // and the placed var resolves to the sketch placement, not the origin
    expect(r.code).toContain('position: [0,0,984]');
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
    expect(r.code).toContain('let Fillet = cad.fillet(Box, { edges: [cad.edgeRef(Box, 17), cad.edgeRef(Box, 18)], radius: 4 });');
    expect(r.code).not.toContain('"__jsExpr"');
  });

  it('keeps plain array params byte-identical (no JsExpr present)', () => {
    const doc: FcstdDocument = {
      objects: [simpleObj('Part::Box', 'A', {}), simpleObj('Part::Box', 'B', {})],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const r = generateModel(doc, new Map(), NO_CONTOURS, 't');
    expect(r.code).toContain('cad.compound({ members: [A, B] })');
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
    // chain-level union/subtract ops: body folding never uses `__place` /
    // `__invplace` (those are cad.place), so just filter by op. (The chain
    // var is `<Body>__chain`, which intentionally contains `__`.)
    const chainOps = r.calls.filter((c) => c.op === 'cad.union' || c.op === 'cad.subtract');
    expect(chainOps.map((c) => c.op)).toEqual(['cad.subtract', 'cad.union']);
    // Pad001's union consumes the Pocket output (chain head), not the raw Pad
    const pocketOut = chainOps[0]!.out;
    expect(chainOps[1]!.inputs).toContain(pocketOut);
    // a single Body's chain must not emit any cad.compound aggregation
    expect(r.code).not.toContain('cad.compound(');
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
    expect(r.code).toContain('let assembly = cad.compound({ members: [Body_out, Body001_out] });');
    expect(r.rootVar).toBe('assembly');
  });

  // M-B1 (2026-10-01): single-Body docs must produce EXACTLY ONE terminal.
  // The Body module's terminal is named `assembly` (not `Body_out`) and the
  // aggregate entry imports it directly — there is NO `let assembly = Body_out;`
  // alias. The alias leaked a second `Body_out` terminal into the STEP export,
  // which parity merge_parts summed → solids 1vs2 (the 922-file mismatch class).
  // GOTCHA: empirically verified — renaming the terminal to `assembly` collapses
  // the executed program to one terminal (cross-module same-named shape var
  // merges), so cliRun exports a single `out.step`.
  it('single-Body emits one terminal: Body terminal is `assembly`, main imports it directly (M-B1)', () => {
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
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const verdicts = new Map([['Sketch', { level: 'L0' as const, loopCount: 1 }]]);
    const contours = new Map([['Sketch', square()]]);
    const r = generateModel(doc, verdicts, contours, 't');
    // one Body file, terminal named `assembly`
    expect(r.files.length).toBe(1);
    const bodyFile = r.files[0]!;
    expect(bodyFile.path).toBe('model/Body.fai.js');
    expect(bodyFile.code).toContain('let assembly =');
    expect(bodyFile.code).not.toContain('let Body_out =');
    // main imports `assembly` directly, NO alias that leaks a second terminal
    expect(r.code).toContain(`import { assembly } from './Body.fai.js';`);
    expect(r.code).not.toContain('let assembly = Body_out');
    expect(r.rootVar).toBe('assembly');
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
    // The Base resolves to the sanitized source-name variable (Circle003 —
    // faijs variable names are the FCStd object names, never partN).
    expect(ext!.inputs[0]).toBe('Circle003');
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
    // inputs are the sanitized FCStd source-name variables (Wire045 / Wire046),
    // NOT a partN counter — pin the real names and guard against regression.
    expect(compound.inputs).toEqual(['Wire045', 'Wire046']);
    expect(compound.inputs.every((i) => /^part\d+$/.test(i))).toBe(false);
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
    expect(call!.inputs[0], 'source shape must be a positional input').toBe('Box');
    expect(call!.noPositionalArgs, 'GOTCHA: source must NOT be suppressed by noPositionalArgs').toBeFalsy();
    expect(r.code).toContain('cad.mirror(Box, {');
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
    expect(call!.inputs[0], 'source shape must be a positional input').toBe('Box');
    expect(call!.noPositionalArgs, 'GOTCHA: source must NOT be suppressed by noPositionalArgs').toBeFalsy();
    expect(r.code).toContain('cad.revolve(Box, {');
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

  // P1.3 GOTCHA (Winch-Model1-Cable-Guide, 2026-09-28): Body-less PartDesign
  // files serialize "implied by feature order" as an EMPTY BaseFeature link
  // (`<Link value=""/>`). propLink → undefined → BODY_CHAIN_BASE marker; with
  // no Body container there was never a chain head, so the H7 guard baked
  // EVERY loose Pocket (7/7 in winch). A translated loose feature must become
  // the implicit chain head for the next one (document order = FreeCAD's
  // implied ordering); only a marker BEFORE any loose feature is headless.
  it('chains Body-less PartDesign features via the implicit loose-chain head instead of baking them', () => {
    const doc: FcstdDocument = {
      objects: [
        simpleObj('Sketcher::SketchObject', 'Sketch', {}),
        simpleObj('PartDesign::Pad', 'Pad', { Profile: { value: 'Sketch' } }),
        simpleObj('Sketcher::SketchObject', 'Sketch001', {}),
        // empty BaseFeature link value = implied base (FreeCAD 0.20+)
        simpleObj('PartDesign::Pocket', 'Pocket', { Profile: { value: 'Sketch001' } }),
      ],
      typeIndex: new Map(),
      meta: new Map(),
    };
    const square = () => [{
      closed: true,
      segments: [
        { kind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 },
        { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 10 },
        { kind: 'line', x1: 10, y1: 10, x2: 0, y2: 10 },
        { kind: 'line', x1: 0, y1: 10, x2: 0, y2: 0 },
      ],
    }] as never;
    const contours = new Map([['Sketch', square()], ['Sketch001', square()]]);
    const geoms = [{ kind: 'line' as const, x1: 0, y1: 0, x2: 40, y2: 0 }];
    const inputs = new Map([['Sketch', { geoms, constraints: [] }], ['Sketch001', { geoms, constraints: [] }]]);
    const r = generateModel(doc, new Map(), contours, 't', undefined, undefined, undefined, undefined, undefined, inputs);
    const pad = r.objects.find((o) => o.name === 'Pad');
    const pocket = r.objects.find((o) => o.name === 'Pocket');
    expect(pad).toMatchObject({ disposition: 'translated' });
    // the Pocket resolved its base from the implicit chain head — no bake
    expect(pocket).toMatchObject({ disposition: 'translated' });
    expect(r.calls.some((c) => c.op === 'cad.subtract' && c.inputs.length === 2)).toBe(true);
    // the generated code must not leak the marker as an identifier
    expect(r.code).not.toContain('::body-chain-base::');
  });
});

/**
 * A1 follow-up (2026-09-29) — a Draft drawing emits ONE shape per KIND.
 *
 * Closed contours are profiles (`cad.sketchOnPlane` → `makeFace`, what
 * `cad.extrude` consumes); open contours are paths (a `cad.sweep` spine), and
 * OCCT refuses to build a face from an open wire —
 * `CONSTRUCTION_FAILED: makeFace: construction failed`, measured on Chair's two
 * `Shape2DView` projections (17 open contours each). They therefore travel as
 * `as:'wire'`, and a drawing that carries both kinds is compounded.
 */
describe('A1 Draft emission — closed contours are faces, open contours are wires', () => {
  /** A Draft 2D object with a frozen Shape member (the A1 target class). */
  function draftDoc(): FcstdDocument {
    return {
      objects: [simpleObj('Part::Part2DObjectPython', 'Clone2D', { Shape: { file: 'Clone2D.Shape.brp' } })],
      typeIndex: new Map(),
      meta: new Map(),
    };
  }

  /** Square loop (closed). */
  function square(x: number, y: number, s: number) {
    return {
      closed: true,
      segments: [
        { kind: 'line' as const, x1: x, y1: y, x2: x + s, y2: y },
        { kind: 'line' as const, x1: x + s, y1: y, x2: x + s, y2: y + s },
        { kind: 'line' as const, x1: x + s, y1: y + s, x2: x, y2: y + s },
        { kind: 'line' as const, x1: x, y1: y + s, x2: x, y2: y },
      ],
    };
  }

  /** Open two-segment path (a sweep spine, as Kitchen_cabinet_base stores it). */
  function path(x: number, y: number) {
    return {
      closed: false,
      segments: [
        { kind: 'line' as const, x1: x, y1: y, x2: x + 10, y2: y },
        { kind: 'line' as const, x1: x + 10, y1: y, x2: x + 10, y2: y + 20 },
      ],
    };
  }

  function gen(contours: unknown[]) {
    return generateModel(
      draftDoc(), new Map(), NO_CONTOURS, 't',
      undefined, undefined, undefined, undefined, undefined, undefined,
      new Map([['Clone2D', { contours }]]) as never,
    );
  }

  it('a uniformly closed drawing is ONE face call (unchanged path, nesting intact)', () => {
    const r = gen([square(0, 0, 10), square(20, 0, 5)]);
    const sk = r.calls.filter((c) => c.op === 'cad.sketchOnPlane');
    expect(sk).toHaveLength(1);
    // No `as` → the op defaults to 'face'.
    expect(sk[0]!.params!.as).toBeUndefined();
    // A single part IS the object — no intermediate variable, no compound.
    expect(sk[0]!.out).toBe('Clone2D');
    expect(r.calls.some((c) => c.op === 'cad.compound')).toBe(false);
    expect(r.code).not.toContain('as: "wire"');
    expect(r.objects.find((o) => o.name === 'Clone2D')!.reason).toBe('draft-draw(2 closed, 0 open)');
  });

  it('a uniformly open drawing is ONE wire call (the object IS the spine)', () => {
    const r = gen([path(0, 0)]);
    const sk = r.calls.filter((c) => c.op === 'cad.sketchOnPlane');
    expect(sk).toHaveLength(1);
    expect(sk[0]!.params!.as).toBe('wire');
    expect(sk[0]!.out).toBe('Clone2D');
    expect(r.calls.some((c) => c.op === 'cad.compound')).toBe(false);
    expect(r.code).toContain('as: "wire"');
  });

  it('a mixed drawing compounds the face group with one wire per open contour', () => {
    const r = gen([square(0, 0, 10), path(0, 0), path(50, 0)]);
    const sk = r.calls.filter((c) => c.op === 'cad.sketchOnPlane');
    expect(sk).toHaveLength(3);
    // GOTCHA: the closed contours stay in ONE call. Splitting them per contour
    // would make every hole a filled face (hole/island nesting lives inside the
    // single call's `organiseBlueprints` pass).
    expect(sk[0]!.params!.as).toBeUndefined();
    expect(sk[1]!.params!.as).toBe('wire');
    expect(sk[2]!.params!.as).toBe('wire');
    const comp = r.calls.find((c) => c.op === 'cad.compound');
    expect(comp).toBeDefined();
    expect(comp!.out).toBe('Clone2D');
    // GOTCHA: members travel as LEXICAL VAR NAMES in `params.members`, and the
    // `inputs` registration is what keeps them consumed — without it `lower()`
    // sweeps the part variables into the root aggregate a second time.
    expect(comp!.params!.members).toEqual(sk.map((c) => c.out));
    expect(comp!.inputs).toEqual(sk.map((c) => c.out));
    expect(comp!.noPositionalArgs).toBe(true);
    expect(r.code).toContain('cad.compound({ members: [');
    // The parts are consumed, so the object stays the only root: no `assembly`.
    expect(r.code).not.toContain('let assembly');
  });

  it('every Draft emission keeps the object Placement as the lift frame', () => {
    const r = generateModel(
      draftDoc(), new Map(), NO_CONTOURS, 't',
      new Map([['Clone2D', { p: [0, 0, 5] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] }]]),
      undefined, undefined, undefined, undefined, undefined,
      new Map([['Clone2D', { contours: [square(0, 0, 10), path(0, 0)] }]]) as never,
    );
    for (const c of r.calls.filter((c) => c.op === 'cad.sketchOnPlane')) {
      expect(c.params!.plane).toEqual({ origin: [0, 0, 5], normal: [0, 0, 1], xAxis: [1, 0, 0] });
    }
  });
});
