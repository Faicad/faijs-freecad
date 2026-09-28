/**
 * draft-draw — A4 (2026-09-28 plan): Draft drawing objects → `cad.draw`.
 *
 * Draft 2D objects (`Part::Part2DObjectPython` — Wire/Circle/… proxies) store
 * their geometry ONLY in the frozen `Shape` .brp member (probe 2026-09-28,
 * Bathroom_cabinet_sink: the XML properties carry attachment/expression data,
 * no point lists). The drawing process is therefore REBUILT from the .brp's
 * wireframe polylines: each edge becomes a chained pen call
 * (moveTo/lineTo/…/close) inside a top-level local function — the .fai.js
 * statement language rejects arrow functions in EXPRESSION position
 * (syntax-design §2.4 E_VALUE), but function BODIES allow them (§2.3), so the
 * emitted shape is `function <name>() { return cad.draw((pen) => …) }` plus
 * one call statement (probe-draw.fai.js verified `check` OK).
 */
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';
import { memberText, type FcstdArchive } from './unpack.js';
import type { FcstdObject } from './document.js';
import { shapeBrpFile } from './external-geo.js';

/** One rebuilt drawing edge: an open polyline in the object's OWN 2D frame. */
export interface DraftEdge {
  /** polyline points (x, y) in sketch-local coordinates (z dropped, ≈0) */
  points: [number, number][];
  /** true when the edge closes on itself (first ≈ last point) */
  closed: boolean;
}

/** The rebuilt drawing of one Draft object. */
export interface DraftDrawing {
  edges: DraftEdge[];
}

/**
 * True when the object is a Draft 2D drawing object (A4 target class).
 * @param obj - the FCStd object to test.
 * @returns true when the object is a `Part::Part2DObjectPython` drawing.
 */
export function isDraft2DObject(obj: FcstdObject): boolean {
  return obj.type === 'Part::Part2DObjectPython';
}

/**
 * Extract the .brp wireframe edges of a Draft object as 2D polylines.
 *
 * The OCCT `wireframe` tessellation returns a flat point array plus edge
 * groups (same contract `resolveExternalGeometry` consumes — Edge13 =
 * edgeGroups[12], verified against hole_puzzle). Edges are returned in the
 * shape's OWN coordinates: the frozen .brp of a Draft object already carries
 * its Placement? — NO (GOTCHA): unlike feature caches, Draft Shape .brp
 * members store LOCAL coordinates; the object's Placement applies on top and
 * is handled by the placement pass (same two-frame rule as sketches).
 *
 * @param obj - the Draft 2D object.
 * @param archive - the FCStd container (to read the .brp member).
 * @returns the rebuilt drawing, or undefined when the object has no readable shape.
 */
export async function extractDraftDrawing(obj: FcstdObject, archive: FcstdArchive): Promise<DraftDrawing | undefined> {
  const brpFile = shapeBrpFile(obj);
  if (!brpFile) return undefined;
  const brp = memberText(archive, brpFile);
  if (!brp) return undefined;
  const kernel: {
    fromBREP: (s: string) => unknown;
    wireframe: (s: unknown, deflection: number) => { points: Float32Array; edgeGroups: number[] };
  } = (await initOcctWasm()) as never;
  let wf: { points: Float32Array; edgeGroups: number[] };
  try {
    wf = kernel.wireframe(kernel.fromBREP(brp), 0.01);
  } catch {
    return undefined;
  }
  const edges: DraftEdge[] = [];
  // edgeGroups is a flat [start, byteEnd, _] triple per edge (same contract as
  // resolveExternalGeometry: Edge13 = edgeGroups[12]).
  for (let g = 0; g * 3 + 1 < wf.edgeGroups.length; g++) {
    const g0 = wf.edgeGroups[g * 3]!;
    const g1 = wf.edgeGroups[g * 3 + 1]!;
    if (g0 === undefined || g1 === undefined) continue;
    const n = Math.floor(g1 / 3);
    if (n < 2) continue;
    const pts: [number, number][] = [];
    for (let p = 0; p < n; p++) {
      pts.push([wf.points[g0 + p * 3]!, wf.points[g0 + p * 3 + 1]!]);
    }
    // dedupe consecutive identical points
    const deduped = pts.filter(
      (pt, i) => i === 0 || Math.hypot(pt[0] - pts[i - 1]![0], pt[1] - pts[i - 1]![1]) > 1e-9,
    );
    if (deduped.length < 2) continue;
    const first = deduped[0]!;
    const last = deduped[deduped.length - 1]!;
    edges.push({ points: deduped, closed: Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6 });
  }
  if (edges.length === 0) return undefined;
  return { edges };
}

/**
 * Render one rebuilt drawing as a `cad.draw` pen chain (function-body source).
 *
 * Consecutive edges are chained: an edge starting where the previous ended
 * continues the pen (lineTo); otherwise the pen lifts (moveTo). A closed edge
 * (or a chain returning to its start) ends with `.close()`.
 *
 * @param drawing - the rebuilt drawing (from {@link extractDraftDrawing}).
 * @returns the JS expression source for the session body, e.g.
 *   `(pen) => pen.moveTo(0, 0).lineTo(40, 0).close()`.
 */
export function renderDrawSession(drawing: DraftDrawing): string {
  const f = (n: number): string => {
    // round to 1e-6 to keep the emitted source stable and readable
    const r = Math.round(n * 1e6) / 1e6;
    return String(r);
  };
  const parts: string[] = [];
  let penAt: [number, number] | undefined;
  for (const edge of drawing.edges) {
    // GOTCHA: a closed edge's polyline repeats its FIRST point at the end
    // (the .brp tessellation closes the loop explicitly) — drop that tail
    // point; `.close()` closes the contour without a doubled lineTo.
    const pts = edge.closed && edge.points.length > 2
      ? edge.points.slice(0, -1)
      : edge.points;
    const [sx, sy] = pts[0]!;
    const continues = penAt !== undefined &&
      Math.hypot(sx - penAt[0], sy - penAt[1]) < 1e-6;
    if (!parts.length || !continues) {
      parts.push(`moveTo(${f(sx)}, ${f(sy)})`);
    }
    for (let i = 1; i < pts.length; i++) {
      parts.push(`lineTo(${f(pts[i]![0])}, ${f(pts[i]![1])})`);
    }
    const last = pts[pts.length - 1]!;
    if (edge.closed) {
      parts.push('close()');
      penAt = undefined;
    } else {
      penAt = [last[0], last[1]];
    }
  }
  return `(pen) => pen.${parts.join('.')}`;
}
