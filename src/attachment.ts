/**
 * H3 — attachment resolution: Support → MapMode → AttachmentOffset.
 *
 * FreeCAD saves an attached object's Placement as the ALREADY-COMPOSED result
 * of the attachment chain (recomputed on load/save). The chain for the modes
 * that matter to the corpus (probe: fcstd-port/tools/probe-attachment-usage.mjs):
 *   MapMode 5 = mmFlatFace  (68 objects — dominant)
 *   MapMode 6 = mmTangentPlane (3)
 *   MapMode 1 = mmTranslate (1)
 *   MapMode 0 = mmDeactivated (no attachment; Placement stands alone)
 *
 * Full Attacher.cpp semantics (normal-projection onto a face, Frenet frames on
 * curves, three-point modes) are far beyond what the corpus exercises: the
 * corpus Support targets are datum planes / origin planes, where the resolved
 * frame IS the support's placement, then rotated per-mode and composed with
 * AttachmentOffset. This module implements that plane-support subset and
 * reports what it resolved so the caller can bake with an explicit reason when
 * the support is not a plane.
 *
 * EXCEPTION (W2 type②, 2026-09-27): when the Support names a *sub-shape* of a
 * solid — `Face6` / `Edge3` of a Pad/Pocket — FreeCAD pre-resolves the
 * attached object's stored `Placement` onto that face and writes it back, so the
 * stored value is authoritative. Recomputing from the whole-object placement
 * drops the face offset and yields identity (misplacing the feature at the
 * origin). For sub-shape supports we return the stored Placement directly.
 *
 * GOTCHAs (probed on real files):
 * - MapMode is `App::PropertyEnumeration` stored as `<Integer value="N"/>`,
 *   NEVER a `<String>` — matching the string name finds nothing.
 * - The support link property is `Support` (old) or `AttachmentSupport`
 *   (newer FreeCAD); both must be read.
 * - `App::Plane` objects carry the origin-plane identity placement; their
 *   orientation comes from their own Placement property like any object.
 */
import type { FcstdObject, FcstdProperty } from './document.js';
import { placementOf, placementOfProp, type Placement } from './placement.js';

/** eMapMode values from FreeCAD Attacher.h (subset the corpus uses). */
export const ATTACH_MAP_MODE = {
  DEACTIVATED: 0,
  TRANSLATE: 1,
  OBJECT_XY: 2,
  OBJECT_XZ: 3,
  OBJECT_YZ: 4,
  FLAT_FACE: 5,
  TANGENT_PLANE: 6,
} as const;

/** Property names that may carry the support link (old / new FreeCAD). */
const SUPPORT_PROPS = ['Support', 'AttachmentSupport'] as const;

function firstLinkSub(obj: FcstdObject): { target: string; sub: string } | undefined {
  for (const name of SUPPORT_PROPS) {
    const prop: FcstdProperty | undefined = obj.properties.get(name);
    const link = prop?.children[0]?.children[0];
    const target = link?.attributes['obj'];
    if (target) return { target, sub: link?.attributes['sub'] ?? '' };
  }
  return undefined;
}

function mapMode(obj: FcstdObject): number | undefined {
  const raw = obj.properties.get('MapMode')?.children[0]?.attributes['value'];
  return raw === undefined ? undefined : Number(raw);
}

/**
 * Compose two placements: `outer ∘ inner` (apply inner first, then outer).
 * Quaternion product q = qo * qi, position = outer(inner(0)).
 */
