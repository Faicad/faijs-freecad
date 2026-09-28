/**
 * A4 (2026-09-28 plan) — Draft drawing rebuild tests.
 *
 * Pins the draw-session rendering (pen chaining / close semantics) and the
 * Draft 2D object predicate. The OCCT .brp extraction itself is exercised by
 * the corpus probe (`scripts/`); here it is stubbed at the rendering layer so
 * the emitted session source is verifiable without wasm.
 */
import { describe, expect, it } from 'vitest';
import { isDraft2DObject, renderDrawSession, type DraftDrawing } from './draft-draw.js';
import type { FcstdObject } from './document.js';

function draftObj(type = 'Part::Part2DObjectPython'): FcstdObject {
  return { name: 'Wire045', type, properties: new Map() } as unknown as FcstdObject;
}

describe('isDraft2DObject', () => {
  it('GOTCHA: Draft drawings carry the Part::Part2DObjectPython proxy type — other Part types are not drawings', () => {
    expect(isDraft2DObject(draftObj('Part::Part2DObjectPython'))).toBe(true);
    expect(isDraft2DObject(draftObj('Part::Feature'))).toBe(false);
    expect(isDraft2DObject(draftObj('Sketcher::SketchObject'))).toBe(false);
  });
});

describe('renderDrawSession', () => {
  it('renders one closed edge as moveTo → lineTo… → close', () => {
    const d: DraftDrawing = {
      edges: [{ points: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]], closed: true }],
    };
    const s = renderDrawSession(d);
    expect(s).toBe('(pen) => pen.moveTo(0, 0).lineTo(40, 0).lineTo(40, 30).lineTo(0, 30).close()');
  });

  it('chains consecutive open edges (lineTo continues the pen, moveTo lifts it)', () => {
    const d: DraftDrawing = {
      edges: [
        { points: [[0, 0], [10, 0]], closed: false },
        { points: [[10, 0], [10, 10]], closed: false }, // continues: no second moveTo
        { points: [[50, 50], [60, 60]], closed: false }, // disconnected: moveTo
      ],
    };
    const s = renderDrawSession(d);
    expect(s).toBe(
      '(pen) => pen.moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).moveTo(50, 50).lineTo(60, 60)',
    );
  });

  it('GOTCHA: close() resets the pen — the NEXT edge starts with moveTo even at the same point', () => {
    const d: DraftDrawing = {
      edges: [
        { points: [[0, 0], [10, 0], [0, 0]], closed: true },
        { points: [[0, 0], [5, 5]], closed: false }, // same start, but pen was lifted by close()
      ],
    };
    const s = renderDrawSession(d);
    expect(s).toBe('(pen) => pen.moveTo(0, 0).lineTo(10, 0).close().moveTo(0, 0).lineTo(5, 5)');
  });

  it('rounds coordinates to 1e-6 for stable emitted source', () => {
    const d: DraftDrawing = { edges: [{ points: [[0.123456789, 0], [10, 0.9999999999]], closed: false }] };
    const s = renderDrawSession(d);
    expect(s).toContain('0.123457');
    expect(s).toContain('lineTo(10, 1)');
  });
});
