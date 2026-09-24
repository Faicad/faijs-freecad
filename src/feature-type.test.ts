/**
 * M9 tests — Pad/Pocket Type-driven semantics (no silent Length fallback).
 *
 * Corpus note: the plan's TwoLengthsPad*.FCStd samples do NOT exist in the
 * local corpus (checked 2026-09-17), so these pin the semantics with
 * synthetic FCStd objects instead.
 *
 * GOTCHA: PropertyEnumeration values arrive as EITHER the string label
 * ('TwoLengths') or the integer index ('4') depending on how FreeCAD
 * serialized it — both forms are covered here.
 */
import { describe, it, expect } from 'vitest';
import { translateObject, featureTypeOf } from './feature-translate.js';
import type { FcstdObject } from './document.js';

function obj(type: string, name: string, props: Record<string, string | number>): FcstdObject {
  const properties = new Map(
    Object.entries(props).map(([k, v]) => [
      k,
      {
        name: k,
        type: k === 'Type' ? 'App::PropertyEnumeration' : '',
        tagName: 'Property',
        children: [{
          name: k === 'Type' ? 'String' : 'Float', type: '', tagName: k === 'Type' ? 'String' : 'Float',
          children: [], valueXml: '', valueText: '', attributes: { value: String(v) },
        }],
        valueXml: '', valueText: '', attributes: {},
      },
    ]),
  );
  return { type, name, properties };
}

const PROFILE_VAR = (dep: string): string | undefined => (dep === 'Sketch' ? 'part0' : dep === 'Pad' ? 'part1' : undefined);

describe('M9.1 featureTypeOf', () => {
  it('missing Type property → Length (FreeCAD default)', () => {
    const pad = obj('PartDesign::Pad', 'Pad', { Length: 10 });
    expect(featureTypeOf(pad, 'pad')).toBe('Length');
  });

  it('reads both label and index forms; Pad and Pocket tables differ', () => {
    // Pocket index 1 = ThroughAll; Pad index 1 = UpToLast
    expect(featureTypeOf(obj('PartDesign::Pocket', 'P', { Type: 1 }), 'pocket')).toBe('ThroughAll');
    expect(featureTypeOf(obj('PartDesign::Pad', 'P', { Type: 1 }), 'pad')).toBe('UpToLast');
    expect(featureTypeOf(obj('PartDesign::Pad', 'P', { Type: 'TwoLengths' }), 'pad')).toBe('TwoLengths');
    // out-of-range index → unknown, never silently Length
    expect(featureTypeOf(obj('PartDesign::Pad', 'P', { Type: 9 }), 'pad')).toBe('unknown');
  });
});

describe('M9.2 TwoLengths Pad → two extrudes + union', () => {
  it('Length forward + Length2 backward, fused via cad.union', () => {
    const pad = obj('PartDesign::Pad', 'Pad', {
      Type: 'TwoLengths', Length: 10, Length2: 4, Profile: 'Sketch',
    });
    const v = translateObject(pad, PROFILE_VAR);
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls.map((c) => c.op)).toEqual(['cad.extrude', 'cad.extrude', 'cad.union']);
    // signed literals: +Length and −Length2
    expect(v.calls[0]!.literals).toEqual([[0, 0, 10]]);
    expect(v.calls[1]!.literals).toEqual([[0, 0, -4]]);
  });

  it('Pocket TwoLengths is accepted as a valid Type (translated via Length path)', () => {
    const pocket = obj('PartDesign::Pocket', 'Pocket', {
      Type: 4, Length: 5, Profile: 'Sketch', BaseFeature: 'Pad',
    });
    const v = translateObject(pocket, PROFILE_VAR);
    expect(v.kind).toBe('translated');
  });
});

describe('M9.3 UpTo* / ThroughAll / unknown → explicit bake with reason', () => {
  const cases: [string, 'pad' | 'pocket', number | string, string][] = [
    // UpToLast/UpToFirst are now supported (translate) when a BaseFeature is
    // present (plan §4.3-C2); without one they bake with the precise
    // missing-dependency reason rather than the blanket "unsupported".
    ['pad UpToLast (no base)', 'pad', 'UpToLast', 'pad-upTo-missing-base'],
    ['pad UpToFirst (index, no base)', 'pad', 2, 'pad-upTo-missing-base'],
    // UpToFace with no datum-plane target (or no docObjects) bakes with the
    // solid-face reason — the datum-plane translation path is exercised in
    // feature-translate.test.ts, not here.
    ['pad UpToFace no datum-plane target', 'pad', 3, 'uptoface-solid-face-unsupported'],
    ['pad unknown index', 'pad', 99, 'pad-type-unknown-unsupported'],
    // 2026-09-20 ThroughAll support (hole_puzzle corpus): Pocket ThroughAll
    // now TRANSLATES like Length with a deep prism (the subtract truncates
    // against the base) — its positive-path coverage lives in
    // feature-translate.test.ts (GOTCHA test), not in this bake table.
    ['pocket UpToFace', 'pocket', 'UpToFace', 'pocket-uptoface-sub-unparseable'],
    ['pocket unknown', 'pocket', 'Bogus', 'pocket-type-unknown-unsupported'],
  ];
  for (const [label, kind, typeVal, expectedReason] of cases) {
    it(label, () => {
      const o = kind === 'pad'
        ? obj('PartDesign::Pad', 'Pad', { Type: typeVal as number, Length: 10, Profile: 'Sketch' })
        : obj('PartDesign::Pocket', 'Pocket', { Type: typeVal as number, Length: 10, Profile: 'Sketch', BaseFeature: 'Pad' });
      const v = translateObject(o, PROFILE_VAR);
      expect(v.kind, `${label} must bake`).toBe('baked');
      if (v.kind === 'baked') expect(v.reason).toBe(expectedReason);
    });
  }

  it('plain Length Pad still translates (no regression)', () => {
    const pad = obj('PartDesign::Pad', 'Pad', { Length: 10, Profile: 'Sketch' });
    const v = translateObject(pad, PROFILE_VAR);
    expect(v.kind).toBe('translated');
  });
});

