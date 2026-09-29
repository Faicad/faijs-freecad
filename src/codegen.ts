/**
 * M5 — code generation: object graph + M4 call plans → model/*.fai.js.
 *
 * M5.1 topological order: Body.Group order wins where present; otherwise
 * PropertyLink dependency order. Cycles / missing deps → baked (no fallback
 * heuristics — explicit downgrade per plan §12).
 * M5.2 lowering: params → JS constants; calls → `let <Name> = cad.x(...)` where
 * `<Name>` is the FCStd source object name (sanitized to a legal JS identifier,
 * see emitVar); statement ids sN. Sketch contours enter as blueprint literals.
 *
 * 本文件为 Placement 发射平台 `cad.place`（旋转四元数 + 平移，单点）、为产物聚合发射
 * 平台 `cad.compound`（几何复合体，内核 `makeCompound`，持 OCCT 句柄）。这两个是 faijs
 * 平台几何 op（H11，方案 §4），不再借用 `../3d_editor` 的 `cad.group` /
 * `cad.translate` / `cad.rotate_euler`（编辑器交互 op，JSDoc 已 @deprecated）。
 */
import type { FcstdDocument } from './document.js';
import type { CadCall, TranslateVerdict } from './feature-translate.js';
import {
  translateObject, isJsExpr, jsExpr, BODY_CHAIN_BASE,
  LINK_INPUT_PROPS, LINK_LIST_INPUT_PROPS,
} from './feature-translate.js';
import type { FilletEdgeEntry } from './fillet-edges.js';
import type { LeafParam } from './params.js';
import type { Contour, SketchGeom, SketchConstraint } from '@faicad/faijs-sketch';
import { type Placement, isIdentityPlacement, invertApplyPlacement, planeBasis } from './placement.js';
import { isNonModelingType } from './structural-types.js';
import type { DraftDrawing } from './draft-draw.js';

/** Per-object codegen outcome: what was emitted for one FCStd object. */
export interface GenObjectResult {
  /** FCStd object name */
  name: string;
  /** FCStd type id */
  type: string;
  /** variable name bound in generated code (sanitized source object name) or undefined when baked */
  variable?: string;
  calls: CadCall[];
  disposition: 'translated' | 'baked' | 'preserved-only';
  reason?: string;
  /** M3 sketch verdict when the object is a sketch */
  sketch?: { level: 'L0' | 'L1' | 'L2'; reason?: string; loopCount?: number };
}

/** Full codegen output: lowered calls, per-object ledger and generated script(s). */
export interface GenResult {
  /** ordered translated calls (dependency order) */
  calls: CadCall[];
  objects: GenObjectResult[];
  /** generated .fai.js source (single-file mode or the main/aggregate script) */
  code: string;
  /** M10.3: multi-file mode — one script per Body with translated geometry.
   * Empty in single-file mode. Paths are container-relative (model/<Name>.fai.js). */
  files: { path: string; code: string; body: string }[];
  /** M10.3: variable in main.fai.js holding the grouped result (multi-file mode) */
  rootVar?: string;
}

interface Node {
  name: string;
  obj: ReturnType<FcstdDocument['objects'][number]['properties']['get']> extends never ? never : FcstdDocument['objects'][number];
  deps: Set<string>;
  verdict?: TranslateVerdict;
  variable?: string;
}

/** Extract link dependencies relevant for ordering. */
function depsOf(obj: FcstdDocument['objects'][number]): string[] {
  const out: string[] = [];
  // Single-value links / link-subs. The list is owned by feature-translate.ts
  // so it can never drift from what the translator actually reads — see
  // LINK_INPUT_PROPS for the GOTCHA that motivated sharing it.
  for (const p of LINK_INPUT_PROPS) {
    const el = obj.properties.get(p)?.children[0];
    const v = el?.attributes['value'];
    if (v) out.push(v);
  }
  // GOTCHA (ArchDetail corpus, 2026-09-21): App::PropertyLinkList properties.
  // `Shapes` is the multi-input geometry list (Part::MultiFuse / MultiCommon);
  // `Links` is Part::Compound's member list; `Sections` is Part::Loft's /
  // Part::Sweep's profile list; `Originals` is a pattern's source features.
  // None is a single-value link property, so missing them here left the
  // consumer with NO dependency on its members — Kahn then placed it at its
  // document position, and ArchDetail's compounds sit at doc index 10-14 while
  // every member sits at 269+ (Draft emits the wire first, the compound last,
  // but the file order is sorted by name). inputVar() found nothing yet →
  // `compound-missing-members` for all five compounds, for a pure ordering
  // reason. The same defect hit Part::Loft `Sections` (B2, Beds.FCStd
  // `Loft002` → `loft-section-baked-upstream:Sketch262`).
  for (const p of LINK_LIST_INPUT_PROPS) {
    const el = obj.properties.get(p)?.children[0];
    if (!el) continue;
    for (const link of el.children) {
      const v = link.attributes['value'];
      if (v) out.push(v);
    }
  }
  return out;
}

/**
 * GOTCHA (PadTest V6 failure): a `PartDesign::Body`'s feature list lives in
 * DIFFERENT properties depending on the FreeCAD version —
 *   - modern (0.19+): `Model` (App::PropertyLinkList), ordered
 *   - legacy: `Group` (App::PropertyLinkList)
 * The Tip is `Body.Tip`. Reading only `Group` on a modern document yields an
 * empty list → no same-Body chaining → features degrade to a loose
 * `cad.group` of overlapping siblings (PadTest rebuilt volume ≈ 5.2× the Tip's,
 * bboxDiag ≈ 2×). Prefer `Model`, fall back to `Group`.
 */
function bodyFeatureNames(obj: FcstdDocument['objects'][number]): string[] {
  for (const prop of ['Model', 'Group']) {
    const list = obj.properties.get(prop)?.children[0];
    if (!list) continue;
    const names: string[] = [];
    for (const link of list.children) {
      const v = link.attributes['value'];
      if (v) names.push(v);
    }
    if (names.length > 0) return names;
  }
  return [];
}

/**
 * M5.1/M5.2 — translate every object in dependency order and lower to JS.
 * `sketchVerdict` supplies the M3 outcome per sketch object name; sketches
 * whose contour feeds a Pad/Pocket appear as inputs.
 *
 * @param doc parsed FCStd object graph to translate
 * @param sketchVerdict per-sketch M3 verdict keyed by object name
 * @param sketchContours solved contours per L0 sketch, keyed by object name
 * @param baseName source base name used in generated file headers/labels
 * @param placements per-object Placement used to re-orient placed geometry; missing → identity
 * @param shapeCarriers objects whose Shape is a ZIP .brp member (pure-Shape carriers → shape-asset)
 * @param brokenShapeAssets objects whose Shape `file` attribute points at a missing/empty member (explicit gap)
 * @param filletEdgesData parsed PropertyFilletEdges binaries keyed by object name (Part::Chamfer/Fillet)
 * @param prePlacedAssets pre-placed .brp assets (embedded Locations ≠ identity) that must not be re-placed
 * @param sketchInputs canonical geoms+constraints per parameterizable sketch (cad.sketch emission)
 * @param draftDrawings rebuilt Draft drawings per Part::Part2DObjectPython (cad.sketchOnPlane ProfileLoop emission)
 * @param params the document's leaf parameters, emitted as `const p_*` headers in the
 *   modules that reference them (C1/C2/C4)
 * @returns the lowered call plan, per-object dispositions and generated code
 */
