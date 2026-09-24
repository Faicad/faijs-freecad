/**
 * M3 tests — solver channel end-to-end on a synthetic rectangle, mirroring the
 * M0 probe but through the FCStd parse → solve → verify pipeline.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseSketchObject } from './sketch-parse.js';
import { createPlanegcsSolver } from './planegcs-backend.js';
import type { SketchSolver } from './sketch-solver.js';
import { isOk } from '@faicad/faijs/api/result';
import { maxPointDistance, classifySketch } from './sketch-verify.js';
import type { FcstdProperty } from './document.js';

let solver: SketchSolver;
beforeAll(async () => {
  solver = await createPlanegcsSolver();
});

function geomProp(children: string): FcstdProperty {
  // build real child structure so parseGeometryList can walk it
  const geometryChildren = [...children.matchAll(/<Geometry type="([^"]+)">(<\w+[^>]*\/>)<\/Geometry>/g)].map(
    (m) => ({
      tagName: 'Geometry',
      name: 'Geometry',
      type: m[1]!,
      attributes: { type: m[1]! },
      children: [parseInner(m[2]!)],
      valueXml: m[2]!,
      valueText: '',
    }),
  );
  return {
    tagName: 'Geometry',
    name: 'Geometry',
    type: 'Part::PropertyGeometryList',
    children: [
      {
        tagName: 'GeometryList',
        name: 'GeometryList',
        type: '',
        attributes: { count: String(geometryChildren.length) },
        children: geometryChildren,
        valueXml: `<GeometryList count="${geometryChildren.length}">${children}</GeometryList>`,
        valueText: '',
      },
    ],
    valueXml: `<GeometryList count="${geometryChildren.length}">${children}</GeometryList>`,
    valueText: '',
    attributes: {},
  };
}

/** minimal hand-rolled inner-element parser for test fixtures: <Tag a="1" b="2"/> */
function parseInner(tag: string): FcstdProperty {
  const m = /^<(\w+)\s([^>]*)\/>$/.exec(tag);
  if (!m) throw new Error(`bad fixture tag: ${tag}`);
  const attrs: Record<string, string> = {};
  for (const pair of m[2]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[pair[1]!] = pair[2]!;
  return { tagName: m[1]!, name: m[1]!, type: '', attributes: attrs, children: [], valueXml: tag, valueText: '' };
}

describe('sketch solver channel (M3)', () => {
  it('solves a rectangle to the stored solution (L0)', async () => {
    // rectangle 40x30 at (10,20): lines stored (bottom/right/top/left)
    const geoms = parseSketchObject(
      geomProp(
        `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="10" StartY="20" StartZ="0" EndX="50" EndY="20" EndZ="0"/></Geometry>` +
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="50" StartY="20" StartZ="0" EndX="50" EndY="50" EndZ="0"/></Geometry>` +
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="50" StartY="50" StartZ="0" EndX="10" EndY="50" EndZ="0"/></Geometry>` +
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="10" StartY="50" StartZ="0" EndX="10" EndY="20" EndZ="0"/></Geometry>`,
      ),
      undefined,
      true,
    ).geoms;
    expect(geoms.length).toBe(4);
    expect(geoms[0]).toMatchObject({ kind: 'line', x1: 10, y1: 20, x2: 50, y2: 20 });

    const result = await solver.solve(geoms, [
      { index: 0, type: 2, refs: [{ geoId: 0, pos: 0 }], value: 0, isDriving: true, name: '' }, // horizontal l0
      { index: 1, type: 3, refs: [{ geoId: 1, pos: 0 }], value: 0, isDriving: true, name: '' }, // vertical l1
      { index: 2, type: 2, refs: [{ geoId: 2, pos: 0 }], value: 0, isDriving: true, name: '' }, // horizontal l2
      { index: 3, type: 3, refs: [{ geoId: 3, pos: 0 }], value: 0, isDriving: true, name: '' }, // vertical l3
      { index: 4, type: 7, refs: [{ geoId: 0, pos: 1 }, { geoId: 0, pos: 2 }], value: 40, isDriving: true, name: '' }, // DistanceX
      { index: 5, type: 8, refs: [{ geoId: 3, pos: 1 }, { geoId: 3, pos: 2 }], value: -30, isDriving: true, name: '' }, // DistanceY (signed: downward)
    ]);
    expect(isOk(result)).toBe(true);
    const outcome = (result as { value: { geoms: typeof geoms; converged: boolean; reason?: string } }).value;
    expect(outcome.converged, `reason: ${outcome.reason}`).toBe(true);
    // D2: re-solve must reproduce the stored geometry
    const delta = maxPointDistance(outcome.geoms, geoms);
    expect(delta).toBeLessThan(1e-6);
    const verdict = classifySketch(outcome as never, geoms, 1e-6);
    expect(verdict.level).toBe('L0');
  });

  it('flags external geometry (D4 → L2 via preBlocked)', () => {
    const verdict = classifySketch(undefined, [], 1e-6, 'external-geometry');
    expect(verdict).toMatchObject({ level: 'L2', reason: 'external-geometry' });
  });

  // GOTCHA (P3-2, Mannequin_mp corpus 2026-09-24): constraint types 15
  // (InternalAlignment), 17 (Block) and 19 (Weight) do NOT affect the solved
  // geometry — they used to fail the WHOLE sketch with
  // `unsupported-constraint`. They must be dropped-and-recorded
  // (droppedConstraints) instead, letting the sketch still solve to L0.
  it('solves a sketch containing ignorable constraint types 15/17/19 (dropped, not fatal)', async () => {
    const geoms = parseSketchObject(
      geomProp(
        `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="10" StartY="20" StartZ="0" EndX="50" EndY="20" EndZ="0"/></Geometry>` +
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="50" StartY="20" StartZ="0" EndX="50" EndY="50" EndZ="0"/></Geometry>` +
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="50" StartY="50" StartZ="0" EndX="10" EndY="50" EndZ="0"/></Geometry>` +
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="10" StartY="50" StartZ="0" EndX="10" EndY="20" EndZ="0"/></Geometry>`,
      ),
      undefined,
      true,
    ).geoms;
    const result = await solver.solve(geoms, [
      { index: 0, type: 2, refs: [{ geoId: 0, pos: 0 }], value: 0, isDriving: true, name: '' },
      { index: 1, type: 3, refs: [{ geoId: 1, pos: 0 }], value: 0, isDriving: true, name: '' },
      { index: 2, type: 15, refs: [{ geoId: 0, pos: 1 }, { geoId: 1, pos: 1 }], value: 0, isDriving: true, name: '' }, // InternalAlignment
      { index: 3, type: 17, refs: [{ geoId: 2, pos: 0 }], value: 0, isDriving: true, name: '' }, // Block
      { index: 4, type: 19, refs: [{ geoId: 0, pos: 0 }], value: 1, isDriving: true, name: '' }, // Weight
      { index: 5, type: 7, refs: [{ geoId: 0, pos: 1 }, { geoId: 0, pos: 2 }], value: 40, isDriving: true, name: '' },
      { index: 6, type: 8, refs: [{ geoId: 3, pos: 1 }, { geoId: 3, pos: 2 }], value: -30, isDriving: true, name: '' },
    ]);
    expect(isOk(result)).toBe(true);
    const outcome = (result as { value: { geoms: typeof geoms; converged: boolean; reason?: string; droppedConstraints: number[] } }).value;
    expect(outcome.converged, `reason: ${outcome.reason}`).toBe(true);
    // ignorable types recorded explicitly (no silent loss)
    expect(outcome.droppedConstraints).toEqual(expect.arrayContaining([2, 3, 4]));
    const delta = maxPointDistance(outcome.geoms, geoms);
    expect(delta).toBeLessThan(1e-6);
    const verdict = classifySketch(outcome as never, geoms, 1e-6);
    expect(verdict.level).toBe('L0');
  });
});
