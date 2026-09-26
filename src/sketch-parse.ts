/**
 * M3.1 — FCStd sketch XML parsing: <GeometryList> → SketchGeom[],
 * <ConstraintList> → SketchCon[].
 *
 * The sketch model types and the solve pipeline now live in
 * `@faicad/faijs-sketch`; this module keeps the FCStd-specific XML parsing and
 * re-exports the types under their historical names so existing consumers of
 * the read layer keep compiling.
 *
 * Field format per plan §5.2/§5.3:
 * - geometry coordinates are 3D (X/Y/Z); sketch-local Z is usually 0
 * - <Constrain> (singular) carries Type as the ConstraintType enum integer
 * - ElementIds/ElementPositions (new) take precedence over First/Second/Third
 *   (old); 47.5% of sample constraints lack the new format (§5.3.1)
 * - IsDriving defaults to true when missing
 * - geoId: >= 0 own geometry; -1 HAxis/RtPnt; -2 VAxis; <= -3 external
 */
import type { FcstdProperty } from './document.js';
import {
  ConstraintType,
  CONSTRAINT_NAMES,
  GeoId,
  PointPos,
} from '@faicad/faijs-sketch';
import type {
  FcstdSketchGeom as SketchGeom,
  FcstdGeoRef as GeoRef,
  FcstdSketchCon as SketchCon,
  FcstdParsedSketch as ParsedSketch,
} from '@faicad/faijs-sketch';

export { ConstraintType, CONSTRAINT_NAMES, GeoId, PointPos };
export type {
  FcstdSketchGeom as SketchGeom,
  FcstdGeoRef as GeoRef,
  FcstdSketchCon as SketchCon,
  FcstdParsedSketch as ParsedSketch,
} from '@faicad/faijs-sketch';

function num(attrs: Record<string, string>, key: string): number {
  const v = attrs[key];
  return v === undefined ? 0 : Number(v);
}

/**
 * Parse a sketch's `<GeometryList>` property into typed geometry elements.
 *
 * @param prop - the sketch's Geometry property.
 * @returns the parsed geometry list; unsupported element kinds degrade to a
 *   NaN point so the caller can downgrade the sketch.
 */
export function parseGeometryList(prop: FcstdProperty): SketchGeom[] {
  // <GeometryList count="N"><Geometry type="...">...</Geometry>...</GeometryList>
  const listEl = prop.children[0];
  if (!listEl) return [];
  const geoms: SketchGeom[] = [];
  let index = 0;
  for (const child of listEl.children) {
    const gtype = child.attributes['type'] ?? '';
    // <Geometry> may carry <Construction/>, <GeoExtensions/> or <UID/>
    // siblings before the actual geometry element — pick the first real
    // geometry child, and surface the Construction flag (contour.ts filters
    // reference geometry on it; merging the parse into @faicad/faijs-sketch
    // dropped it, GOTCHA 2026-09-26).
    const isConstruction = child.children.some((c) => c.tagName === 'Construction' && c.attributes['value'] !== '0');
    const inner = child.children.find(
      (c) => c.tagName !== 'Construction' && c.tagName !== 'GeoExtensions' && c.tagName !== 'UID',
    );
    if (!inner) continue;
    const a = inner.attributes;
    const tag = inner.tagName;
    switch (true) {
      case tag === 'LineSegment' || gtype.includes('GeomLineSegment'): {
        geoms.push({
          kind: 'line',
          index,
          x1: num(a, 'StartX'), y1: num(a, 'StartY'), z1: num(a, 'StartZ'),
          x2: num(a, 'EndX'), y2: num(a, 'EndY'), z2: num(a, 'EndZ'),
          construction: isConstruction,
        });
        break;
      }
      case tag === 'Circle' || gtype.includes('GeomCircle'): {
        geoms.push({
          kind: 'circle',
          index,
          cx: num(a, 'CenterX'), cy: num(a, 'CenterY'), cz: num(a, 'CenterZ'),
          radius: num(a, 'Radius'),
          construction: isConstruction,
        });
        break;
      }
      case tag === 'ArcOfCircle' || gtype.includes('GeomArcOfCircle'): {
        const cx = num(a, 'CenterX');
        const cy = num(a, 'CenterY');
        const cz = num(a, 'CenterZ');
        const r = num(a, 'Radius');
        const sa = num(a, 'StartAngle');
        const ea = num(a, 'EndAngle');
        geoms.push({
          kind: 'arc',
          index, cx, cy, cz, radius: r, startAngle: sa, endAngle: ea,
          x1: cx + r * Math.cos(sa), y1: cy + r * Math.sin(sa), z1: cz,
          x2: cx + r * Math.cos(ea), y2: cy + r * Math.sin(ea), z2: cz,
          construction: isConstruction,
        });
        break;
      }
      case tag === 'GeomPoint' || tag === 'Point' || gtype.includes('GeomPoint'): {
        geoms.push({ kind: 'point', index, x: num(a, 'X'), y: num(a, 'Y'), z: num(a, 'Z'), construction: isConstruction });
        break;
      }
      case tag === 'Ellipse' || gtype.includes('GeomEllipse'): {
        const cx = num(a, 'CenterX');
        const cy = num(a, 'CenterY');
        const major = num(a, 'MajorRadius');
        const minor = num(a, 'MinorRadius');
        const ang = num(a, 'AngleXU');
        const f = Math.sqrt(Math.max(0, major * major - minor * minor));
        const ca = Math.cos(ang);
        const sa2 = Math.sin(ang);
        geoms.push({
          kind: 'ellipse', index, cx, cy, cz: num(a, 'CenterZ'),
          majorRadius: major, minorRadius: minor, angleXU: ang,
          fx1: cx + f * ca, fy1: cy + f * sa2,
          fx2: cx - f * ca, fy2: cy - f * sa2,
          construction: isConstruction,
        });
        break;
      }
      case tag === 'BSplineCurve' || gtype.includes('GeomBSplineCurve'): {
        // P4: poles are child <Pole X= Y= Z=/> elements, knots child
        // <Knot Value= Multiplicity=/> (attributes only carry counts).
        const poles = inner.children
          .filter((c) => c.tagName === 'Pole')
          .map((c) => ({ x: num(c.attributes, 'X'), y: num(c.attributes, 'Y') }));
        const knots: number[] = [];
        for (const c of inner.children) {
          if (c.tagName !== 'Knot') continue;
          const m = num(c.attributes, 'Multiplicity');
          const v = num(c.attributes, 'Value');
          const mult = Number.isFinite(m) && m >= 1 ? m : 1;
          for (let k = 0; k < mult; k++) knots.push(v);
        }
        const degree = num(a, 'Degree');
        const periodic = num(a, 'IsPeriodic') !== 0;
        const first = poles[0];
        const last = poles[poles.length - 1];
        geoms.push({
          kind: 'bspline',
          index,
          poles,
          knots,
          degree,
          periodic,
          x1: first ? first.x : NaN,
          y1: first ? first.y : NaN,
          z1: 0,
          x2: last ? last.x : NaN,
          y2: last ? last.y : NaN,
          z2: 0,
          construction: isConstruction,
        });
        break;
      }
      default:
        // ArcOfEllipse / hyperbola / parabola: not supported in M3
        // (sample set: 0 occurrences, plan §5.5.3); caller downgrades to L2.
        geoms.push({ kind: 'point', index, x: NaN, y: NaN, z: NaN });
        break;
    }
    index++;
  }
  return geoms;
}