export function generateModel(
  doc: FcstdDocument,
  sketchVerdict: Map<string, { level: 'L0' | 'L1' | 'L2'; reason?: string; loopCount?: number }>,
  sketchContours: Map<string, Contour[]>,
  baseName: string,
  /** M8.3: per-object Placement (sketches + features); missing → identity */
  placements?: Map<string, Placement>,
  /** H7: objects whose Shape is a ZIP .brp member (pure-Shape carriers → shape-asset). */
  shapeCarriers?: ReadonlySet<string>,
  /** E4: objects whose Shape `file` attribute points at a missing/empty member (explicit gap). */
  brokenShapeAssets?: ReadonlySet<string>,
  /** P8: parsed PropertyFilletEdges binaries keyed by object name (Part::Chamfer/Fillet). */
  filletEdgesData?: ReadonlyMap<string, FilletEdgeEntry[]>,
  /** Pre-placed .brp assets (embedded Locations ≠ identity): never re-place these —
   *  double-applying the transform lands the shape 2× away (Beds Section → z=3000
   *  vs truth 1500). Derived per-object by the caller from the .brp header
   *  (`brpHasEmbeddedLocation`, unpack.ts). */
  prePlacedAssets?: ReadonlySet<string>,
  /** A2: canonical geoms+constraints per parameterizable sketch (cad.sketch emission). */
  sketchInputs?: ReadonlyMap<string, { geoms: SketchGeom[]; constraints: SketchConstraint[] }>,
  /** A1: rebuilt Draft drawings per Part::Part2DObjectPython (cad.sketchOnPlane ProfileLoop emission). */
  draftDrawings?: ReadonlyMap<string, DraftDrawing>,
  /** C1/C2/C4: the document's leaf parameters, emitted as top-level `const p_*`
   *  headers in the modules that reference them. */
  params?: readonly LeafParam[],
): GenResult {
  const byName = new Map(doc.objects.map((o) => [o.name, o]));
  // GOTCHA (test_geomop corpus, 2026-09-20): a dependency on a Body
  // CONTAINER (Part::Cut with Tool→Body) really waits for the Body's
  // features to have built the chain — expand the dep to the member
  // features so Kahn orders the consumer AFTER the chain exists (and
  // chainVar.get(Body) resolves). Treating the container itself as
  // satisfiable instead let the Cut run before the chain was built.
  const nodes = new Map<string, Node>();
  for (const obj of doc.objects) {
    const deps = new Set<string>();
    for (const d of depsOf(obj)) {
      const target = byName.get(d);
      if (target?.type === 'PartDesign::Body') {
        for (const m of bodyFeatureNames(target)) if (byName.has(m)) deps.add(m);
      } else {
        deps.add(d);
      }
    }
    nodes.set(obj.name, { name: obj.name, obj, deps });
  }

  // Kahn topological sort; objects with unbuilt deps fall back to insertion
  // order iteration until progress stalls (remaining are baked with reason).
  // M10.1: iteration order is Body.Group sequence FIRST (features of a Body
  // process in Group order so the D-C chain follows PartDesign semantics),
  // then leftover objects in document order.
  const groupSeq: string[] = [];
  for (const obj of doc.objects) {
    if (obj.type !== 'PartDesign::Body') continue;
    for (const m of bodyFeatureNames(obj)) {
      if (byName.has(m) && !groupSeq.includes(m)) groupSeq.push(m);
    }
  }
  const iterationOrder = [
    ...groupSeq,
    ...doc.objects.map((o) => o.name).filter((n) => !groupSeq.includes(n)),
  ];
  const order: string[] = [];
  const built = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const name of iterationOrder) {
      const node = nodes.get(name)!;
      if (built.has(node.name)) continue;
      if ([...node.deps].every((d) => built.has(d) || !byName.has(d) || byName.get(d)!.type === 'PartDesign::Body')) {
        built.add(node.name);
        order.push(node.name);
        progress = true;
      }
    }
  }
  // Cycle break (B2, 2026-09-26): the loop above stalls when a dependency
  // cycle exists. Stalled objects used to be DROPPED from `order` entirely —
  // they never reach the translator, so they keep the container's initial
  // `feature-translation-pending` disposition and surface as a translation gap
  // that actually describes an ordering problem. Emitting them anyway (in
  // iteration order) lets each one degrade to its own honest bake reason
  // (`*-missing-*` / `*-baked-upstream`) instead. Adding dependency edges —
  // which is how new translator features get wired — must not be able to make
  // an object disappear from the ledger.
  if (order.length < iterationOrder.length) {
    for (const name of iterationOrder) {
      if (built.has(name)) continue;
      built.add(name);
      order.push(name);
    }
  }

  const variables = new Map<string, string>();
  const results: GenObjectResult[] = [];
  const calls: CadCall[] = [];
  // faijs 变量名 = 任意合法 JS 标识符。FCStd→faijs 翻译器用**源对象的名字**
  // （`obj.name`）作变量名——可追溯、可读，且绝不可能是 `partN`。
  // `partN` 只是 UI 层生成用户操作代码的细节（`lang/allocate-id.ts` 的
  // `derivePartName`），随时可改、绝对不能依赖；翻译器自己更不准用。
  const RESERVED_JS_WORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch',
    'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'enum', 'await', 'static', 'implements', 'package', 'protected', 'interface',
    'private', 'public', 'arguments', 'eval', 'true', 'false', 'null', 'undefined',
    'NaN', 'Infinity',
  ]);
  const sanitizeIdent = (raw: string): string => {
    // 把任意 FCStd 对象名收敛为合法 JS 标识符：非法字符 → `_`，首字符非
    // 字母/`$`/`_` 时前置 `_`，保留字加 `_` 后缀。
    let s = raw.replace(/[^A-Za-z0-9_$]/g, '_');
    if (s.length === 0) s = '_';
    if (!/^[A-Za-z_$]/.test(s)) s = `_${s}`;
    if (RESERVED_JS_WORDS.has(s)) s = `${s}_`;
    return s;
  };
  // 变量名分配器：以源对象名（或带角色后缀的派生名）为基，去重后产出唯一合法
  // 标识符。绝不生成 `partN`。
  const emitVar = ((): ((raw: string) => string) => {
    const seen = new Set<string>();
    return (raw: string): string => {
      let name = sanitizeIdent(raw);
      if (seen.has(name)) {
        let i = 2;
        while (seen.has(`${name}_${i}`)) i++;
        name = `${name}_${i}`;
      }
      seen.add(name);
      return name;
    };
  })();
  // C4: parameters are allocated before any object variable, so a document
  // object that happens to be named like a parameter can never shadow it —
  // the object gets the `_2` suffix instead (`emitVar` is the single allocator).
  for (const p of params ?? []) emitVar(p.name);

  // D-C (M9.4): same-Body features fuse cumulatively in Body.Group order —
  // the first translated feature is the base, every later additive feature
  // (Pad/…) unions with the chain, every subtractive one (Pocket/Cut)
  // subtracts. cad.group is NOT used inside a Body (that is assembly
  // semantics); cross-Body grouping stays in lower()'s root handling (M10).
  const memberToBody = new Map<string, string>();
  for (const obj of doc.objects) {
    if (obj.type !== 'PartDesign::Body') continue;
    for (const m of bodyFeatureNames(obj)) {
      if (!memberToBody.has(m)) memberToBody.set(m, obj.name);
    }
  }
  const chainVar = new Map<string, string>(); // body name → accumulated var
  // P1.3 (2026-09-28, Winch-Model1-Cable-Guide): Body-less PartDesign files
  // chain their features with an EMPTY BaseFeature link (`<Link value=""/>` —
  // FreeCAD 0.20+ serializes "implied by feature order" this way). propLink
  // returns undefined → the translator emits BODY_CHAIN_BASE, and the H7 guard
  // below used to bake EVERY such pocket because no Body container ever
  // creates a chain head. Track an implicit loose-chain head instead: the last
  // translated loose PartDesign feature's output, in document order — exactly
  // FreeCAD's implied ordering. Retargeting the marker at it keeps the
  // subtract chain alive without a Body. The H7 guard remains for the
  // genuinely headless case (marker present before any loose feature built).
  let looseChainHead: string | undefined;

  for (const name of order) {
    const node = nodes.get(name)!;
    const obj = node.obj;

    if (obj.type === 'Sketcher::SketchObject') {
      const verdict = sketchVerdict.get(name);
      // A2 (D2 (b)): when the convert-time precheck produced canonical inputs
      // (solve status !== failed), emit a PARAMETRIC `cad.sketch` — geometry +
      // constraints travel into the .fai.js and the run-time op re-solves via
      // the same planegcs backend. The old solved-contour → `cad.profile`
      // emission becomes the A5 fallback only.
      const inputs = sketchInputs?.get(name);
      if (inputs && inputs.geoms.length > 0) {
        const v = emitVar(name);
        variables.set(name, v);
        // A3 (D3 (b), 2026-09-28): the sketch's (attachment-resolved) Placement
        // becomes an explicit plane frame `{ origin, normal, xAxis }` — the
        // solved contours land on the sketch plane IN ONE STEP via the shared
        // sketchOnPlane placement core, replacing the M8.3 post-hoc
        // `cad.place` re-orientation hack for sketches.
        // GOTCHA (两帧往返): FCStd sketch-local XY maps through the placement
        // quaternion — u = R·X, n = R·Z; the run-time op re-solves in LOCAL
        // coords then lifts to this frame, so parity holds iff the axes come
        // from the SAME quaternion (planeBasis, placement.ts).
        let plane: { origin: [number, number, number]; normal: [number, number, number]; xAxis: [number, number, number] } | undefined;
        const skPl = placements?.get(name);
        if (skPl && !isIdentityPlacement(skPl)) {
          const { u, n } = planeBasis(skPl);
          plane = { origin: [...skPl.p], normal: n, xAxis: u };
        }
        const sketchCall: CadCall = {
          out: v, op: 'cad.sketch', source: name, inputs: [],
          params: {
            geoms: inputs.geoms,
            constraints: inputs.constraints.length > 0 ? inputs.constraints : undefined,
            plane,
          },
        };
        calls.push(sketchCall);
        results.push({
          name, type: obj.type, variable: v, calls: [sketchCall], disposition: 'translated',
          sketch: verdict,
        });
        continue;
      }
      const contours = sketchContours.get(name);
      const usable =
        !!verdict &&
        verdict.level !== 'L2' &&
        (verdict.loopCount ?? 0) > 0 &&
        !!contours &&
        contours.length > 0;
      if (usable) {
        // A5 (2026-09-28 plan): this is now the FALLBACK branch only — the
        // parametric cad.sketch path above handles every sketch whose
        // convert-time precheck did not fail. Reaching here means the sketch
        // was NOT parameterizable (no sketchInputs) yet its solved contour is
        // usable as a dead profile — record WHY explicitly.
        // GOTCHA (A2 semantics): verdict.level L1 (delta-exceeds-t1 /
        // solve-failed) sketches carry a verdict.reason naming the cause; L0
        // sketches without sketchInputs typically failed constraint
        // projection (external refs / unsupported types) — convert.ts only
        // fills sketchInputs when the precheck produced canonical inputs.
        const v = emitVar(name);
        variables.set(name, v);
        const sketchCall: CadCall = {
          out: v, op: 'cad.profile', source: name, inputs: [], params: { contours },
        };
        calls.push(sketchCall);
        results.push({
          name, type: obj.type, variable: v, calls: [sketchCall], disposition: 'translated',
          reason: verdict?.reason ? `sketch-profile-fallback: ${verdict.reason}` : 'sketch-profile-fallback',
          sketch: verdict,
        });
      } else {
        // P3-4 (2026-09-24, Slab adjustable scaffolder): a sketch may solve to
        // L0 yet produce zero closed loops (dangling segments) — `loopCount`
        // 0 then failed `usable` and the fallback labeled it `sketch-not-
        // solved`, which lies about the cause. Give the L0-but-no-loop case
        // its own explicit reason; keep the old fallbacks for genuinely
        // missing verdicts/contours.
        // P2-1 (2026-09-28): a sketch with canonical inputs but ZERO geoms
        // (all construction / fully trimmed) used to fall through here AND,
        // before that, reach the parametric emission — the run-time op then
        // threw E_SKETCHC_NO_GEOMS. Name the cause explicitly instead.
        const reason = inputs && inputs.geoms.length === 0
          ? 'sketch-empty-geoms'
          : verdict?.reason
          ?? (verdict?.level === 'L0' && contours && contours.length === 0
            ? 'sketch-solved-no-closed-loop'
            : contours ? 'sketch-not-solved' : 'sketch-no-contours');
        results.push({
          name, type: obj.type, calls: [], disposition: 'baked',
          reason, sketch: verdict,
        });
      }
      continue;
    }

    // A1 (2026-09-29 plan): Draft drawing objects with a rebuilt drawing →
    // `cad.sketchOnPlane` per shape kind, compounded when the drawing carries both.
    //
    // The contours are the platform's own `ProfileLoop` data form (`{segments:
    // […]}`) — the SAME form the solved-sketch path emits — so `profileSegToCurve`
    // gets analytic line/arc segments and the kernel builds real
    // `makeLineEdge`/`makeArcEdge` edges. This replaced two worse emissions:
    //  · `pen.lineTo(…)` member chains, which nest one AST level per segment and
    //    died on the parser's depth cap of 100 (10 of 15 corpus drawings), hence
    //    the single-call `pen.polyline([…])` form; and
    //  · that polyline form, which required a LOCAL FUNCTION PER CONTOUR (one
    //    `cad.draw` session carries exactly one contour — `movePointerTo` refuses
    //    to lift the pen once a curve exists) and threw away every analytic curve
    //    in favour of a tessellation (168 analytic Sprocket edges → 7010 points,
    //    and OCC never finished the wire; see draft-draw.ts).
    // A single object-literal argument has neither problem at any segment count.
    //
    // A1 follow-up (2026-09-29): CLOSED and OPEN contours are different shapes and
    // must not share one call.
    //  · A closed contour is a PROFILE: `cad.sketchOnPlane` (default `as:'face'`)
    //    builds a planar face out of it, which is what `cad.extrude` consumes.
    //  · An OPEN contour is a PATH — a Draft outline used as a `cad.sweep` spine.
    //    OCCT's `BRepBuilderAPI_MakeFace::IsDone()` is false for an open wire, so
    //    handing one to the face call fails with
    //    `CONSTRUCTION_FAILED: makeFace: construction failed`. Measured on Chair
    //    (each `Shape2DView` projection is 17 open contours) and on
    //    Kitchen_cabinet_base (spines `Clone2D004/010/017`, against closed
    //    extrude profiles `Clone2D005/006/…`).
    // So: all closed contours go to ONE face call (which keeps hole/island nesting
    // intact — splitting per contour would turn every hole into a filled face),
    // each open contour goes to its own `as:'wire'` call, and multiple parts are
    // compounded. A uniformly closed drawing — every extruded `Clone2D*`, every
    // Sprocket profile — collapses back to that single call.
    //
    // The object's own variable must end up as a Shape, because Draft objects are
    // consumed like any other shape (`cad.sweep(Clone2D001, Clone2D002)`,
    // `cad.extrude(Clone2D005, …)`), so the placement call carries the object's
    // name. No contour variable exists to leak into the root `cad.compound`
    // aggregate any more — the data lives inside the calls' `params`.
    const drawing = draftDrawings?.get(name);
    if (drawing && obj.type === 'Part::Part2DObjectPython') {
      const v = emitVar(name);
      variables.set(name, v);
      // A3 parity with the sketch path: the object's Placement becomes the lift
      // frame. Identity → the plain XY plane (emitted explicitly so the generated
      // source states where the drawing lands).
      let plane: { origin: [number, number, number]; normal: [number, number, number]; xAxis: [number, number, number] } | { name: string } = { name: 'XY' };
      const drPl = placements?.get(name);
      if (drPl && !isIdentityPlacement(drPl)) {
        const { u, n } = planeBasis(drPl);
        plane = { origin: [...drPl.p], normal: n, xAxis: u };
      }
      const closedContours = drawing.contours.filter((c) => c.closed);
      const openContours = drawing.contours.filter((c) => !c.closed);
      // One part per emitted shape: the closed group (one face / face-compound),
      // then one wire per open contour.
      const parts: { contours: DraftDrawing['contours']; as?: 'wire' }[] = [];
      if (closedContours.length > 0) parts.push({ contours: closedContours });
      for (const c of openContours) parts.push({ contours: [c], as: 'wire' });
      const draftCalls: CadCall[] = [];
      // A single part IS the object; two or more are compounded under its name.
      const single = parts.length === 1;
      const partVars: string[] = [];
      for (const part of parts) {
        const out = single ? v : emitVar(`${name}__part`);
        partVars.push(out);
        draftCalls.push({
          out, op: 'cad.sketchOnPlane', source: name, inputs: [],
          params: {
            contours: part.contours.map((c) => ({ segments: c.segments })),
            plane,
            ...(part.as ? { as: part.as } : {}),
          },
        });
      }
      if (!single) {
        // GOTCHA: `cad.compound`'s members travel as LEXICAL VARIABLE NAMES inside
        // `params.members` (renderArgs renders them bare, not as strings), while
        // `inputs` is what `lower()` uses to mark them consumed — without it the
        // part variables look unconsumed and get swept into the root `cad.compound`
        // a second time. `noPositionalArgs` keeps those inputs from being rendered
        // as positional arguments the params-only op cannot accept.
        draftCalls.push({
          out: v, op: 'cad.compound', source: name,
          inputs: [...partVars], noPositionalArgs: true,
          params: { members: [...partVars] },
        });
      }
      calls.push(...draftCalls);
      results.push({
        name, type: obj.type, variable: v, calls: draftCalls,
        disposition: 'translated',
        reason: `draft-draw(${closedContours.length} closed, ${openContours.length} open)`,
      });
      continue;
    }

    // Non-modeling objects are preserved-only and MUST be short-circuited
    // BEFORE translation. GOTCHA (PadTest, 2026-09-21): this used to list only
    // `App::Origin/Plane/Line`, so a Body's `PartDesign::Plane` went through
    // the translator, matched the shape-asset rule (datum planes store a
    // `Shape` .brp — the plane face) and was folded into the Body's chain:
    // `cad.union(pad, datumPlane)`. That both corrupts the solid and fails at
    // run time (`cad.load` requires a solid; a plane face has none). The
    // predicate is shared with the C4 audit (`structural-types.ts`) so codegen
    // and the disposition ledger can never disagree about what is non-modeling.
    if (isNonModelingType(obj.type)) {
      results.push({ name, type: obj.type, calls: [], disposition: 'preserved-only', reason: 'structural' });
      continue;
    }

    // Sketches are now real face variables (see the Sketcher::SketchObject
    // branch above), so every dependency that resolves to one flows through.
    const verdict = translateObject(obj, (dep) => {
      if (process.env.FAIJS_DEBUG_VAR) {
        console.error(`[dbg] ${name} asks for ${dep} -> ${variables.get(dep) ?? chainVar.get(dep) ?? 'UNDEF'}`);
      }
      // GOTCHA (test_geomop corpus, 2026-09-20): a dependency on a Body
      // CONTAINER (Part::Cut with Tool→Body) resolves against the Body's
      // accumulated chain head, not `variables` — the container name is
      // never registered there (its result lives in chainVar).
      return variables.get(dep) ?? chainVar.get(dep);
    }, doc.objects, shapeCarriers, brokenShapeAssets, filletEdgesData);
    if (process.env.FAIJS_DEBUG_VAR && verdict.kind !== 'translated') {
      console.error(`[dbg] ${name} (${obj.type}) -> ${verdict.kind} ${verdict.reason ?? ''}`);
    }
    node.verdict = verdict;
    if (verdict.kind === 'translated') {
      // assign each output a stable var derived from its source object name
      // (emitVar). H14: record renames made WITHIN this verdict — JsExpr
      // literals (e.g. the loft section array) may reference INTERMEDIATE vars
      // created by the same verdict (`${out}__sec${i}` place copies), whose
      // final var names are only decided below; remap them after the loop.
      const verdictRenames = new Map<string, string>();
      for (const call of verdict.calls) {
        const v = emitVar(call.out);
        verdictRenames.set(call.out, v);
        variables.set(call.out, v);
        // remap inputs that were intermediate (Pocket_cut) or named outputs
        call.inputs = call.inputs.map((i) => variables.get(i) ?? i);
        // GOTCHA (ArchDetail s444, 2026-09-21): `cad.compound` passes its
        // members as LEXICAL VARIABLE NAMES inside `params.members` — they
        // must be remapped like `inputs`, otherwise renderArgs emits them as
        // string literals and the op receives strings (no BREP handle) and
        // throws "compound members are not all on the BREP chain".
        const members = (call.params as { members?: unknown } | undefined)?.members;
        if (Array.isArray(members)) {
          call.params!.members = members.map((m) =>
            typeof m === 'string' ? (variables.get(m) ?? m) : m,
          );
        }
        call.out = v;
        calls.push(call);
      }
      if (verdictRenames.size > 0) {
        for (const call of calls.slice(-verdict.calls.length)) {
          call.literals = call.literals?.map((l) =>
            isJsExpr(l)
              ? jsExpr(
                  [...verdictRenames].reduce(
                    (s, [old, nw]) =>
                      s.replace(new RegExp(`\\b${old.replace(/[^A-Za-z0-9_$]/g, '\\$&')}\\b`, 'g'), nw),
                    l.__jsExpr,
                  ),
                )
              : l,
          );
        }
      }
      // M8.3: features build in sketch-local coordinates (cad.profile lays the
      // face on local XY; extrude runs along local +Z). Re-orient the final
      // solid by the PROFILE SKETCH's Placement: rotate_euler then translate,
      // so the result lands where FreeCAD puts it. Identity placements emit
      // nothing.
      // GOTCHA (PadTest V6, relErr 3.20%): a PartDesign feature's geometry is
      // built in the SKETCH frame, but FreeCAD may store a DIFFERENT Placement
      // on the feature object itself (Pad001: sketch P=(10,0,0)
      // Q=(0,.7071,0,.7071) vs feature P=0 Q=(0,.7071,.7071,0)) — re-orienting
      // by the feature's own frame drops the sketch origin offset and rotates
      // the extrude axis into the wrong direction (−3.20% volume, centroid
      // off 1.67). The sketch's Placement is the authoritative frame for the
      // built geometry; fall back to the feature's own for sketchless features.
      const lastVar = verdict.calls.at(-1)?.out;
      // M8.3 frame resolution: the profile sketch link is `Sketch` on some
      // PartDesign features, `Profile` on others (FreeCAD 0.18/0.19 mix both
      // even within one file — e.g. Wall-Hung-Toilets: the base Pad uses
      // `Sketch`, later Pad001/Pocket use `Profile`), and `Base` on
      // `Part::Extrusion` (a plain Part-workbench extrude of a sketch). Read
      // all three so face-attached sketches are re-oriented by their Placement.
      // GOTCHA (W2 type②, 2026-09-27): reading only `Sketch`/`Base` left
      // Profile-linked features (Pad001/Pocket) un-placed — `pl` fell back to
      // the feature's own identity Placement and the pocket tool landed at the
      // origin, degenerating and overrunning the fillet's edge ordinal.
      const sketchLink =
        obj.properties.get('Sketch')?.children[0]?.attributes['value'] ??
        obj.properties.get('Profile')?.children[0]?.attributes['value'] ??
        obj.properties.get('Base')?.children[0]?.attributes['value'];
      const sketchIsSketchObj =
        sketchLink !== undefined &&
        byName.get(sketchLink)?.type === 'Sketcher::SketchObject';
      const pl = (sketchIsSketchObj ? placements?.get(sketchLink) : undefined) ?? placements?.get(name);
      // GOTCHA (H13 REVISED twice, 2026-09-26): shape-asset .brp members
      // SOMETIMES embed the Placement in their Locations header (TO92,
      // Beds Section) and sometimes don't (Beds Section002-005). The old
      // unconditional rules were both wrong: always-place double-applies
      // pre-placed assets (Section landed z=3000, truth 1500); never-place
      // stranded local-frame assets at the origin (solids 10vs6, z 2850
      // vs 450). The caller passes `prePlacedAssets` derived from the .brp
      // header itself (brpHasEmbeddedLocation) — place only when NOT embedded.
      const isPrePlaced = prePlacedAssets?.has(name) ?? false;
      // Subtractive features (Pocket/Cut) pair a profile-extrude CUT with an
      // already-placed base inside `cad.subtract`. Re-orient the CUT (not the
      // subtracted result) so the boolean runs in one frame — the carved result
      // then inherits that frame and must NOT be placed again (W2 type②,
      // Wall-Hung-Toilets: placing the subtract result left the cut local at the
      // origin, so the pocket missed and overran the fillet's edge ordinal).
      const featureIsSubtractive = obj.type === 'PartDesign::Pocket' || obj.type === 'Part::Cut';
      // Locate the cut/tool: it is the subtract's SECOND input (base is first).
      // GOTCHA (W2 type② regression, 2026-09-28): the verdict's `out` values
      // were already rename-remapped at line ~369, so matching `c.out` against
      // the raw `${name}_cut` string NEVER matched and silently disabled the
      // subtractive path. Read the (renamed) input instead.
      const subCall = featureIsSubtractive ? verdict.calls.find((c) => c.op === 'cad.subtract') : undefined;
      const cutVar = subCall && subCall.inputs.length >= 2 ? subCall.inputs[1] : undefined;
      const reorientVar = cutVar ?? lastVar;
      if (lastVar && pl && !isIdentityPlacement(pl) && !isPrePlaced && reorientVar) {
        // Single rigid placement: rotate (quaternion about local origin) +
        // translate = FreeCAD Placement(P,Q). Emit `cad.place` with the ORIGINAL
        // (unplaced) var as input — do NOT pre-remap `cur` to `rv`, or the place
        // call would self-reference its own output (cad.place(X, X)): that is a
        // forward-ref at run time AND drops the real input so the call mis-routes
        // to main, leaving the Body terminal dangling (Body__chain_N undeclared).
        const cur = reorientVar;
        const rv = emitVar(`${name}__place`);
        const placeCall: CadCall = {
          out: rv, op: 'cad.place', source: name, inputs: [cur],
          params: { rotation: [...pl.q], position: [...pl.p] },
        };
        if (featureIsSubtractive && subCall && cutVar) {
          // Re-orient the CUT only: retarget the subtract's tool input at the
          // placed copy. The carved result (lastVar) inherits the cut's global
          // frame, so `name` stays mapped to its own (already global-frame)
          // output — the chain head must remain the carved solid, not the bare
          // cut prism. (W2 type②: placing the subtract result left the cut local
          // at the origin, so the pocket missed and overran the fillet edge.)
          // GOTCHA: faijs is a statement language that REJECTS forward refs, so
          // the placed copy must be declared BEFORE the subtract that consumes it
          // — insert the place call immediately ahead of the subtract.
          subCall.inputs[1] = rv;
          const at = calls.indexOf(subCall);
          calls.splice(at < 0 ? calls.length : at, 0, placeCall);
        } else {
          // Additive: the chain-fold (emitted later this iteration) consumes the
          // placed feature, so append and redirect consumers via `variables`.
          calls.push(placeCall);
          variables.set(cur, rv);
        }
      }
      // M9.4 (D-C): fold the feature into its Body's chain — AFTER the placement
      // step so the chain accumulates the PLACED feature shape. Pocket/Cut
      // subtract from the chain; everything else unions onto it. The first
      // feature in the Body's feature list (Model/Group) order becomes the
      // chain base — no cad.group inside a Body; consumers (M10) read chainVar.
      // GOTCHA (PadTest V6): folding the UNPLACED feature var (the old order)
      // left the chain head in sketch-local space while each feature's Placement
      // was applied to a separate, unused variable → the exported body spanned
      // both the local and the placed copies (~2× bboxDiag, ~5× volume).
      const body = memberToBody.get(name);
      const isSubtractive = obj.type === 'PartDesign::Pocket' || obj.type === 'Part::Cut';
      if (body) {
        const prev = chainVar.get(body);
        // UpToLast/UpToFirst: FreeCAD's "up to" support is the Body's ACCUMULATED
        // shape, NOT only the immediate BaseFeature link — retarget the kernel
        // ref at the chain head (prev). GOTCHA (PadTest V6): truncating against
        // the immediate BaseFeature (a small Pad001 disc) left an 8.06% volume
        // deficit vs the Tip; against the accumulated chain it drops to 3.20%
        // (bbox already exact at delta 0).
        if (prev) {
          for (const c of verdict.calls) {
            // H7 (hole_puzzle corpus): the Pocket had NO BaseFeature property —
            // the translator emitted BODY_CHAIN_BASE as the subtract's base
            // input; retarget it at the chain head here (after the earlier
            // inputs remap, which leaves the marker untouched since it is not
            // a variable name).
            if (c.inputs) {
              c.inputs = c.inputs.map((i) => (i === BODY_CHAIN_BASE ? prev : i));
            }
            if (c.op === 'cad.extrude' && c.params.baseFeature !== undefined) {
              // GOTCHA (PadTest V6 residual): the up-to extrude builds its
              // prism in the SKETCH-LOCAL frame, but the chain head (prev)
              // lives in the PLACED (global) frame. FreeCAD's boolean runs in
              // one frame — so transform prev back into the sketch frame
              // first: local = R^-1(global - p). Feeding the placed chain var
              // directly silently truncates at the wrong face (Pad002 truth
              // AddShape 48199 vs rebuilt deficit ~9108 mm^3 → 3.2% total).
                const needsInverse =
                  pl !== undefined && !isIdentityPlacement(pl);
                if (needsInverse && pl) {
                  // 逆向刚性放置（单点发射，方案 §4.7）：rotation 取共轭四元数、
                  // position 取 invertApplyPlacement(pl, 0) = -(invQ·p)，合成为
                  // 一个 cad.place，避免 euler 往返。语义 = invertApplyPlacement(pl, prev)。
                  const invQ: [number, number, number, number] = [
                    -pl.q[0]!, -pl.q[1]!, -pl.q[2]!, pl.q[3]!,
                  ];
                  const invPos = invertApplyPlacement(pl, [0, 0, 0]);
                  const rv = emitVar(`${name}__invplace`);
                  const rvCall: CadCall = {
                    out: rv, op: 'cad.place', source: name,
                    inputs: [prev],
                    params: { rotation: invQ, position: invPos },
                  };
                  // insert BEFORE the extrude call: faijs is a statement
                  // language — `baseFeature: <var>` referencing a later
                  // statement is E_REFERENCE (parser rejects forward refs).
                  const at = calls.indexOf(c);
                  calls.splice(at < 0 ? calls.length : at, 0, rvCall);
                  c.params.baseFeature = jsExpr(rv);
                } else {
                  c.params.baseFeature = jsExpr(prev);
                }
            }
          }
        }
        const featureVar = variables.get(name) ?? verdict.calls.at(-1)!.out;
        if (!prev) {
          chainVar.set(body, featureVar); // base feature
        } else if (isSubtractive && verdict.calls.at(-1)!.op === 'cad.subtract' && verdict.calls.at(-1)!.inputs.includes(prev)) {
          // Pocket already subtracted from the chain var itself (BaseFeature
          // resolved to the chain) — its output IS the new chain head; no
          // extra subtract (would cut twice).
          chainVar.set(body, featureVar);
        } else if (isSubtractive) {
          const nv = emitVar(`${body}__chain`);
          calls.push({ out: nv, op: 'cad.subtract', source: name, inputs: [prev, featureVar], params: {} });
          chainVar.set(body, nv);
        } else {
          const nv = emitVar(`${body}__chain`);
          calls.push({ out: nv, op: 'cad.union', source: name, inputs: [prev, featureVar], params: {} });
          chainVar.set(body, nv);
        }
      }
      // P1.3 (2026-09-28, Winch-Model1-Cable-Guide): retarget BODY_CHAIN_BASE
      // at the loose chain head BEFORE the H7 guard — a Body-less PartDesign
      // file chains features implicitly (empty BaseFeature link), and FreeCAD's
      // implied ordering is document order, which is exactly the order this
      // loop processes loose features in.
      const hasMarker = verdict.calls.some((c) => c.inputs?.includes(BODY_CHAIN_BASE));
      if (hasMarker && looseChainHead !== undefined && !memberToBody.has(name)) {
        const head: string = looseChainHead;
        for (const c of verdict.calls) {
          if (c.inputs) c.inputs = c.inputs.map((i) => (i === BODY_CHAIN_BASE ? head : i));
        }
      }
      // H7 guard (motor_mount_inch corpus): a feature outside a Body (or with
      // no chain head yet) never gets its BODY_CHAIN_BASE retargeted — the
      // marker would leak into the generated JS as an illegal identifier
      // (parser kills the whole file). Downgrade to an explicit gap instead.
      if (verdict.calls.some((c) => c.inputs?.includes(BODY_CHAIN_BASE))) {
        results.push({ name, type: obj.type, calls: [], disposition: 'baked', reason: 'pocket-missing-dependency' });
        continue;
      }
      results.push({ name, type: obj.type, variable: verdict.calls.at(-1)?.out, calls: verdict.calls, disposition: 'translated', reason: verdict.reason });
      // P1.3: a translated loose PartDesign feature becomes the implicit chain
      // head for the next loose feature (document order = FreeCAD's implied
      // ordering). Body members keep their own chainVar discipline above.
      if (!memberToBody.has(name) && verdict.calls.length > 0) {
        looseChainHead = verdict.calls.at(-1)!.out;
      }
    } else if (verdict.kind === 'baked') {
      results.push({ name, type: obj.type, calls: [], disposition: 'baked', reason: verdict.reason });
    } else {
      results.push({ name, type: obj.type, calls: [], disposition: 'preserved-only', reason: verdict.reason });
    }
  }

  // also mark unreachable (cycle) objects as baked
  for (const obj of doc.objects) {
    if (!results.some((r) => r.name === obj.name)) {
      results.push({ name: obj.name, type: obj.type, calls: [], disposition: 'baked', reason: 'dependency-cycle' });
    }
  }

  // M10.3/M10.5 — split by Body: calls whose source object belongs to a Body
  // (including the chain union/subtract calls emitted for it) go to
  // model/<BodyName>.fai.js; everything else (loose Part features) stays in
  // main.fai.js. When no Body has geometry, everything lands in main (the
  // single-file shape). Aggregate entry compounds per-file roots via cad.compound.
  const callBody = new Map<string, string>();
  for (const r of results) {
    const b = memberToBody.get(r.name);
    if (b) for (const c of r.calls) callBody.set(c.out, b);
  }
  const bodiesWithGeo = new Set<string>();
  for (const b of new Set(memberToBody.values())) {
    if (chainVar.has(b)) bodiesWithGeo.add(b);
  }
  const files: GenResult['files'] = [];
  let code: string;
  let rootVar: string | undefined;
  if (bodiesWithGeo.size > 0) {
    const mainCalls: CadCall[] = [];
    const perBody = new Map<string, CadCall[]>();
    // M10c partition in DEPENDENCY ORDER: `calls` is already topologically
    // sorted, so ONE forward pass assigns each call — to its own source's Body
    // when known (`callBody`), else to the Body its first body-owned input went
    // to. GOTCHA (PadTest V6): the previous implementation re-assigned such
    // calls by APPENDING them to the end of the Body file, which broke
    // dependency order — a Body file ended up referencing a variable declared
    // further down (`let` TDZ ReferenceError at run time: a later chain var used
    // an earlier one).
    // Filtering `calls` in place preserves the topological order.
    const assigned = new Map<string, string>(); // call.out → Body file name
    // chain-head var → terminal alias (and owning Body) — needed DURING
    // routing: a foreign chain head is never in `assigned` (it is a Body's
    // accumulated var, not a call output), so input-body checks must consult
    // this map to detect cross-Body references.
    const headToTerminal = new Map<string, string>();
    const headToBody = new Map<string, string>();
    for (const b of bodiesWithGeo) {
      headToTerminal.set(chainVar.get(b)!, `${b}_out`);
      headToBody.set(chainVar.get(b)!, b);
    }
    const mainPending: CadCall[] = [];
    const mainOuts = new Set<string>();
    for (const c of calls) {
      const own = callBody.get(c.out);
      const inputBodies = c.inputs.map((inp) => assigned.get(inp) ?? headToBody.get(inp)).filter((b): b is string => b !== undefined);
      const viaInput = inputBodies[0];
      const b = own !== undefined && bodiesWithGeo.has(own) ? own : viaInput;
      // GOTCHA (test_geomop corpus, 2026-09-20): a call whose own Body
      // differs from an input's Body (Part::Cut with Base in another Body's
      // chain) must NOT be emitted into its own Body file — the input
      // variable lives in ANOTHER module and is not declared there
      // (SEC_FREE_IDENT at check time). Same for inputs that will live in
      // MAIN (loose Part boxes): routing is a forward pass over the
      // topologically sorted calls, so main outputs are already known.
      // NOTE: Body-chain fold calls (union/subtract emitted during folding)
      // are NOT in `results`, so `own` is undefined for them — the main-input
      // check must not depend on `own`.
      const mixed = inputBodies.some((ib) => ib !== b) || (own !== undefined && viaInput !== undefined && viaInput !== own);
      const touchesMain = c.inputs.some((i) => mainOuts.has(i));
      if (b !== undefined && bodiesWithGeo.has(b) && !mixed && !touchesMain && (own === undefined || own === b)) {
        if (!perBody.has(b)) perBody.set(b, []);
        perBody.get(b)!.push(c);
        assigned.set(c.out, b);
      } else {
        mainPending.push(c);
        mainOuts.add(c.out);
      }
    }
    for (const c of mainPending) {
      mainCalls.push({ ...c, inputs: c.inputs.map((i) => headToTerminal.get(i) ?? i) });
    }
    for (const b of bodiesWithGeo) {
      const bodyCalls = perBody.get(b) ?? [];
      // terminal: alias the chain head to <Body>_out so the aggregate entry
      // has a stable, name-independent reference to each Body's result.
      const head = chainVar.get(b)!;
      const withTerminal = [
        ...bodyCalls,
        { out: `${b}_out`, op: 'identity', source: b, inputs: [head], params: {} } as CadCall,
      ];
      files.push({ path: `model/${b}.fai.js`, code: lowerBody(withTerminal, `${baseName}/${b}`, b, params), body: b });
    }
    // main.fai.js: aggregate the per-Body terminals via cad.compound. M10c:
    // cross-file references close through the standard relative-import
    // contract (module-registry D6) — each Body module's terminal alias
    // `<Body>_out` is its live shape, so a named import binds it.
    const lines: string[] = [];
    lines.push(`// Generated by faijs FCStd port — ${baseName} (aggregate entry)`);
    lines.push(`// Units: mm (faijs contract; FCStd internal units are mm)`);
    const members = [...bodiesWithGeo].map((b) => `${b}_out`);
    // Always import the per-Body terminals: the aggregate entry references
    // `<Body>_out` in BOTH the cad.compound (multi-Body) and the single-Body alias
    // path, so a missing import is a SEC_FREE_IDENT parse error (GOTCHA: the
    // single-Body branch previously emitted `let assembly = <Body>_out;` with
    // no import). `mainCalls` may still be empty here.
    if (members.length >= 1) {
      for (const b of bodiesWithGeo) {
        lines.push(`import { ${b}_out } from './${b}.fai.js'; // module ${b}`);
      }
    }
    // C1/C2/C4: `const p_*` must precede every use (a `const` is not hoisted? it
    // is, but TDZ still bites), so the block goes after the imports. The id
    // arithmetic subtracts it again so existing documents keep their `sN` ids.
    const mainScan = mainCalls.map((c) => `${c.op} ${renderArgs(c)}`).join('\n');
    const mainParams = paramLines(params, mainScan);
    for (const p of mainParams) lines.push(p);
    for (const c of mainCalls) {
      const id = `s${lines.length - 2 - mainParams.length}`;
      lines.push(`let ${c.out} = ${c.op}(${renderArgs(c)}); // ${id} ${c.source}`);
    }
    if (members.length > 1) {
      rootVar = 'assembly';
      lines.push(`let assembly = cad.compound({ members: [${members.join(', ')}] });`);
    } else if (members.length === 1) {
      // single Body: the imported terminal IS the result — alias keeps a
      // stable root name for executors
      rootVar = members[0];
      lines.push(`let assembly = ${rootVar}; // single-Body aggregate`);
      rootVar = 'assembly';
    }
    code = lines.join('\n') + '\n';
  } else {
    code = lower(calls, baseName, params);
  }
  return { calls, objects: results, code, files, rootVar };
}

