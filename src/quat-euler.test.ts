/**
 * M8.3 — quaternion → THREE-XYZ-euler conversion, calibrated against THREE
 * itself (the same Euler order rotateBrep uses, brep/brep-ops.ts). Also pins
 * the FCStd corpus placements: PadTest sketches are all ±90° rotations.
 *
 * GOTCHA: quatToEulerXYZDeg must round-trip through THREE's own quaternion→
 * euler path; any drift here silently rotates ported geometry.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { quatToEulerXYZDeg, quatToMatrix } from './placement.js';

/** random-ish quaternions covering axis rotations and combinations */
const CASES: [number, number, number, number][] = [
  [0, 0, 0, 1], // identity
  [Math.SQRT1_2, 0, 0, Math.SQRT1_2], // 90° X
  [0, Math.SQRT1_2, 0, Math.SQRT1_2], // 90° Y
  [0, 0, Math.SQRT1_2, Math.SQRT1_2], // 90° Z
  [0, -Math.SQRT1_2, 0, Math.SQRT1_2], // -90° Y (Sketch002-like)
  [0, Math.SQRT1_2, Math.SQRT1_2, 0], // 90° Y then 90° Z-ish (Sketch-like)
  [0.5, 0.5, 0.5, 0.5],
  [0, 0.707106781187, 0.707106781187, 0], // PadTest Sketch placement
];

describe('M8.3 quat→XYZ-euler matches THREE.Euler', () => {
  for (const [qi, q] of CASES.entries()) {
    it(`case ${qi} q=[${q.map((c) => c.toFixed(4)).join(', ')}]`, () => {
      const threeQuat = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
      const euler = new THREE.Euler().setFromQuaternion(threeQuat, 'XYZ');
      const expected = [
        (euler.x * 180) / Math.PI,
        (euler.y * 180) / Math.PI,
        (euler.z * 180) / Math.PI,
      ];
      const actual = quatToEulerXYZDeg(q);
      // 1e-5°: corpus quaternions are truncated to 12 digits, so exact 90°
      // inputs carry ~1.2e-6° float noise through both paths.
      actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 5));
      // and rotating the basis must reproduce the same matrix
      const mBack = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
        (actual[0] * Math.PI) / 180, (actual[1] * Math.PI) / 180, (actual[2] * Math.PI) / 180, 'XYZ',
      ));
      const mMine = quatToMatrix(q);
      // THREE Matrix4 is column-major; my matrix rows = THREE rows of elements
      const t = mBack.elements; // [m11,m21,m31,m41, m12,...]
      const cmp = [t[0]!, t[4]!, t[8]!, t[1]!, t[5]!, t[9]!, t[2]!, t[6]!, t[10]!];
      // 1e-7: round-trip through euler loses a few ulps (≈2e-8) for gimbal-adjacent cases
      cmp.forEach((v, i) => expect(v).toBeCloseTo(mMine[i]!, 7));
    });
  }
});