function parseGeoRef(attrs: Record<string, string>, prefix: string): GeoRef {
  return { geoId: Math.trunc(num(attrs, prefix)), pos: Math.trunc(num(attrs, `${prefix}Pos`)) };
}

/**
 * Parse a sketch's `<ConstraintList>` property into constraint records.
 *
 * @param prop - the sketch's Constraints property.
 * @returns the parsed constraints, with element refs resolved from
 *   ElementIds/ElementPositions or the old First/Second/Third fallback.
 */
export function parseConstraintList(prop: FcstdProperty): SketchCon[] {
  // <ConstraintList count="N"><Constrain .../>...</ConstraintList>
  const listEl = prop.children[0];
  if (!listEl) return [];
  const cons: SketchCon[] = [];
  let index = 0;
  for (const child of listEl.children) {
    if (child.tagName !== 'Constrain') continue;
    const a = child.attributes;
    const type = Math.trunc(num(a, 'Type'));

    // ElementIds (new, space-separated) takes precedence; fallback First/Second/Third
    const refs: GeoRef[] = [];
    const eids = a['ElementIds']?.trim();
    const eposs = a['ElementPositions']?.trim();
    if (eids && eposs) {
      const ids = eids.split(/\s+/).map(Number);
      const poss = eposs.split(/\s+/).map(Number);
      for (let i = 0; i < ids.length; i++) {
        refs.push({ geoId: ids[i]!, pos: poss[i] ?? 0 });
      }
    } else {
      // old-style triple; Third=GeoUndef(-2000) means unused
      for (const prefix of ['First', 'Second', 'Third']) {
        const geoId = Math.trunc(num(a, prefix));
        if (geoId === -2000) continue;
        refs.push(parseGeoRef(a, prefix));
      }
    }

    const isDriving = a['IsDriving'] === undefined ? true : a['IsDriving'] === '1';

    cons.push({
      index,
      type,
      refs,
      value: num(a, 'Value'),
      isDriving,
      name: a['Name'] ?? '',
      internalAlignmentType: type === 15 ? Math.trunc(num(a, 'InternalAlignmentType')) : undefined,
    });
    index++;
  }
  return cons;
}

/**
 * Parse a sketch object's geometry and constraint properties (M3.1 entry).
 *
 * @param geometryProp - the sketch's Geometry property (may be undefined).
 * @param constraintsProp - the sketch's Constraints property (may be undefined).
 * @param fullyConstrained - the sketch's FullyConstrained flag.
 * @returns the parsed sketch, including external geoIds referenced by constraints.
 */
export function parseSketchObject(
  geometryProp: FcstdProperty | undefined,
  constraintsProp: FcstdProperty | undefined,
  fullyConstrained: boolean,
): ParsedSketch {
  const geoms = geometryProp ? parseGeometryList(geometryProp) : [];
  const constraints = constraintsProp ? parseConstraintList(constraintsProp) : [];
  const externalGeoIds = new Set<number>();
  for (const c of constraints) {
    for (const r of c.refs) {
      // GeoUndef (-2000) is an unused-slot placeholder in old-format triples
      // and ElementIds — it is NOT external geometry. External refs are the
      // small negative range starting at RefExt (-3).
      if (r.geoId <= GeoId.RefExt && r.geoId > -2000) externalGeoIds.add(r.geoId);
    }
  }
  return {
    geoms,
    constraints,
    fullyConstrained,
    externalGeoIds: [...externalGeoIds],
  };
}
