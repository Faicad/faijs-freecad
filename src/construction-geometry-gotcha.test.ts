/**
 * GOTCHA: FreeCAD `<Construction value="1"/>` reference geometry is part of the
 * constraint solve but NOT part of the profile.
 *
 * Real evidence — `Architectural Parts/Windows/Fixed/Double glazed window with
 * shutters and simple.FCStd`, `Sketch095` (Base of `Extrude_Sketch094`):
 *
 * ```xml
 * <Geometry type="Part::GeomLineSegment">
 *   <Construction value="1"/>
 *   <LineSegment StartX="25" StartY="-16508.670223782039" ... EndY="-8.544219811425"/>
 * </Geometry>
 * ```
 *
 * The two real arcs of that sketch sit at y ≈ 1151…1179. FreeCAD never
 * constrains construction geometry, so its stored coordinates are leftover
 * garbage — and the parser used to throw the flag away, making the reference
 * line indistinguishable from profile geometry. `extractContours` documented
 * "non-construction segments only" while filtering nothing, so the line entered
 * the chaining pool with two dangling endpoints.
 *
 * Consequence: the sketch solved (L0) yet produced zero closed loops
 * (`sketch-solved-no-closed-loop`), and the consumer gapped downstream as
 * `extrusion-missing-base` — the single largest gap class in the corpus sample
 * at the time of the fix.
 */
import { describe, it, expect } from 'vitest';
import { extractContours } from '@faicad/faijs-sketch';
import { parseSketchObject } from './sketch-parse.js';
import type { FcstdProperty } from './document.js';
import type { SketchGeom } from './sketch-parse.js';

/** Minimal FcstdProperty builder for fixture trees. */
function el(
  tagName: string,
  attributes: Record<string, string> = {},
  children: FcstdProperty[] = [],
): FcstdProperty {
  return {
    name: attributes['name'] ?? '', type: attributes['type'] ?? '',
    tagName, children, valueXml: '', valueText: '', attributes,
  };
}

function geometryListProperty(geometryChildren: FcstdProperty[]): FcstdProperty {
  return el('Property', { name: 'Geometry', type: 'Part::PropertyGeometryList' }, [
    el('GeometryList', { count: String(geometryChildren.length) }, geometryChildren),
  ]);
}

const line = (attrs: Record<string, string>, construction?: '0' | '1'): FcstdProperty =>
  el('Geometry', { type: 'Part::GeomLineSegment' }, [
    ...(construction ? [el('Construction', { value: construction })] : []),
    el('LineSegment', attrs),
  ]);

describe('construction geometry (GOTCHA 2026-09-26)', () => {
  it('parses <Construction value="1"/> into a construction flag per geometry', () => {
    const sk = parseSketchObject(
      geometryListProperty([
        line({ StartX: '0', StartY: '0', StartZ: '0', EndX: '10', EndY: '0', EndZ: '0' }, '1'),
        line({ StartX: '0', StartY: '0', StartZ: '0', EndX: '0', EndY: '10', EndZ: '0' }, '0'),
        line({ StartX: '10', StartY: '0', StartZ: '0', EndX: '10', EndY: '10', EndZ: '0' }),
      ]),
      undefined,
      false,
    );
    // `construction` is always a boolean: an absent <Construction/> sibling is
    // ordinary profile geometry, not "unknown".
    expect(sk.geoms.map((g) => g.construction)).toEqual([true, false, false]);
  });

  it('excludes construction segments from the chaining pool', () => {
    // The real offender: a reference line whose stored coordinates are
    // meaningless, sharing one endpoint with a legitimate rectangle corner.
    // Kept in the pool it contributes a dangling branch; the DFS marks pool
    // entries `used` as it walks, so a construction branch can consume real
    // segments before the profile is ever tried.
    const geoms: SketchGeom[] = [
      { kind: 'line', index: 0, x1: 0, y1: 0, z1: 0, x2: 10, y2: 0, z2: 0 },
      { kind: 'line', index: 1, x1: 10, y1: 0, z1: 0, x2: 10, y2: 5, z2: 0 },
      { kind: 'line', index: 2, x1: 10, y1: 5, z1: 0, x2: 0, y2: 5, z2: 0 },
      { kind: 'line', index: 3, x1: 0, y1: 5, z1: 0, x2: 0, y2: 0, z2: 0 },
      {
        kind: 'line', index: 4, x1: 0, y1: 0, z1: 0, x2: 25, y2: -16508.670223782039, z2: 0,
        construction: true,
      },
    ];
    const contours = extractContours(geoms);
    expect(contours.length).toBe(1);
    expect(contours[0]!.closed).toBe(true);
    expect(contours[0]!.segments.length).toBe(4);
  });

  it('does not emit a self-closed contour for a construction circle', () => {
    const geoms: SketchGeom[] = [
      { kind: 'circle', index: 0, cx: 0, cy: 0, cz: 0, radius: 5, construction: true },
    ];
    expect(extractContours(geoms).length).toBe(0);
  });
});
