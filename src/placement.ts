/**
 * M8.1 — PropertyPlacement parsing and quaternion math.
 *
 * FCStd stores placements as `<Property name="Placement"
 * type="App::PropertyPlacement"><PropertyPlacement Px=".." Py=".." Pz=".."
 * Q0=".." Q1=".." Q2=".." Q3=".."/></Property>` where (Q0,Q1,Q2,Q3) is the
 * rotation quaternion in (x,y,z,w) order — Q3 is the scalar component
 * (identity = 0,0,0,1; calibrated against FreeCAD sources and pinned by
 * placement.test.ts analytical solutions).
 *
 * AttachmentOffset uses the same nested element shape inside
 * `App::PropertyPlacementSub`-style properties.
 */
import type { FcstdObject } from './document.js';

/**
 * A placement: translation plus rotation quaternion (x, y, z, w).
 */
export interface Placement {
  /** translation (mm) */
  p: [number, number, number];
  /** rotation quaternion (x, y, z, w) */
  q: [number, number, number, number];
}

/**
 * Extract a Placement from a PropertyPlacement element (or missing → identity).
 *
 * @param prop - the Placement property (App::PropertyPlacement) or undefined.
 * @returns the parsed placement; identity when `prop` is missing.
 */
export function placementOfProp(prop: FcstdObject['properties'] extends Map<string, infer V> ? V | undefined : never): Placement {
  const el = prop?.children[0];
  const a = el?.attributes ?? {};
  return {
    p: [Number(a['Px'] ?? 0), Number(a['Py'] ?? 0), Number(a['Pz'] ?? 0)],
    q: [Number(a['Q0'] ?? 0), Number(a['Q1'] ?? 0), Number(a['Q2'] ?? 0), Number(a['Q3'] ?? 1)],
  };
}

/**
 * Convenience: the object's Placement property (identity when absent).
 *
 * @param obj - the FCStd object to read.
 * @returns the object's placement, or identity when it has none.
 */
export function placementOf(obj: FcstdObject): Placement {
  return placementOfProp(obj.properties.get('Placement'));
}

/**
 * 3×3 row-major rotation matrix from a (x,y,z,w) quaternion.
 *
 * @param q - the quaternion in (x, y, z, w) order.
 * @returns the 3×3 row-major rotation matrix (9 entries).
 * @throws when the quaternion has a zero/non-finite norm.
 */
export function quatToMatrix(q: [number, number, number, number]): number[] {
  const [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w);
  if (!Number.isFinite(n) || n === 0) throw new Error(`invalid quaternion norm: ${n}`);
  const nx = x / n, ny = y / n, nz = z / n, nw = w / n;
  const s = 2; // components are already normalized; scale factor is exactly 2
  return [
    1 - s * (ny * ny + nz * nz), s * (nx * ny - nw * nz), s * (nx * nz + nw * ny),
    s * (nx * ny + nw * nz), 1 - s * (nx * nx + nz * nz), s * (ny * nz - nw * nx),
    s * (nx * nz - nw * ny), s * (ny * nz + nw * nx), 1 - s * (nx * nx + ny * ny),
  ];
}

/**
 * Apply placement (rotate then translate) to a point.
 *
 * @param pl - the placement to apply.
 * @param w - the world-space input point (mm).
 * @returns the transformed point (mm).
 */
export function applyPlacement(pl: Placement, w: [number, number, number]): [number, number, number] {
  const m = quatToMatrix(pl.q);
  const r = (i: number): number => m[i * 3]! * w[0] + m[i * 3 + 1]! * w[1] + m[i * 3 + 2]! * w[2];
  return [r(0) + pl.p[0], r(1) + pl.p[1], r(2) + pl.p[2]];
}

/**
 * Apply the inverse placement (translate back, rotate by conjugate).
 *
 * @param pl - the placement whose inverse is applied.
 * @param w - the world-space input point (mm).
 * @returns the point mapped into the placement-local frame (mm).
 */
export function invertApplyPlacement(pl: Placement, w: [number, number, number]): [number, number, number] {
  const d: [number, number, number] = [w[0] - pl.p[0], w[1] - pl.p[1], w[2] - pl.p[2]];
  const inv: Placement = { p: [0, 0, 0], q: [-pl.q[0], -pl.q[1], -pl.q[2], pl.q[3]] };
  return applyPlacement(inv, d);
}

/**
 * M8.3 — quaternion → XYZ euler angles in DEGREES, matching the convention of
 * `rotateBrep` (brep/brep-ops.ts): THREE.Euler(order 'XYZ'), i.e. the rotation
 * matrix is RX·RY·RZ (column vectors; Z applied first). Pinned against THREE
 * itself in placement.test.ts — not from memory.
 *
 * @param q - the quaternion in (x, y, z, w) order.
 * @returns (x, y, z) euler angles in degrees.
 */
export function quatToEulerXYZDeg(q: [number, number, number, number]): [number, number, number] {
  const m = quatToMatrix(q);
  // M = RX·RY·RZ (row-major 3×3): m[2] = +sinY, m[5] = -sinX·cosY, m[8] = cosX·cosY
  const sy = m[2]!;
  const y = Math.asin(Math.max(-1, Math.min(1, sy)));
  if (Math.abs(sy) < 1 - 1e-9) {
    const x = Math.atan2(-m[5]!, m[8]!);
    const z = Math.atan2(-m[1]!, m[0]!);
    return [(x * 180) / Math.PI, (y * 180) / Math.PI, (z * 180) / Math.PI];
  }
  // gimbal lock: Y = ±90°, X and Z are coupled — set Z = 0; x from m[3]/m[4]
  const x = Math.atan2(m[3]!, m[4]!);
  return [(x * 180) / Math.PI, (y * 180) / Math.PI, 0];
}

/**
 * True when the placement is (approximately) the identity — no transform needed.
 *
 * @param pl - the placement to test.
 * @param eps - tolerance for both translation and quaternion components.
 * @returns true when the placement is within `eps` of identity.
 */
export function isIdentityPlacement(pl: Placement, eps = 1e-9): boolean {
  return (
    Math.abs(pl.p[0]) < eps && Math.abs(pl.p[1]) < eps && Math.abs(pl.p[2]) < eps &&
    Math.abs(pl.q[0]) < eps && Math.abs(pl.q[1]) < eps && Math.abs(pl.q[2]) < eps &&
    Math.abs(Math.abs(pl.q[3]) - 1) < eps
  );
}

/**
 * M8.3 — orthonormal sketch-plane basis (u, v) from the placement rotation:
 * u = rotated X axis, v = rotated Y axis, normal = rotated Z. Points on the
 * sketch plane (z≈0 in local coords) map to global as p·u + q·v.
 *
 * @param pl - the placement whose rotation defines the plane.
 * @returns the rotated X axis (u), Y axis (v) and plane normal (n).
 */
export function planeBasis(pl: Placement): { u: [number, number, number]; v: [number, number, number]; n: [number, number, number] } {
  const m = quatToMatrix(pl.q);
  // column i of the matrix = image of the i-th basis vector
  const col = (i: number): [number, number, number] => [m[i]!, m[i + 3]!, m[i + 6]!];
  return { u: col(0), v: col(1), n: col(2) };
}