function compose(outer: Placement, inner: Placement): Placement {
  const [ox, oy, oz, ow] = outer.q;
  const [ix, iy, iz, iw] = inner.q;
  // Hamilton product (x,y,z,w)
  const q: [number, number, number, number] = [
    ow * ix + ox * iw + oy * iz - oz * iy,
    ow * iy - ox * iz + oy * iw + oz * ix,
    ow * iz + ox * iy - oy * ix + oz * iw,
    ow * iw - ox * ix - oy * iy - oz * iz,
  ];
  const [px, py, pz] = inner.p;
  const [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w);
  const nx = x / n, ny = y / n, nz = z / n, nw = w / n;
  const s = 2;
  const p: [number, number, number] = [
    (1 - s * (ny * ny + nz * nz)) * px + s * (nx * ny - nw * nz) * py + s * (nx * nz + nw * ny) * pz + outer.p[0],
    s * (nx * ny + nw * nz) * px + (1 - s * (nx * nx + nz * nz)) * py + s * (ny * nz - nw * nx) * pz + outer.p[1],
    s * (nx * nz - nw * ny) * px + s * (ny * nz + nw * nx) * py + (1 - s * (nx * nx + ny * ny)) * pz + outer.p[2],
  ];
  return { p, q };
}

/** 附件链解析结果：合成后的 placement + 原始 MapMode + support 引用。 */
export interface AttachmentResolution {
  /** the composed placement (support ∘ mode-adjustment ∘ AttachmentOffset) */
  placement: Placement;
  /** eMapMode integer as stored */
  mapMode: number;
  /** support target object name and sub-element */
  support: { target: string; sub: string };
}

/**
 * A support that names a sub-shape of a solid (e.g. `Face6` of a Pad) pins the
 * attached object onto that face. FreeCAD pre-resolves the object's stored
 * `Placement` to the face frame, so the correct placement is the stored value
 * itself — recomputing from the *whole-object* placement silently drops the
 * face offset and yields identity (W2 type②, Wall-Hung-Toilets: `Sketch002`
 * attached to `Pad001/Face6` stores Pz=984, but the whole-object frame is the
 * origin, so the recompute produced identity and the pocket tool landed at the
 * origin instead of on the face). Datum-plane / origin-plane supports (sub is
 * empty or a plane name) still use the composed frame below.
 */
function isSubShapeSupport(sub: string): boolean {
  return /^Face\d+$/.test(sub) || /^Edge\d+$/.test(sub);
}

/**
 * Resolve the attachment chain of an object carrying AttachExtension
 * properties. Only plane-type supports are composed (corpus reality: all
 * active attachments target datum/origin planes); anything else — or a
 * missing support — returns undefined so the caller keeps the stored
 * Placement or bakes with an explicit reason.
 *
 * @param obj - the FCStd object (sketch or datum) with MapMode/Support/AttachmentOffset.
 * @param placements - per-object placements of the document (resolved earlier).
 * @returns the resolved attachment, or undefined when not attached / not resolvable.
 */
export function resolveAttachment(
  obj: FcstdObject,
  placements: Map<string, Placement>,
): AttachmentResolution | undefined {
  const mode = mapMode(obj);
  if (mode === undefined || mode === ATTACH_MAP_MODE.DEACTIVATED) return undefined;
  const support = firstLinkSub(obj);
  if (!support) return undefined;

  // Face/edge attachment: trust the pre-resolved stored Placement (see
  // isSubShapeSupport). FreeCAD has already composed Support ∘ AttachmentOffset
  // onto the face frame and written it to `Placement`.
  if (isSubShapeSupport(support.sub)) {
    return { placement: placementOf(obj), mapMode: mode, support };
  }

  const supportPlacement = placements.get(support.target);
  if (!supportPlacement) return undefined;

  // Plane-support modes: the support's frame IS the base frame. (mmFlatFace
  // on a plane, mmObjectXY/XZ/YZ and mmTranslate all coincide here; on a real
  // face or curve they diverge — those are handled by the sub-shape branch
  // above via the pre-resolved stored Placement.)
  const offset = placementOfProp(obj.properties.get('AttachmentOffset'));
  const placement = compose(supportPlacement, offset);
  return { placement, mapMode: mode, support };
}

/**
 * Convenience: an object's effective placement — attachment-resolved when attached, stored otherwise.
 *
 * @param obj - the FCStd object to resolve.
 * @param placements - per-object placements of the document (resolved earlier).
 * @returns the object's effective placement.
 */
export function effectivePlacement(obj: FcstdObject, placements: Map<string, Placement>): Placement {
  return resolveAttachment(obj, placements)?.placement ?? placementOf(obj);
}
