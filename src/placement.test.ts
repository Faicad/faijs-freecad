/**
 * M8.1b — quaternion → rotation matrix, pinned to analytical solutions for
 * 90°/180° rotations about each axis. The (x,y,z,w) component order and the
 * matrix layout (column i = image of basis vector i) are calibrated against
 * FreeCAD's Placement serialization, not from memory.
 *
 * Also pins the sketch-plane basis contract (M8.2): u/v/n are the rotated
 * X/Y/Z axes, and the round-trip local→global→local must be exact.
 */
import { describe, it, expect } from 'vitest';
import {
  quatToMatrix,
  applyPlacement,
  invertApplyPlacement,
  planeBasis,
  placementOfProp,
} from './placement.js';
import type { FcstdProperty } from './document.js';

const EPS = 1e-12;

function propWithPlacement(attrs: Record<string, string>): FcstdProperty {
  return {
    name: 'Placement', type: 'App::PropertyPlacement', tagName: 'Property',
    children: [{
      name: 'PropertyPlacement', type: '', tagName: 'PropertyPlacement',
      children: [], valueXml: '', valueText: '', attributes: attrs,
    }],
    valueXml: '', valueText: '', attributes: {},
  };
}

/** quaternion for rotation of `deg` degrees about the given axis */
function axisQuat(axis: 'x' | 'y' | 'z', deg: number): [number, number, number, number] {
  const r = (deg * Math.PI) / 180;
  const h = Math.sin(r / 2);
  return axis === 'x' ? [h, 0, 0, Math.cos(r / 2)]
    : axis === 'y' ? [0, h, 0, Math.cos(r / 2)]
    : [0, 0, h, Math.cos(r / 2)];
}

function expectBasisRotation(q: [number, number, number, number], axis: 'x' | 'y' | 'z', deg: number): void {
  const m = quatToMatrix(q);
  const c = (i: number): [number, number, number] => [m[i]!, m[i + 3]!, m[i + 6]!];
  const [ux, uy, uz] = c(0);
  const [vx, vy, vz] = c(1);
  const [nx, ny, nz] = c(2);
  const co = Math.cos((deg * Math.PI) / 180);
  const si = Math.sin((deg * Math.PI) / 180);
  if (axis === 'x') {
    expect(ux).toBeCloseTo(1, 12); expect(uy).toBeCloseTo(0, 12); expect(uz).toBeCloseTo(0, 12);
    expect(vx).toBeCloseTo(0, 12); expect(vy).toBeCloseTo(co, 12); expect(vz).toBeCloseTo(si, 12);
    expect(nx).toBeCloseTo(0, 12); expect(ny).toBeCloseTo(-si, 12); expect(nz).toBeCloseTo(co, 12);
  } else if (axis === 'y') {
    expect(ux).toBeCloseTo(co, 12); expect(uy).toBeCloseTo(0, 12); expect(uz).toBeCloseTo(-si, 12);
    expect(vx).toBeCloseTo(0, 12); expect(vy).toBeCloseTo(1, 12); expect(vz).toBeCloseTo(0, 12);
    expect(nx).toBeCloseTo(si, 12); expect(ny).toBeCloseTo(0, 12); expect(nz).toBeCloseTo(co, 12);
  } else {
    expect(ux).toBeCloseTo(co, 12); expect(uy).toBeCloseTo(si, 12); expect(uz).toBeCloseTo(0, 12);
    expect(vx).toBeCloseTo(-si, 12); expect(vy).toBeCloseTo(co, 12); expect(vz).toBeCloseTo(0, 12);
    expect(nx).toBeCloseTo(0, 12); expect(ny).toBeCloseTo(0, 12); expect(nz).toBeCloseTo(1, 12);
  }
}

describe('M8.1 placement quaternion math', () => {
  it('identity quaternion yields identity matrix', () => {
    const m = quatToMatrix([0, 0, 0, 1]);
    expect(m).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('90° rotations about each axis match analytical matrices', () => {
    expectBasisRotation(axisQuat('x', 90), 'x', 90);
    expectBasisRotation(axisQuat('y', 90), 'y', 90);
    expectBasisRotation(axisQuat('z', 90), 'z', 90);
  });

  it('180° rotations about each axis match analytical matrices', () => {
    expectBasisRotation(axisQuat('x', 180), 'x', 180);
    expectBasisRotation(axisQuat('y', 180), 'y', 180);
    expectBasisRotation(axisQuat('z', 180), 'z', 180);
  });

  it('non-unit quaternion normalizes to the same rotation', () => {
    const q = axisQuat('z', 90).map((c) => c * 2) as [number, number, number, number];
    const m = quatToMatrix(q);
    const id = quatToMatrix(axisQuat('z', 90));
    m.forEach((v, i) => expect(v).toBeCloseTo(id[i]!, 12));
  });

  it('applyPlacement then invertApplyPlacement round-trips exactly', () => {
    const pl = { p: [10, 20, 30] as [number, number, number], q: axisQuat('y', 90) };
    const w: [number, number, number] = [3, 4, 5];
    const g = applyPlacement(pl, w);
    const back = invertApplyPlacement(pl, g);
    back.forEach((v, i) => expect(v).toBeCloseTo(w[i]!, 12));
  });

  it('90° about Z maps local +X to global +Y (right-hand rule)', () => {
    const pl = { p: [0, 0, 0] as [number, number, number], q: axisQuat('z', 90) };
    const g = applyPlacement(pl, [1, 0, 0]);
    expect(g[0]).toBeCloseTo(0, 12);
    expect(g[1]).toBeCloseTo(1, 12);
    expect(g[2]).toBeCloseTo(0, 12);
  });

  it('planeBasis: u/v/n are the rotated X/Y/Z columns, orthonormal', () => {
    const pl = { p: [5, 6, 7] as [number, number, number], q: axisQuat('x', 90) };
    const { u, v, n } = planeBasis(pl);
    expect(u).toEqual([1, 0, 0]); // exact — matrix entries are exact for this quat
    v.forEach((val, i) => expect(val).toBeCloseTo([0, 0, 1][i]!, 12));
    n.forEach((val, i) => expect(val).toBeCloseTo([0, -1, 0][i]!, 12));
    // orthonormality
    const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(Math.abs(dot(u, v))).toBeLessThan(EPS);
    expect(Math.abs(dot(v, n))).toBeLessThan(EPS);
    expect(Math.abs(dot(u, n))).toBeLessThan(EPS);
  });

  it('placementOfProp reads Px/Py/Pz and Q0..Q3; missing → identity', () => {
    const pl = placementOfProp(propWithPlacement({ Px: '1', Py: '2', Pz: '3', Q0: '0', Q1: '0', Q2: '0.7071067811865476', Q3: '0.7071067811865476' }));
    expect(pl.p).toEqual([1, 2, 3]);
    expect(pl.q[3]).toBeCloseTo(Math.SQRT1_2, 12);
    const id = placementOfProp(undefined);
    expect(id).toEqual({ p: [0, 0, 0], q: [0, 0, 0, 1] });
  });
});
