/**
 * M3.1 — FCStd sketch parsing: <GeometryList> → SketchGeom[],
 * <ConstraintList> → SketchCon[].
 *
 * Field format per plan §5.2/§5.3:
 * - geometry coordinates are 3D (X/Y/Z); sketch-local Z is usually 0
 * - <Constrain> (singular) carries Type as the ConstraintType enum integer
 *   (Constraint.h:52-77)
 * - ElementIds/ElementPositions (new) take precedence over First/Second/Third
 *   (old); 47.5% of sample constraints lack the new format (§5.3.1)
 * - IsDriving defaults to true when missing (Constraint.h:240)
 * - geoId: >= 0 own geometry; -1 HAxis/RtPnt; -2 VAxis; <= -3 external (D4)
 */
import type { FcstdProperty } from './document.js';

/** ConstraintType enum values (src/Mod/Sketcher/App/Constraint.h:52-77) */
export const ConstraintType = {
  Coincident: 1,
  Horizontal: 2,
  Vertical: 3,
  Parallel: 4,
  Tangent: 5,
  Distance: 6,
  DistanceX: 7,
  DistanceY: 8,
  Angle: 9,
  Perpendicular: 10,
  Radius: 11,
  Equal: 12,
  PointOnObject: 13,
  Symmetric: 14,
  InternalAlignment: 15,
  SnellsLaw: 16,
  Block: 17,
  Diameter: 18,
  Weight: 19,
  Group: 20,
  Text: 21,
} as const;

/**
 * Human-readable names for the ConstraintType enum integers (debugging/
 * diagnostics only).
 */
export const CONSTRAINT_NAMES: Record<number, string> = {
  1: 'Coincident', 2: 'Horizontal', 3: 'Vertical', 4: 'Parallel', 5: 'Tangent',
  6: 'Distance', 7: 'DistanceX', 8: 'DistanceY', 9: 'Angle', 10: 'Perpendicular',
  11: 'Radius', 12: 'Equal', 13: 'PointOnObject', 14: 'Symmetric',
  15: 'InternalAlignment', 16: 'SnellsLaw', 17: 'Block', 18: 'Diameter',
  19: 'Weight', 20: 'Group', 21: 'Text',
};

/** GeoEnum (src/Mod/Sketcher/App/GeoEnum.h:71-78) */
export const GeoId = {
  RtPnt: -1,
  HAxis: -1,
  VAxis: -2,
  RefExt: -3,
} as const;

/** PointPos (GeoEnum.h:88-94) */
export const PointPos = {
  none: 0, // edge itself
  start: 1,
  end: 2,
  mid: 3, // center of circle/ellipse
} as const;

/**
 * One parsed sketch geometry element (point, line, circle, arc or ellipse),
 * in 3D sketch-local coordinates.
 */
export type SketchGeom =
  | { kind: 'point'; index: number; x: number; y: number; z: number }
  | { kind: 'line'; index: number; x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
  | { kind: 'circle'; index: number; cx: number; cy: number; cz: number; radius: number }
  | {
      kind: 'arc';
      index: number;
      cx: number;
      cy: number;
      cz: number;
      radius: number;
      startAngle: number; // radians
      endAngle: number;
      /** arc endpoints derived from angles (kept for solver wiring) */
      x1: number;
      y1: number;
      z1: number;
      x2: number;
      y2: number;
      z2: number;
    }
  | {
      kind: 'ellipse';
      index: number;
      cx: number;
      cy: number;
      cz: number;
      majorRadius: number;
      minorRadius: number;
      /** rotation of major axis, radians */
      angleXU: number;
      /** first focus (computed) */
      fx1: number;
      fy1: number;
      fx2: number;
      fy2: number;
    }
  | {
      /** P4: Part::GeomBSplineCurve (Poles/Knots/Degree/IsPeriodic) */
      kind: 'bspline';
      index: number;
      poles: { x: number; y: number }[];
      knots: number[];
      degree: number;
      periodic: boolean;
      /** curve start/end (exact for clamped splines; solver wiring + chaining) */
      x1: number;
      y1: number;
      z1: number;
      x2: number;
      y2: number;
      z2: number;
    };

/**
 * One (geometry, point) reference inside a constraint: a geoId plus a
 * PointPos selector.
 */
export interface GeoRef {
  /** geometry id: >= 0 own geometry; -1 HAxis/RtPnt; -2 VAxis; <= -3 external */
  geoId: number;
  /** PointPos selector (0 = edge itself, 1/2 = start/end, 3 = center) */
  pos: number; // PointPos
}

/**
 * One parsed sketch constraint (`<Constrain>` element).
 */
export interface SketchCon {
  /** index in the ConstraintList */
  index: number;
  /** ConstraintType integer */
  type: number;
  /** resolved element refs (ElementIds or First/Second/Third fallback) */
  refs: GeoRef[];
  /** driving dimension value (Distance/Angle/Radius/...) */
  value: number;
  /** IsDriving; missing means true (§5.3.1) */
  isDriving: boolean;
  /** raw name attribute */
  name: string;
  /** InternalAlignmentType when type === 15 */
  internalAlignmentType?: number;
}

/**
 * The fully parsed sketch: geometry, constraints, constrainedness and the set
 * of referenced external geoIds.
 */
export interface ParsedSketch {
  geoms: SketchGeom[];
  constraints: SketchCon[];
  fullyConstrained: boolean;
  /** geoIds <= -3 referenced by constraints (D4 external geometry) */
  externalGeoIds: number[];
}

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
    // geometry child.
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
        });
        break;
      }
      case tag === 'Circle' || gtype.includes('GeomCircle'): {
        geoms.push({
          kind: 'circle',
          index,
          cx: num(a, 'CenterX'), cy: num(a, 'CenterY'), cz: num(a, 'CenterZ'),
          radius: num(a, 'Radius'),
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
        });
        break;
      }
      case tag === 'GeomPoint' || tag === 'Point' || gtype.includes('GeomPoint'): {
        geoms.push({ kind: 'point', index, x: num(a, 'X'), y: num(a, 'Y'), z: num(a, 'Z') });
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