/** M10.3 — lower one Body's calls; the last entry is the terminal alias
 * `<Body>_out` (plain JS assignment — faijs has no identity op). */
function lowerBody(
  calls: CadCall[],
  label: string,
  body: string,
  params?: readonly LeafParam[],
): string {
  const lines: string[] = [];
  lines.push(`// Generated by faijs FCStd port — ${label}`);
  lines.push(`// Units: mm (faijs contract; FCStd internal units are mm)`);
  // C1/C2/C4: the parameter block precedes every use.
  const plines = paramLines(params, calls.map((c) => `${c.op} ${renderArgs(c)}`).join('\n'));
  for (const p of plines) lines.push(p);
  for (const call of calls) {
    if (call.op === 'identity') {
      // terminal alias: `let <Body>_out = <chain head>;`
      lines.push(`let ${call.out} = ${call.inputs[0]}; // s? ${body} terminal`);
      continue;
    }
    const id = `s${lines.length - 2 - plines.length}`;
    lines.push(`let ${call.out} = ${call.op}(${renderArgs(call)}); // ${id} ${call.source}`);
  }
  return lines.join('\n') + '\n';
}

/** M5.2 — lower the call plan to .fai.js source. faijs syntax: top-level
 * statement flow with `let <Name> = cad.x(...)` (Name = source object name);
 * no wrapper function. */
