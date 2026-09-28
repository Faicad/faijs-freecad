/**
 * draft-draw — A4 (2026-09-28 plan): Draft drawing objects → `cad.draw`.
 *
 * Draft 2D objects (`Part::Part2DObjectPython` — Wire/Circle/… proxies) store
 * their geometry ONLY in the frozen `Shape` .brp member (probe 2026-09-28,
 * Bathroom_cabinet_sink: the XML properties carry attachment/expression data,
 * no point lists). The drawing is therefore REBUILT from the .brp's wireframe
 * polylines: every WIRE becomes one contour, emitted as a top-level local
 * function whose body chains `pen.polyline([…])` — the .fai.js statement
 * language rejects arrow functions in EXPRESSION position (syntax-design §2.4
 * E_VALUE) but function BODIES allow them (§2.3), so the emitted shape is
 * `function <name>() { return cad.draw((pen) => pen.polyline(…)); }` plus one
 * call statement per contour.
 *
 * ⚠️ Two measurement-driven corrections (2026-09-28 second pass) — the first
 * implementation looked plausible and was wrong twice over:
 *
 * 1. **`wireframe().edgeGroups` is NOT a traversal order.** It is
 *    `TopExp::MapShapes` order over the whole shape, so chaining *consecutive
 *    array entries* is meaningless. Measured on `Clone2D.Shape.brp` (one 15-edge
 *    wire): 3 of 14 consecutive pairs share an endpoint, the rest sit up to
 *    3.43 mm apart. The old code chained those entries, which shattered every
 *    Draft wire into per-edge fragments — across 8 products that inflated 145
 *    objects into 781 "contours", 95% of them geometrically open, i.e. incapable
 *    of forming a face.
 *
 * 2. **The continuity tolerance was below the noise floor.** `wireframe()`
 *    returns a `Float32Array`; two independently tessellated edges sampling the
 *    SAME vertex can differ by ~1 ulp of the coordinate magnitude (measured
 *    float32 step 6.1e-5 at |coord| ≈ 300). A 1e-6 epsilon can therefore never
 *    match them; see {@link draftTolerance}.
 *
 * The fix is to walk `getSubShapes(shape, 'wire')` — real wire topology, one
 * contour per wire — and order each wire's edges by ENDPOINT MATCHING
 * ({@link chainWireContours}) instead of by array position. Verified on the same
 * file: 15/15 edges consumed, chain closes.
 */
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';
import { memberText, type FcstdArchive } from './unpack.js';
import type { FcstdObject } from './document.js';
import { shapeBrpFile } from './external-geo.js';

/** Tessellation deflection for the rebuilt drawing (mm) — matches the probe. */
const DRAFT_DEFLECTION = 0.01;

/** One rebuilt drawing contour: an ordered polyline in the object's OWN 2D frame. */
export interface DraftContour {
  /**
   * polyline points (x, y) in traversal order (z dropped, ≈0). When `closed`, the
   * contour's duplicate tail point is already removed — the closing segment is
   * implicit, so `points` lists each corner exactly once.
   */
  points: [number, number][];
  /**
   * true when the walk returned to `points[0]`. GOTCHA: this is a property of the
   * WHOLE contour, not of a wireframe edge — `edgeGroups`-era code tested each
   * edge's own first/last point, which only ever fires for a full-circle edge and
   * so reported 95% of real loops as open.
   */
  closed: boolean;
}

