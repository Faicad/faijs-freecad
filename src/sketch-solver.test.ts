/**
 * M3 tests — solver channel end-to-end on a synthetic rectangle, mirroring the
 * M0 probe but through the FCStd parse → solve → verify pipeline.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseSketchObject } from './sketch-parse.js';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import type { SketchSolver } from '@faicad/faijs-sketch';
import { isOk } from '@faicad/faijs/api/result';
import { maxPointDistance, classifySketch } from '@faicad/faijs-sketch';
import type { FcstdProperty } from './document.js';

let solver: SketchSolver;
beforeAll(async () => {
  solver = await createNodePlanegcsSolver();
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

  // GOTCHA (corner corpus, 2026-09-28): a sketch may reference an external
  // VERTEX — `VertexN` is projected to a ONE-point polyline at geoId -3, and
  // constraints address it as {geoId: -3, pos: 1}. The backend used to resolve
  // external refs only through its `externalLines` map (2-point edges), so
  // every constraint onto an external vertex compiled away silently: no
  // dropped-constraint record, no failure — just a sketch solved to the wrong
  // geometry (L1 by delta, or L0 by luck).
  //
  // GOTCHA (fixture design, 2026-09-28): the geometry must NOT start exactly at
  // the origin. An under-constrained free point sitting on the implicit root
  // point (0,0) makes planegcs's LM return `Failed` (probed both directly
  // through GcsWrapper and through this backend); shifted to (5,5) the same
  // constraints converge. Fully-constrained systems at the origin are fine
  // (see the rectangle case below), so this is a numerical degeneracy of tiny
  // under-constrained systems, not an external-geometry issue.
  it('resolves a constraint onto an external vertex point (single-point external)', async () => {
    const fixture = () =>
      parseSketchObject(
        geomProp(
          `<Geometry type="Part::GeomLineSegment"><LineSegment StartX="5" StartY="5" StartZ="0" EndX="45" EndY="5" EndZ="0"/></Geometry>`,
        ),
        undefined,
        true,
      ).geoms;
    const cons = [
      { index: 0, type: 2, refs: [{ geoId: 0, pos: 0 }], value: 0, isDriving: true, name: '' }, // Horizontal
      { index: 1, type: 7, refs: [{ geoId: 0, pos: 1 }, { geoId: 0, pos: 2 }], value: 40, isDriving: true, name: '' }, // DistanceX = 40
      { index: 2, type: 1, refs: [{ geoId: 0, pos: 1 }, { geoId: -3, pos: 1 }], value: 0, isDriving: true, name: '' }, // Coincident onto the external vertex
    ];

    // Control: with no external geometry supplied, the constraint must land in
    // the dropped ledger — that is the documented "no silent loss" contract.
    const bare = await solver.solve(fixture(), cons);
    expect(isOk(bare)).toBe(true);
    expect((bare as { value: { droppedConstraints: number[] } }).value.droppedConstraints).toContain(2);

    // With the external vertex supplied the constraint must actually move the
    // line's start onto it: (5,5)→(10,20) start, end 40 further along.
    const geoms = fixture();
    const external = [{ geoId: -3, polyline: [[10, 20]] as [number, number][] }];
    const result = await solver.solve(geoms, cons, external);
    expect(isOk(result)).toBe(true);
    const outcome = (result as { value: { geoms: typeof geoms; converged: boolean; reason?: string } }).value;
    expect(outcome.converged, `reason: ${outcome.reason}`).toBe(true);
    const line = outcome.geoms[0] as unknown as { x1: number; y1: number; x2: number; y2: number };
    expect(line.x1).toBeCloseTo(10, 6);
    expect(line.y1).toBeCloseTo(20, 6);
    expect(line.x2).toBeCloseTo(50, 6);
    expect(line.y2).toBeCloseTo(20, 6);
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
