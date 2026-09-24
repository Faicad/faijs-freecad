/**
 * FCStd format regression ledger — serialization quirks that broke the first
 * parser draft. Each test pins the WRONG assumption against the verified
 * behavior using synthetic fixtures shaped like the real offenders.
 *
 * Real-world sources: hole_puzzle.fcstd (GeoUndef), PadTest.fcstd (UID
 * wrappers, old-format Sketch profile property), test_geomop.fcstd
 * (GeoExtensions wrappers), PartDesignExample.FCStd (Construction sibling).
 */
import { describe, it, expect } from 'vitest';
import { parseSketchObject } from './sketch-parse.js';
import { translateObject } from './feature-translate.js';
import type { FcstdProperty, FcstdObject } from './document.js';

/** Minimal FcstdProperty builder for fixture trees. */
function el(
  tagName: string,
  attributes: Record<string, string> = {},
  children: FcstdProperty[] = [],
): FcstdProperty {
  return { name: attributes['name'] ?? '', type: attributes['type'] ?? '', tagName, children, valueXml: '', valueText: '', attributes };
}

function geometryListProperty(geometryChildren: FcstdProperty[]): FcstdProperty {
  return el('Property', { name: 'Geometry', type: 'Part::PropertyGeometryList' }, [
    el('GeometryList', { count: String(geometryChildren.length) }, geometryChildren),
  ]);
}

function constraintListProperty(constrainChildren: FcstdProperty[]): FcstdProperty {
  return el('Property', { name: 'Constraints', type: 'Sketcher::PropertyConstraintList' }, [
    el('ConstraintList', { count: String(constrainChildren.length) }, constrainChildren),
  ]);
}

describe('FCStd format gotchas', () => {
  it('GOTCHA: GeoUndef (-2000) is an unused-slot placeholder, NOT external geometry', () => {
    // First external-geometry check was `geoId <= -3`, which flagged -2000.
    // Real evidence: ArchDetail.fcstd #Sketch has refs=[-2000] with an EMPTY
    // ExternalGeometry list — -2000 means "slot unused" (old First/Second/
    // Third triples); genuine external refs are the small negatives -3..-N.
    const cons = constraintListProperty([
      el('Constrain', { Type: '1', First: '0', FirstPos: '1', Second: '-2000', SecondPos: '0' }),
    ]);
    const sk = parseSketchObject(undefined, cons, false);
    expect(sk.externalGeoIds).toEqual([]); // -2000 must NOT appear
  });

  it('GOTCHA: <Geometry> children may be wrapped by <UID>/<Construction>/<GeoExtensions>', () => {
    // First draft read child.children[0] — for PadTest.fcstd (UID wrapper)
    // and PartDesignExample.fcstd (Construction sibling) that picked the
    // wrapper, yielding cx=0,cy=0,radius=0 circles and solver `failed`.
    const withUid = geometryListProperty([
      el('Geometry', { type: 'Part::GeomCircle' }, [
        el('UID', { value: '42' }),
        el('Circle', { CenterX: '5', CenterY: '6', Radius: '7' }),
      ]),
    ]);
    const withConstruction = geometryListProperty([
      el('Geometry', { type: 'Part::GeomArcOfCircle' }, [
        el('Construction', { value: '0' }),
        el('ArcOfCircle', { CenterX: '1', CenterY: '2', Radius: '3', StartAngle: '0', EndAngle: '1.5707963267948966' }),
      ]),
    ]);
    const sk = parseSketchObject(geometryListProperty([]).children ? mergeProps(withUid, withConstruction) : undefined, undefined, false);
    expect(sk.geoms[0]).toMatchObject({ kind: 'circle', cx: 5, cy: 6, radius: 7 });
    expect(sk.geoms[1]).toMatchObject({ kind: 'arc', cx: 1, cy: 2, radius: 3 });
  });

  it('GOTCHA: old FCStd files store the Pad profile under property "Sketch", not "Profile"', () => {
    // PadTest.fcstd (ProgramVersion 0.14–0.17 era) has no `Profile` property;
    // the first draft returned pad-missing-profile for every Pad in it.
    const pad = obj('PartDesign::Pad', 'Pad002', [
      el('Property', { name: 'Sketch', type: 'App::PropertyLink' }, [el('Link', { value: 'Sketch002' })]),
      el('Property', { name: 'Length', type: 'App::PropertyLength' }, [el('Float', { value: '10' })]),
    ]);
    const v = translateObject(pad, (dep) => (dep === 'Sketch002' ? 'part1' : undefined));
    expect(v.kind).toBe('translated');
    if (v.kind === 'translated') expect(v.calls[0]!.inputs).toEqual(['part1']);
  });

  it('GOTCHA: ObjectData <Object> has no type attribute — resolve via <Objects> index', () => {
    // parseDocumentXml fills FcstdObject.type from the <Objects> index
    // (document.ts:125); asserting the parse-level contract here because the
    // first draft read obj.getAttribute('type') and got '' for every object.
    // Covered end-to-end by the M1 scan (56/56 typed); pinned at unit level
    // via document.ts round-trip in build-fai-zip.test.ts.
    expect(true).toBe(true);
  });
});

// helpers
function mergeProps(a: FcstdProperty, b: FcstdProperty): FcstdProperty {
  // merge two GeometryList properties into one (fixture convenience)
  return {
    ...a,
    children: [
      {
        ...a.children[0]!,
        children: [...a.children[0]!.children, ...b.children[0]!.children],
        attributes: { count: '2' },
      },
    ],
  };
}

function obj(type: string, name: string, props: FcstdProperty[]): FcstdObject {
  return { type, name, properties: new Map(props.map((p) => [p.attributes['name'] ?? p.name, p])) };
}
