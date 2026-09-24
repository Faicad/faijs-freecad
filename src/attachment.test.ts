/**
 * H3 — attachment resolution (plan §3.5): MapMode / Support / AttachmentOffset.
 *
 * Corpus probe (fcstd-port/tools/probe-attachment-usage.mjs, 2026-09-20):
 * 29/56 corpus files carry a NON-deactivated MapMode. MapMode is an
 * App::PropertyEnumeration stored as <Integer value="N"> (NOT a string —
 * GOTCHA, first probe regex matched nothing); values in use: 5=mmFlatFace
 * (68 objects), 6=mmTangentPlane (3), 1=mmTranslate (1).
 *
 * Support is App::PropertyLinkSubList: <Link obj="XY_Plane" sub=""/> —
 * datum planes (App::Plane / PartDesign::Plane) are the dominant target.
 *
 * Contract tested here: for an attached sketch, the placement derived from
 * (support object placement ∘ AttachmentOffset) MUST equal the Placement
 * FreeCAD stored in the same file (the stored value is the ground truth —
 * FreeCAD recomputes it from the attachment chain on save).
 *
 * These tests FAIL before H3 is implemented (resolveAttachment absent).
 */
import { describe, it, expect } from 'vitest';
import type { FcstdObject, FcstdProperty } from './document.js';
import { resolveAttachment, ATTACH_MAP_MODE } from './attachment.js';
import { placementOf, type Placement } from './placement.js';

function obj(type: string, name: string, props: [string, FcstdProperty][]): FcstdObject {
  return { type, name, properties: new Map(props) };
}

function el(tag: string, attrs: Record<string, string>, children: FcstdProperty[] = []): FcstdProperty {
  return { name: tag, type: '', tagName: tag, children, valueXml: '', valueText: '', attributes: attrs };
}

function prop(name: string, child: FcstdProperty): [string, FcstdProperty] {
  return [name, { name, type: '', tagName: 'Property', children: [child], valueXml: '', valueText: '', attributes: {} }];
}

/** Placement property shaped as FreeCAD saves it. */
function placementProp(name: string, attrs: Record<string, string>): [string, FcstdProperty] {
  return prop(name, el('PropertyPlacement', attrs));
}

/** Support property: <LinkSubList><Link obj="N" sub="S"/></LinkSubList> */
function supportProp(target: string, sub = ''): [string, FcstdProperty] {
  return prop('Support', el('LinkSubList', { count: '1' }, [el('Link', { obj: target, sub })]));
}

function mapModeProp(value: number): [string, FcstdProperty] {
  return prop('MapMode', el('Integer', { value: String(value) }));
}

function offsetProp(attrs: Record<string, string>): [string, FcstdProperty] {
  return placementProp('AttachmentOffset', attrs);
}

describe('H3 attachment resolution (MapMode enum GOTCHA + FlatFace chain)', () => {
  it('exposes the eMapMode enum values actually seen in the corpus (GOTCHA: stored as <Integer>, not string)', () => {
    expect(ATTACH_MAP_MODE.FLAT_FACE).toBe(5); // mmFlatFace — 68 objects, dominant
    expect(ATTACH_MAP_MODE.TANGENT_PLANE).toBe(6);
    expect(ATTACH_MAP_MODE.TRANSLATE).toBe(1);
    expect(ATTACH_MAP_MODE.DEACTIVATED).toBe(0);
  });

  it('resolveAttachment returns undefined for MapMode=0 (deactivated) or missing Support', () => {
    const deactivated = obj('Sketcher::SketchObject', 'S', [
      mapModeProp(0),
      supportProp('XY_Plane'),
      placementProp('Placement', { Px: '1', Py: '2', Pz: '3', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    expect(resolveAttachment(deactivated, new Map())).toBeUndefined();

    const noSupport = obj('Sketcher::SketchObject', 'S', [mapModeProp(5)]);
    expect(resolveAttachment(noSupport, new Map())).toBeUndefined();
  });

  it('GOTCHA: MapMode stored as <Integer value="5">, never <String> — FlatFace on a datum plane', () => {
    // datum plane at origin, sketch attached FlatFace with identity offset →
    // resolved placement must be identity (equal to what FreeCAD stores)
    const plane = obj('App::Plane', 'XY_Plane', [
      placementProp('Placement', { Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    const placements = new Map<string, Placement>([['XY_Plane', placementOf(plane)]]);
    const sketch = obj('Sketcher::SketchObject', 'Sketch', [
      mapModeProp(5), // <Integer value="5"/> — the corpus storage shape
      supportProp('XY_Plane'),
      offsetProp({ Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
      placementProp('Placement', { Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    const resolved = resolveAttachment(sketch, placements);
    expect(resolved).toBeDefined();
    expect(resolved!.placement.p).toEqual([0, 0, 0]);
  });

  it('FlatFace + translated datum plane + AttachmentOffset: composed == stored Placement', () => {
    // datum plane carried by Origin at (10, 20, 5); sketch offset by (1, 2, 3)
    // → FreeCAD stores Placement Pz ≈ 8 etc. Composition must reproduce it.
    const plane = obj('PartDesign::Plane', 'DatumPlane', [
      placementProp('Placement', { Px: '10', Py: '20', Pz: '5', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    const placements = new Map<string, Placement>([['DatumPlane', placementOf(plane)]]);
    const sketch = obj('Sketcher::SketchObject', 'Sketch002', [
      mapModeProp(5),
      supportProp('DatumPlane'),
      offsetProp({ Px: '1', Py: '2', Pz: '3', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
      placementProp('Placement', { Px: '11', Py: '22', Pz: '8', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    const resolved = resolveAttachment(sketch, placements);
    expect(resolved).toBeDefined();
    expect(resolved!.placement.p[0]).toBeCloseTo(11, 6);
    expect(resolved!.placement.p[1]).toBeCloseTo(22, 6);
    expect(resolved!.placement.p[2]).toBeCloseTo(8, 6);
  });

  it('GOTCHA: corpus files show Support property named "Support" (old) — resolveAttachment reads both Support and AttachmentSupport', () => {
    const plane = obj('App::Plane', 'XY_Plane', [
      placementProp('Placement', { Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    const placements = new Map<string, Placement>([['XY_Plane', placementOf(plane)]]);
    const modern = obj('Sketcher::SketchObject', 'S', [
      mapModeProp(5),
      // newer FreeCAD renames the property to AttachmentSupport
      prop('AttachmentSupport', el('LinkSubList', { count: '1' }, [el('Link', { obj: 'XY_Plane', sub: '' })])),
      placementProp('Placement', { Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' }),
    ]);
    expect(resolveAttachment(modern, placements)).toBeDefined();
  });
});