/** The rebuilt drawing of one Draft object: one contour per wire. */
export interface DraftDrawing {
  contours: DraftContour[];
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
 * Endpoint-match tolerance for {@link chainWireContours}, derived from the data.
 *
 * `wireframe()` hands back a `Float32Array`, so two independently tessellated
 * edges that end on the SAME topological vertex can disagree by up to ~1 ulp of
 * the coordinate magnitude (ulp = 2^(ceil(log2 m) − 23); measured 6.1e-5 at
 * m ≈ 300). The old 1e-6 constant sat BELOW that noise floor, so the chain broke
 * at every edge boundary. `1e-5·m` clears the worst case by ~25× while staying
 * ~1000× under the millimetre gaps between genuinely distinct vertices (measured
 * 3.43 mm max on the same file).
 *
 * @param polylines - the wire's edge polylines (all endpoints considered).
 * @returns the absolute tolerance in mm (never below 1e-9).
 */
export function draftTolerance(polylines: [number, number][][]): number {
  let magnitude = 0;
  for (const line of polylines) {
    for (const p of line) magnitude = Math.max(magnitude, Math.abs(p[0]), Math.abs(p[1]));
  }
  return Math.max(1e-9, 1e-5 * magnitude);
}

/**
 * Order one wire's edge polylines into contours by matching shared endpoints.
 *
 * Rationale in the module header: `edgeGroups` order is not a traversal order, so
 * the only reliable way to reassemble a wire is to join edges that share an
 * endpoint. A wire is connected by construction, but the walk is written to
 * degrade honestly: it restarts on any leftover edge, so a wire whose matching
 * fails yields several contours rather than silently dropping edges.
 *
 * @param polylines - the wire's edge polylines (each at least 2 points).
 * @param tol - endpoint-match tolerance in mm (see {@link draftTolerance}).
 * @returns the rebuilt contours; a closed contour's duplicate tail point is
 *   already folded away (see {@link DraftContour.points}).
 */
export function chainWireContours(polylines: [number, number][][], tol: number): DraftContour[] {
  const near = (a: [number, number], b: [number, number]): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

  const used = new Array<boolean>(polylines.length).fill(false);
  const contours: DraftContour[] = [];

  for (let seed = 0; seed < polylines.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;
    let points: [number, number][] = [...polylines[seed]!];

    // Grow both ends until the chain stops matching — a seed inside a loop must
    // extend forwards AND backwards, which a tail-only walk would miss.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < polylines.length; i++) {
        if (used[i]) continue;
        const p = polylines[i]!;
        const head = points[0]!;
        const tail = points[points.length - 1]!;
        if (near(p[0]!, tail)) {
          points = points.concat(p.slice(1));
        } else if (near(p[p.length - 1]!, tail)) {
          points = points.concat([...p].reverse().slice(1));
        } else if (near(p[p.length - 1]!, head)) {
          points = [...p].slice(0, -1).concat(points);
        } else if (near(p[0]!, head)) {
          points = [...p].reverse().slice(0, -1).concat(points);
        } else {
          continue;
        }
        used[i] = true;
        progressed = true;
        break;
      }
    }

    const closed = points.length > 3 && near(points[0]!, points[points.length - 1]!);
    if (closed) {
      // Fold the duplicated tail away: the contour returns to its start
      // approximately, and the emitted `close` segment must land on `points[0]`
      // exactly (a 1e-6-rounded near-duplicate would leave a degenerate edge).
      points = points.slice(0, -1);
    }
    if (points.length < 2 || (closed && points.length < 3)) continue;
    // A zero-extent chain is not a contour: emitting it would hand `polyline` a
    // degenerate run and `makeFace` a wire it cannot close.
    let span = 0;
    for (const p of points) span = Math.max(span, Math.abs(p[0] - points[0]![0]), Math.abs(p[1] - points[0]![1]));
    if (span <= tol) continue;
    contours.push({ points, closed });
  }
  return contours;
}

/**
 * Read one wireframe payload's edge polylines, dropping degenerate ones.
 *
 * `edgeGroups` is a flat `[pointStart, byteEnd, edgeHash]` triple per edge, in
 * `TopExp::MapShapes` order — NOT a traversal order (see the module header).
 *
 * @param wf - the kernel wireframe payload.
 * @returns the edge polylines, each with at least two distinct points.
 */