function lower(
  calls: CadCall[],
  baseName: string,
  params?: readonly LeafParam[],
): string {
  const lines: string[] = [];
  lines.push(`// Generated by faijs FCStd port — ${baseName}`);
  lines.push(`// Units: mm (faijs contract; FCStd internal units are mm)`);
  // C1/C2/C4: the parameter block precedes every use.
  const plines = paramLines(params, calls.map((c) => `${c.op} ${renderArgs(c)}`).join('\n'));
  for (const p of plines) lines.push(p);
  for (const call of calls) {
    const id = `s${lines.length - 2 - plines.length}`; // statement id sN
    const args = renderArgs(call);
    lines.push(`let ${call.out} = ${call.op}(${args}); // ${id} ${call.source}`);
  }
  // final shape: union of root calls that nobody consumes; faijs scripts
  // end with the output-producing statement (no return, per fixtures).
  const consumed = new Set(calls.flatMap((c) => c.inputs));
  const roots = calls.filter((c) => !consumed.has(c.out)).map((c) => c.out);
  if (roots.length > 1) {
    lines.push(`let assembly = cad.compound({ members: [${roots.join(', ')}] });`);
  } else if (roots.length === 0) {
    lines.push(`// no translated geometry (all baked)`);
  }
  return lines.join('\n') + '\n';
}