// M11.1/M11.2 — ExpressionEngine bindings: constant values override the
// stored <Float>; non-constant expressions (references/arithmetic) bake
// explicitly with reason, never estimated.
describe('M11 expression bindings', () => {
  /** object with an ExpressionEngine property */
  function withEngine(type: string, name: string, expr: string, props: Record<string, string | number> = {}): FcstdObject {
    const o = obj(type, name, props);
    o.properties.set('ExpressionEngine', {
      name: 'ExpressionEngine', type: 'App::PropertyExpressionEngine', tagName: 'Property',
      children: [{
        name: 'ExpressionEngine', type: '', tagName: 'ExpressionEngine',
        children: [{
          name: 'Expression', type: '', tagName: 'Expression', children: [],
          valueXml: '', valueText: '', attributes: { path: 'Length', expression: expr },
        }],
        valueXml: '', valueText: '', attributes: { count: '1' },
      }],
      valueXml: '', valueText: '', attributes: {},
    });
    return o;
  }

  it('M11.1: constant binding (10 mm) overrides stored Length', () => {
    // stored <Float> says 999 — the expression wins
    const pad = withEngine('PartDesign::Pad', 'Pad', '10 mm', { Length: 999, Profile: 'Sketch' });
    const v = translateObject(pad, PROFILE_VAR);
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls.at(-1)!.literals).toEqual([[0, 0, 10]]);
  });

  it('M11.2: non-constant binding (cross-object reference) → bake with reason', () => {
    const pad = withEngine('PartDesign::Pad', 'Pad', 'Sketch.Constraints[3]', { Length: 10, Profile: 'Sketch' });
    const v = translateObject(pad, PROFILE_VAR);
    expect(v.kind).toBe('baked');
    if (v.kind === 'baked') expect(v.reason).toBe('pad-length-expression-non-constant');
  });

  it('M11.2: arithmetic with identifiers → bake with reason (Pocket)', () => {
    const pocket = withEngine('PartDesign::Pocket', 'Pocket', 'Pad.Length / 2', {
      Length: 5, Profile: 'Sketch', BaseFeature: 'Pad',
    });
    const v = translateObject(pocket, PROFILE_VAR);
    expect(v.kind).toBe('baked');
    if (v.kind === 'baked') expect(v.reason).toBe('pocket-length-expression-non-constant');
  });

  it('M11.1: constant arithmetic expression still not estimated — only bare constants pass', () => {
    // '2 * 5' is not a bare number-with-unit → non-constant → bake
    const pad = withEngine('PartDesign::Pad', 'Pad', '2 * 5', { Length: 10, Profile: 'Sketch' });
    const v = translateObject(pad, PROFILE_VAR);
    expect(v.kind).toBe('baked');
  });
});

// M13.1 — whitelist extensions probed on the real corpus
// (fcstd-port/tools/probe-m13-types.ts): Part::Compound (Links list → cad.group),
// Part::Sphere (Radius → cad.sphere).
describe('M13 whitelist extensions', () => {
  function withLinkList(type: string, name: string, prop: string, members: string[]): FcstdObject {
    const o = obj(type, name, {});
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

  it('Part::Compound with resolvable Links → cad.compound (M13.1)', () => {
    const c = withLinkList('Part::Compound', 'C', 'Links', ['A', 'B']);
    const v = translateObject(c, (d) => (d === 'A' ? 'part0' : d === 'B' ? 'part1' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.compound');
    expect(v.calls[0]!.inputs).toEqual(['part0', 'part1']);
  });

  it('Part::Compound with unresolvable member → bake compound-missing-members', () => {
    const c = withLinkList('Part::Compound', 'C', 'Links', ['Ghost']);
    const v = translateObject(c, () => undefined);
    expect(v.kind).toBe('baked');
    if (v.kind === 'baked') expect(v.reason).toBe('compound-missing-members');
  });

  it('Part::Sphere with Radius → cad.sphere at Placement', () => {
    const s = obj('Part::Sphere', 'S', { Radius: 12 });
    const v = translateObject(s, () => undefined);
    expect(v.kind).toBe('translated');
    if (v.kind !== 'translated') return;
    expect(v.calls[0]!.op).toBe('cad.sphere');
    expect(v.calls[0]!.params.radius).toBe(12);
  });

  it('Part::Sphere partial angles → explicit bake (no silent full sphere)', () => {
    const s = obj('Part::Sphere', 'S', { Radius: 12, Angle1: 0 });
    const v = translateObject(s, () => undefined);
    expect(v.kind).toBe('baked');
    if (v.kind === 'baked') expect(v.reason).toBe('sphere-partial-angle');
  });

  it('Part::Sphere without Radius → bake sphere-missing-radius', () => {
    const s = obj('Part::Sphere', 'S', {});
    const v = translateObject(s, () => undefined);
    expect(v.kind).toBe('baked');
    if (v.kind === 'baked') expect(v.reason).toBe('sphere-missing-radius');
  });
});