function edgePolylines(wf: { points: Float32Array; edgeGroups: number[] }): [number, number][][] {
  const polylines: [number, number][][] = [];
  for (let g = 0; g * 3 + 1 < wf.edgeGroups.length; g++) {
    const g0 = wf.edgeGroups[g * 3]!;
    const n = Math.floor(wf.edgeGroups[g * 3 + 1]! / 3);
    if (n < 2) continue;
    const pts: [number, number][] = [];
    for (let p = 0; p < n; p++) pts.push([wf.points[g0 + p * 3]!, wf.points[g0 + p * 3 + 1]!]);
    // Collapse consecutive repeats so a zero-length edge cannot anchor the walk.
    const deduped = pts.filter(
      (pt, i) => i === 0 || Math.hypot(pt[0] - pts[i - 1]![0], pt[1] - pts[i - 1]![1]) > 1e-9,
    );
    if (deduped.length >= 2) polylines.push(deduped);
  }
  return polylines;
}

/**
 * Extract the .brp wireframe of a Draft object as 2D contours.
 *
 * Contours are grouped by real topology where it exists: one contour set per WIRE
 * (`getSubShapes(shape, 'wire')`). GOTCHA (2026-09-28, `Chair` / `Shape2DView`): a
 * Draft projection object can store an **edge compound with no wires at all**, so
 * a wire-only pass silently produced nothing and the object fell back to a dead
 * `shape-asset` import — the exact regression A4 exists to avoid. When no wires
 * are present the flat edge set is walked instead; `chainWireContours` handles it
 * identically (the shape's wires are reconstructed by endpoint matching).
 *
 * Edges are returned in the shape's OWN coordinates: the frozen .brp of a Draft
 * object carries LOCAL coordinates; the object's Placement applies on top and is
 * handled by the placement pass (same two-frame rule as sketches).
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
  const kernel = (await initOcctWasm()) as unknown as {
    fromBREP: (s: string) => number;
    wireframe: (s: number, deflection: number) => { points: Float32Array; edgeGroups: number[] };
    getSubShapes: (s: number, t: string) => number[];
    release: (s: number) => void;
  };
  let shape: number;
  try {
    shape = kernel.fromBREP(brp);
  } catch {
    return undefined;
  }
  const contours: DraftContour[] = [];
  const collect = (handle: number): void => {
    const polylines = edgePolylines(kernel.wireframe(handle, DRAFT_DEFLECTION));
    if (polylines.length > 0) contours.push(...chainWireContours(polylines, draftTolerance(polylines)));
  };
  try {
    let wires: number[] = [];
    try {
      wires = kernel.getSubShapes(shape, 'wire');
    } catch {
      wires = [];
    }
    if (wires.length > 0) {
      for (const wire of wires) {
        try {
          collect(wire);
        } catch {
          // One unreadable wire must not lose the object's other contours.
        } finally {
          kernel.release(wire);
        }
      }
    } else {
      // Edge compound (a Draft `Shape2DView`): no wire topology to group by.
      try {
        collect(shape);
      } catch {
        /* unreadable shape → no contours */
      }
    }
  } finally {
    kernel.release(shape);
  }
  return contours.length > 0 ? { contours } : undefined;
}

/**
 * Render one contour as a `cad.draw` session body (function-body source).
 *
 * The points travel as ONE array literal: a `.fai.js` member chain nests one
 * `MemberExpression`/`CallExpression` level per segment, and the parser caps AST
 * depth at 100 — contours here routinely carry hundreds to thousands of points
 * (measured: one Draft object held a 7823-point loop).
 *
 * @param contour - the rebuilt contour (from {@link chainWireContours}).
 * @returns the JS expression source for the session body, e.g.
 *   `(pen) => pen.polyline([[0, 0], [40, 0]], true)`.
 */
export function renderDrawContour(contour: DraftContour): string {
  // round to 1e-6: keeps the emitted source stable and readable at mm scale
  const f = (n: number): string => String(Math.round(n * 1e6) / 1e6);
  // GOTCHA: `points` already excludes a closed contour's duplicate tail (see
  // DraftContour.points) — stripping again here would silently drop a real
  // corner (a square would emit 3 sides).
  return `(pen) => pen.polyline([${contour.points
    .map((p) => `[${f(p[0])}, ${f(p[1])}]`)
    .join(', ')}], ${contour.closed ? 'true' : 'false'})`;
}