/**
 * C1/C2/C4 (2026-09-28 plan) — the `const p_*` header for one generated module.
 *
 * Only parameters the module actually references are emitted: a document-wide
 * list dumped into every Body module would be noise, and a module that declares
 * a lever it never reads misleads whoever edits it. `scan` is the rendered text
 * of the module's statements (ops + args), so a parameter
 * reached only through a body's sketch constraints is still caught.
 *
 * @param params - the document's leaf parameters (undefined → none).
 * @param scan - the rendered statement text to search for parameter references.
 * @returns the header lines (empty when nothing is referenced).
 */
function paramLines(params: readonly LeafParam[] | undefined, scan: string): string[] {
  if (!params || params.length === 0) return [];
  const used = params.filter((p) => new RegExp(`\\b${p.name}\\b`).test(scan));
  if (used.length === 0) return [];
  return used.map((p) => `const ${p.name} = ${p.value}; // ${p.source}`);
}

/**
 * M5.2 — render one IR value as JS. Plain values JSON-encode (byte-identical to
 * the pre-JsExpr output); a `JsExpr` marker renders verbatim, and a container
 * holding one renders element-wise so the expression survives into the source.
 */
function renderValue(v: unknown): string {
  if (isJsExpr(v)) return v.__jsExpr;
  if (Array.isArray(v)) {
    // GOTCHA (C3, 2026-09-28): the check is `containsJsExpr`, not `some(isJsExpr)`
    // — a parameter-bearing literal is NESTED (`literals: [[0, 0, p_x]]`, the
    // extrude direction vector), and a one-level test JSON-encoded the marker
    // itself (`{"__jsExpr":"p_x"}`) instead of emitting the expression.
    if (v.some(containsJsExpr)) return `[${v.map(renderValue).join(', ')}]`;
    return JSON.stringify(v);
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.some(([, val]) => containsJsExpr(val))) {
      return `{ ${entries.map(([k, val]) => `${k}: ${renderValue(val)}`).join(', ')} }`;
    }
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/** True when a value is or (recursively) contains a `JsExpr` marker. */
function containsJsExpr(v: unknown): boolean {
  if (isJsExpr(v)) return true;
  if (Array.isArray(v)) return v.some(containsJsExpr);
  if (v && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(containsJsExpr);
  return false;
}

function renderArgs(call: CadCall): string {
  const positional: string[] = [
    ...(call.noPositionalArgs ? [] : call.inputs.map((i) => i)),
    ...(call.literals ?? []).map((l) => renderValue(l)),
  ].filter((s) => s.length > 0); // M7.1: drop empty entries so we never emit `(, `
  const named: string[] = [];
  for (const [k, v] of Object.entries(call.params ?? {})) {
    if (v === undefined) continue;
    // GOTCHA (ArchDetail s444, 2026-09-21): `cad.compound`'s `members` are
    // LEXICAL VARIABLE NAMES, not data strings — render them bare, like
    // positional inputs. renderValue would quote them and the op would
    // receive strings with no BREP handle
    // ("compound members are not all on the BREP chain").
    if (k === 'members' && Array.isArray(v)) {
      named.push(`members: [${v.join(', ')}]`);
      continue;
    }
    named.push(`${k}: ${renderValue(v)}`);
  }
  const namedBlock = named.length ? `{ ${named.join(', ')} }` : '';
  // M7.1: no leading comma when there are no positional args — a call with only
  // named params must render as `cad.profile({ ... })`, never `cad.profile(, {...})`.
  const rest = namedBlock ? (positional.length ? `, ${namedBlock}` : namedBlock) : '';
  return `${positional.join(', ')}${rest}`;
}
