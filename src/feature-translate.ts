/**
 * M4 — whitelisted feature translation: FCStd objects → cad-op call plan.
 *
 * M4.1 whitelist: anything not listed → baked (S3, no silent loss).
 * M4.2 primitives → cad.box/cylinder/cone/sphere
 * M4.3 booleans   → cad.union/subtract/intersect
 * M4.6 Pad/Pocket → cad.extrude/cad.subtract over the M3 sketch contour (M6: sketch is a cad.profile face)
 *
 * The call plan is an intermediate representation: M5 lowers it to .fai.js
 * (statements sN, variables partN). Geometry values are already mm (D7).
 */
import type { FcstdObject } from './document.js';
import { parseExpressionEngine, evalWithDoc, evalWithDocExpr, type ExpressionBinding } from './expressions.js';
import type { ParamTable } from './params.js';
import { isIdentityPlacement, placementOf, quatToMatrix } from './placement.js';
import { shapeBrpFile } from './external-geo.js';
import { isNonModelingType } from './structural-types.js';
import type { FilletEdgeEntry } from './fillet-edges.js';

/**
 * One cad-op call in the M4 call plan (lowered to .fai.js by M5).
 */
export interface CadCall {
  /** target variable name (partN, assigned by M5) */
  out: string;
  /** cad-op name, e.g. "cad.box" */
  op: string;
  /** positional + named params, JSON-serializable */
  params: Record<string, unknown>;
  /** variable names this call consumes (rendered positionally before literals) */
  inputs: string[];
  /** positional literal values appended after `inputs` (e.g. a direction Vec3) */
  literals?: unknown[];
  /** FCStd object this call came from */
  source: string;
  /**
   * When true, `inputs` is bookkeeping-only (dependency tracking / variable
   * remapping / consumed-set) and must NOT be rendered as positional args —
   * the real args come from `params`. Used by params-only ops like
   * `cad.compound` whose members live in `params.members` (rendering `inputs`
   * positionally would shadow `params`).
   */
  noPositionalArgs?: boolean;
}

/**
 * A raw JS expression argument that M5 renders verbatim instead of JSON-encoding.
 *
 * Needed when a call argument is itself a function call against a variable that
 * only exists at run time — e.g. `cad.edgeRef(baseShape, 17)` for the edge selection
 * of a Fillet/Chamfer (the EdgeTopoRef must be resolved against the live base
 * shape, so it cannot be baked into the IR as a literal).
 */
export interface JsExpr {
  /** the JS source to emit in the argument position */
  readonly __jsExpr: string;
}

/**
 * Wrap raw JS source as a verbatim argument (`JsExpr`).
 *
 * @param code - the JS expression source to emit in the argument position.
 * @returns the `JsExpr` marker carrying that source.
 */
export function jsExpr(code: string): JsExpr {
  return { __jsExpr: code };
}

/**
 * True for a `JsExpr` marker (used by M5 to render verbatim).
 *
 * @param v - the value to test.
 * @returns true when `v` is a `JsExpr` marker.
 */
export function isJsExpr(v: unknown): v is JsExpr {
  return typeof v === 'object' && v !== null && typeof (v as { __jsExpr?: unknown }).__jsExpr === 'string';
}

/**
 * Outcome of translating one FCStd object: a cad-op call plan, an explicit
 * bake with reason, or preserved-only (no geometry emitted).
 */
export type TranslateVerdict =
  | { kind: 'translated'; calls: CadCall[]; reason?: string }
  | { kind: 'baked'; reason: string }
  | { kind: 'preserved-only'; reason: string };

/**
 * H7 (hole_puzzle corpus, 2026-09-20): marker input for a subtract whose base
 * is implied by the Body's feature order (no explicit BaseFeature property).
 * Codegen retargets this at the chain head when folding the feature into its
 * Body chain. Never a legal variable name (contains `::`), so it cannot be
 * confused with a real input.
 */
export const BODY_CHAIN_BASE = '::body-chain-base::';

/** M4.1 whitelist (plan §5.5.5 measurable types only). */
const WHITELIST = new Set([
  'Part::Box',
  'Part::Cylinder',
  'Part::Cut',
  'Part::MultiFuse',
  'Part::Extrusion',
  'PartDesign::Pad',
  'PartDesign::Pocket',
  'PartDesign::Revolution',
  // P2-2 (2026-09-24): Groove is Revolution + subtractive — same Profile/
  // ReferenceAxis/Angle shape as Revolution, but cuts from the base feature
  // instead of fusing. Previously absent from the whitelist it silently fell
  // to preservedOnly (26 objects in Mannequin_mp alone).
  'PartDesign::Groove',
  'PartDesign::LinearPattern',
  'PartDesign::PolarPattern',
  'PartDesign::Fillet',
  'PartDesign::Chamfer',
  // M13.1 (probed on real corpus — fcstd-port/tools/probe-m13-types.ts):
  // Part::Compound carries a Links PropertyLinkList; Part::Sphere carries
  // Radius (+ optional Angle like Cylinder).
  'Part::Compound',
  'Part::Sphere',
  // P5 (2026-09-24): Part::Mirroring mirrors its Source across the plane
  // through Base with normal Normal (253 corpus occurrences).
  'Part::Mirroring',
  // P6 (2026-09-24): Part::Revolution revolves Source around the axis
  // through Base with direction Axis by Angle degrees (425 corpus
  // occurrences — highest-frequency untranslated Part::* type after P5).
  'Part::Revolution',
  // P7 (2026-09-24): Part::Fuse fuses Base + Tool (two PropertyLinks, same
  // serialization shape as Part::Cut — 42 corpus occurrences).
  'Part::Fuse',
  // P8 (2026-09-24): Part::Chamfer — Base link + edge selection AND sizes in
  // the binary PropertyFilletEdges ZIP member (109 corpus occurrences).
  'Part::Chamfer',
  // P9 (2026-09-24): Part::Fillet — same binary PropertyFilletEdges member as
  // Part::Chamfer (196 corpus occurrences). cad.fillet (M1) takes ONE uniform
  // radius for all edges, so per-edge / two-distance differences bake.
  'Part::Fillet',
  // P2-3 (2026-09-24): sweep/loft/helix translation branch. The kernel ops
  // `cad.sweep` / `cad.loft` / `cad.helix` (core, a4f9f30 / b0c4a92) are
  // already implemented; this wires the FCStd translator to emit them.
  // Corpus (library-profile.md): Part::Sweep 268, Part::Loft 107, Part::Helix <63.
  'Part::Sweep',
  'Part::Loft',
  'Part::Helix',
]);

/**
 * Geometry-input properties the translator resolves through `inputVar()` —
 * single-value links / link-subs (`App::PropertyLink`, `App::PropertyLinkSub`).
 *
 * `depsOf` (codegen.ts) MUST wait on exactly these; the two lists used to live
 * in separate files and drifted apart. `Sections` (Part::Loft / Part::Sweep
 * profile) and `Spine` (Part::Sweep path) were absent from `depsOf`, so Kahn
 * placed the feature at its document position — BEFORE its profile sketches.
 * `inputVar()` then returned undefined and the feature baked as
 * `loft-section-baked-upstream:<sketch>`, a pure ordering artifact reported as
 * an upstream gap (B2, Beds.FCStd `Loft002`).
 *
 * `UpToFace` (Pad/Pocket "up to face") is deliberately NOT listed: it may
 * reference geometry produced by a LATER feature, which would deadlock the
 * topological sort (codegen breaks cycles, so it would only reorder, but the
 * dependency is not an ordering requirement we can honour).
 *
 * @see LINK_LIST_INPUT_PROPS for the multi-value counterparts.
 */
export const LINK_INPUT_PROPS = [
  'Base', 'Tool', 'Profile', 'BaseFeature', 'Source', 'Sketch', 'Spine',
] as const;

/**
 * Geometry-input properties the translator resolves as a LIST of links
 * (`App::PropertyLinkList`) — the multi-value counterpart of
 * {@link LINK_INPUT_PROPS}. `Sections` (Part::Loft / Part::Sweep) and
 * `Originals` (pattern source features) belong here, not in the single-value
 * list: their `<Link value="...">` entries sit one level deeper, so reading
 * them as a single link silently yielded nothing.
 */
export const LINK_LIST_INPUT_PROPS = ['Shapes', 'Links', 'Sections', 'Originals'] as const;

/**
 * True when the object type is on the M4.1 translation whitelist.
 *
 * @param type - the FCStd object type, e.g. "Part::Box".
 * @returns true when the type is whitelisted for translation.
 */
export function isWhitelisted(type: string): boolean {
  return WHITELIST.has(type);
}

/**
 * H10 (plan §3.1/§3.5): C4's Python exception, decided by PROPERTY presence —
 * NOT by the `Python` type-name suffix. Matches the library profile's
 * pythonObjects口径 (profile.mjs: type contains "Python" or carries
 * Python/Proxy properties); here only the property evidence qualifies, so a
 * Python-suffixed type without the property stays a plain translation gap.
 * @param obj - the FCStd object to inspect.
 * @returns true when the object is a Python-scripted feature whose serialized
 *   shape is opaque (legitimate `python-baked` under C4).
 */
export function isPythonOpaque(obj: FcstdObject): boolean {
  for (const [name, prop] of obj.properties) {
    if (name === 'Python' || name === 'Proxy') return true;
    if (prop.type === 'App::PropertyPythonObject') return true;
  }
  return false;
}

function propNum(obj: FcstdObject, name: string): number | undefined {
  // M11.1: an ExpressionEngine binding overrides the stored <Float> value
  // (FreeCAD recomputes bound properties from expressions on load). A
  // non-constant binding is reported via exprBindingOf, not guessed here.
  const bound = expressionBindingOf(obj, name);
  if (bound && bound.value !== undefined) return bound.value;
  const p = obj.properties.get(name);
  if (!p) return undefined;
  const el = p.children[0];
  const v = el?.attributes['value'];
  return v === undefined ? undefined : Number(v);
}

/**
 * M11.1/M11.2: the ExpressionEngine binding for `name`, if any. `value` is
 * undefined for non-constant expressions (references/arithmetic) — the caller
 * must bake with an explicit reason instead of estimating.
 *
 * @param obj - the FCStd object whose ExpressionEngine to inspect.
 * @param name - the property name to look up.
 * @returns the binding for `name`, or undefined when the object has no
 *   ExpressionEngine binding for it.
 */
export function expressionBindingOf(obj: FcstdObject, name: string): ExpressionBinding | undefined {
  const bindings = parseExpressionEngine(obj.properties.get('ExpressionEngine') as never);
  if (bindings.length === 0) return undefined;
  const norm = (p: string): string => (p.startsWith('.') ? p.slice(1) : p);
  const b = bindings.find((b) => norm(b.path) === name);
  // P1-1（参数载体）：非常量绑定尝试三跳解析（<<Label>>.Alias → 单元格值）。
  // docObjects 由 translateObject 入口注入（模块级上下文，见 docContext）。
  if (b && b.value === undefined && docContext) {
    const v = evalWithDoc(b.expression, docContext);
    if (v !== undefined) return { ...b, value: v };
  }
  return b;
}

/** P1-1: translateObject 入口注入的文档对象上下文（表达式的引用解析需要全文档）。 */
let docContext: readonly FcstdObject[] | undefined;

/**
 * C3 (2026-09-28 plan): the document's leaf-parameter table, injected by
 * `convertFcstdFile` before codegen. Same module-context pattern as
 * {@link docContext} — the translator is reached through `translateObject`,
 * whose signature the whole call graph shares, so threading a second document
 * argument through it would touch every case for no benefit.
 */
let paramContext: ParamTable | undefined;

/**
 * Inject the leaf-parameter table used to keep bindings symbolic (C3).
 *
 * @param table - the table built by `collectLeafParams`, or undefined to clear it.
 */
export function setParamContext(table: ParamTable | undefined): void {
  paramContext = table;
}

/**
 * C3: the inline parameter EXPRESSION for a bound property, e.g.
 * `<<Data>>.width * 2` → `p_width * 2`.
 *
 * Only arithmetic over lifted `const p_*` leaves is expressible; every other
 * binding returns undefined so the caller keeps its existing behaviour (the
 * numeric bake, or an explicit bake reason when even that fails) — never a
 * guess.
 *
 * @param obj - the bound FCStd object.
 * @param name - the property name the binding drives.
 * @returns safe JS source for the expression, or undefined when not expressible.
 */
function paramExprOf(obj: FcstdObject, name: string): string | undefined {
  if (!docContext || !paramContext) return undefined;
  const b = expressionBindingOf(obj, name);
  if (!b) return undefined;
  const table = paramContext;
  return evalWithDocExpr(
    b.expression, docContext,
    (label, seg, sub) => table.refName(label, seg, sub),
    obj,
  );
}

/**
 * C3: a scalar property that may be emitted as a parameter expression.
 * `value` is always the convert-time number (used for parity and defaults);
 * `expr` is set only when the property is bound to arithmetic over lifted
 * parameters, in which case the emitted argument must stay symbolic.
 */
interface SymScalar {
  value: number;
  expr?: string;
}

/**
 * Resolve a numeric property to a possibly-symbolic scalar (C3).
 *
 * GOTCHA: an UNRESOLVABLE binding must return undefined, not the stored
 * property value. `propNum` deliberately falls back to the stored `<Float>`
 * when the binding cannot be evaluated, and using that here would silently
 * cancel the caller's explicit `*-expression-non-constant` bake — the pad would
 * emit a stale length instead of reporting the gap.
 */
function propScalar(obj: FcstdObject, name: string): SymScalar | undefined {
  const bound = expressionBindingOf(obj, name);
  if (bound && bound.value === undefined) return undefined;
  const value = propNum(obj, name);
  if (value === undefined) return undefined;
  const expr = paramExprOf(obj, name);
  return expr === undefined ? { value } : { value, expr };
}

/** Symbolic `s / k` (C3 helper). */
function symDiv(s: SymScalar, k: number): SymScalar {
  return { value: s.value / k, expr: s.expr === undefined ? undefined : `(${s.expr}) / ${k}` };
}

/** Symbolic `-s`; normalizes `-0` to `0` so the emitted literal stays clean. */
function symNeg(s: SymScalar): SymScalar {
  return { value: -s.value || 0, expr: s.expr === undefined ? undefined : `-(${s.expr})` };
}

/** Render a symbolic scalar: a plain number, or a verbatim JsExpr. */
function emitScalar(s: SymScalar): number | JsExpr {
  return s.expr === undefined ? s.value : jsExpr(s.expr);
}

/**
 * M11.2: detect a non-constant expression binding on a property.
 *
 * @param obj - the FCStd object whose ExpressionEngine to inspect.
 * @param name - the property name to look up.
 * @returns true when `name` has a binding that is NOT a constant expression.
 */
export function hasNonConstantBinding(obj: FcstdObject, name: string): boolean {
  const b = expressionBindingOf(obj, name);
  return b !== undefined && b.value === undefined;
}

function propBool(obj: FcstdObject, name: string): boolean {
  const el = obj.properties.get(name)?.children[0];
  return el?.attributes['value'] === 'true';
}

function propLink(obj: FcstdObject, name: string): string | undefined {
  const el = obj.properties.get(name)?.children[0];
  const v = el?.attributes['value'];
  return v && v.length > 0 ? v : undefined;
}

/** Read a string-valued property (e.g. ReferenceAxis). */
function propStr(obj: FcstdObject, name: string): string | undefined {
  const el = obj.properties.get(name)?.children[0];
  const v = el?.attributes['value'];
  return v && v.length > 0 ? v : undefined;
}

/**
 * First `<Sub value="...">` of a LinkSub property, or undefined.
 *
 * GOTCHA (2026-09-27, W1 revolve REVOLVE_FAILED): `ReferenceAxis` is an
 * `App::PropertyLinkSub` — `value="Sketch075"` names the linked OBJECT and the
 * referenced geometry (`H_Axis` / `V_Axis` / an edge id) lives in a child
 * `<Sub>` element. `propStr` only reads the `value` attribute, so it returned
 * `"Sketch075"`, which `parseReferenceAxis` matched against no standard axis
 * and silently fell back to the +Z default — revolving an XY-plane profile
 * about an in-plane Z axis degenerates and OCCT fails with REVOLVE_FAILED.
 */
function propLinkSubFirst(obj: FcstdObject, name: string): string | undefined {
  return propLinkSub(obj, name)?.subs[0];
}

/**
 * Resolve a ReferenceAxis/Direction/Axis LinkSub into an axis + pivot.
 *
 * Tries, in order: ① `EdgeN` against the linked sketch's geometry list
 * ({@link resolveSketchEdgeAxis} — needs docContext); ② the standard body-axis
 * names via {@link parseReferenceAxis} (H_Axis/V_Axis/…; also used when the
 * property carries no <Sub> child). Returns undefined when the reference names
 * geometry that cannot be resolved — callers bake with an explicit reason.
 */
function resolveAxisRef(obj: FcstdObject, name: string): { axis: [number, number, number]; at: [number, number, number] } | undefined {
  const ls = propLinkSub(obj, name);
  if (ls) {
    const sub = ls.subs[0];
    if (sub) {
      const edge = /Edge(\d+)/i.exec(sub);
      if (edge) return resolveSketchEdgeAxis(ls.obj, Number(edge[1]));
      return parseReferenceAxis(sub);
    }
  }
  return parseReferenceAxis(propStr(obj, name));
}

/**
 * M9.1 — Pad/Pocket `Type` enumeration (App::PropertyEnumeration, stored as
 * the string enum label OR its integer index — both seen in the corpus).
 * FreeCAD sources: Pad.h / Pocket.h TypeEnum lists (differs between the two):
 *   Pad:    0=Length 1=UpToLast 2=UpToFirst 3=UpToFace 4=TwoLengths
 *   Pocket: 0=Length 1=ThroughAll 2=UpToFirst 3=UpToFace 4=TwoLengths
 * A missing Type property means Length (0) — the FreeCAD default.
 */
export type FeatureType =
  | 'Length' | 'ThroughAll' | 'UpToLast' | 'UpToFirst' | 'UpToFace' | 'TwoLengths' | 'unknown';

const PAD_TYPES: Record<string, FeatureType> = {
  '0': 'Length', '1': 'UpToLast', '2': 'UpToFirst', '3': 'UpToFace', '4': 'TwoLengths',
  Length: 'Length', UpToLast: 'UpToLast', UpToFirst: 'UpToFirst', UpToFace: 'UpToFace', TwoLengths: 'TwoLengths',
};
const POCKET_TYPES: Record<string, FeatureType> = {
  '0': 'Length', '1': 'ThroughAll', '2': 'UpToFirst', '3': 'UpToFace', '4': 'TwoLengths',
  Length: 'Length', ThroughAll: 'ThroughAll', UpToFirst: 'UpToFirst', UpToFace: 'UpToFace', TwoLengths: 'TwoLengths',
};

/**
 * Read the Pad/Pocket `Type` enumeration of an object (M9.1).
 *
 * @param obj - the FCStd Pad or Pocket object.
 * @param kind - which type-enum table to apply (Pad vs Pocket labels differ).
 * @returns the parsed feature type; 'Length' when Type is missing, 'unknown'
 *   when the stored label/index is not recognized.
 */
export function featureTypeOf(obj: FcstdObject, kind: 'pad' | 'pocket'): FeatureType {
  const el = obj.properties.get('Type')?.children[0];
  const raw = el?.attributes['value'];
  if (raw === undefined || raw === '') return 'Length';
  const table = kind === 'pad' ? PAD_TYPES : POCKET_TYPES;
  return table[raw] ?? 'unknown';
}

/** Read an App::PropertyVector (`value="x y z"`) as a Vec3. */
function propVec(obj: FcstdObject, name: string): [number, number, number] | undefined {
  const raw = propStr(obj, name);
  if (!raw) return undefined;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * Read an App::PropertyVector serialized as a `<PropertyVector valueX= valueY=
 * valueZ=/>` child element (P5: Part::Mirroring Base/Normal use this form —
 * GOTCHA: propVec expects `value="x y z"`, a DIFFERENT serialization).
 */
function propVecXYZ(obj: FcstdObject, name: string): [number, number, number] | undefined {
  const a = obj.properties.get(name)?.children[0]?.attributes;
  if (!a) return undefined;
  const x = Number(a['valueX']), y = Number(a['valueY']), z = Number(a['valueZ']);
  if (![x, y, z].every(Number.isFinite)) return undefined;
  return [x, y, z];
}

/** Normalize a Vec3 to unit length (zero-safe: returns input if |v| = 0). */
function normalize3(v: [number, number, number]): [number, number, number] {
  const mag = Math.hypot(v[0], v[1], v[2]);
  if (mag <= 0) return v;
  return [v[0] / mag, v[1] / mag, v[2] / mag];
}

/**
 * Read an `App::PropertyLinkSub`: the target object name plus its sub-element
 * names. FreeCAD serializes this as
 * `<LinkSub value="Pad001" count="2"><Sub value="Edge17"/><Sub value="Edge18"/></LinkSub>`.
 */
function propLinkSub(obj: FcstdObject, name: string): { obj: string; subs: string[] } | undefined {
  const el = obj.properties.get(name)?.children[0];
  if (!el) return undefined;
  const target = el.attributes['value'];
  if (!target || target.length === 0) return undefined;
  const subs: string[] = [];
  for (const sub of el.children) {
    const v = sub.attributes['value'];
    if (v) subs.push(v);
  }
  return { obj: target, subs };
}

/**
 * Parse FreeCAD edge sub-element names (`Edge17`) into 1-based ordinals.
 * Returns undefined when any entry is not an `EdgeN` reference (a Face/Vertex
 * selection cannot be expressed as a faijs `EdgeTopoRef`).
 */
function parseEdgeSubs(subs: readonly string[]): number[] | undefined {
  const out: number[] = [];
  for (const s of subs) {
    const m = /^Edge(\d+)$/.exec(s);
    if (!m) return undefined;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1) return undefined;
    out.push(n);
  }
  return out;
}

/**
 * Parse a FreeCAD face sub-element name (`Face3`) into a 1-based ordinal.
 * Returns undefined when the selection is not a plain `FaceN` reference (e.g. a
 * TNaming-modified name `"Face__20f_..."`, an `Edge*`/`Vertex*` selection, or a
 * multi-face set) so the caller can bake with an explicit reason instead of
 * guessing. The ordinal is consumed by `cad.faceRef`, whose face enumeration
 * order is calibrated to match FreeCAD's `FaceN` (plan §4.3-C2 / R-A).
 */
function parseFaceSub(subs: readonly string[]): number | undefined {
  if (subs.length !== 1) return undefined;
  const m = /^Face(\d+)$/.exec(subs[0]!);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Build the `edges` argument for a fillet/chamfer call: one `cad.edgeRef(base, N)`
 * expression per FreeCAD edge ordinal. The refs must be resolved against the
 * live base shape at run time (an `EdgeTopoRef` is a two-face role pair, which
 * only the runtime naming layer knows), so they enter the IR as `JsExpr`.
 */
function edgeRefArgs(baseVar: string, ordinals: readonly number[]): JsExpr[] {
  return ordinals.map((n) => jsExpr(`cad.edgeRef(${baseVar}, ${n})`));
}

/**
 * Parse a PartDesign ReferenceAxis reference into a 3D axis + pivot point.
 *
 * FreeCAD stores this as an `App::PropertyLinkSub` string that either names a
 * standard body axis (`V_Axis` / `H_Axis` / `N_Axis`, or the generic `Axis`
 * that PartDesign revolves around = +Z) or an edge/vertex of another feature.
 * Edge/vertex axes require resolving referenced geometry, which the port does
 * not yet do (explicit downgrade, no silent loss).
 *
 * @param ref - the ReferenceAxis (or Direction) LinkSub string, may be undefined.
 * @returns a unit axis and pivot point, or undefined when the reference names
 *   edge/vertex geometry (unsupported).
 */
export function parseReferenceAxis(ref: string | undefined): { axis: [number, number, number]; at: [number, number, number] } | undefined {
  const at: [number, number, number] = [0, 0, 0];
  if (!ref) return { axis: [0, 0, 1], at };
  if (/Edge|Vertex/i.test(ref)) return undefined; // geometry-referenced axis: unsupported
  // Standard body axes. PartDesign LinearPattern stores Direction as a LinkSub
  // naming X_Axis/Y_Axis/Z_Axis; older ReferenceAxis uses V_Axis/H_Axis/N_Axis.
  if (/X_Axis|H_Axis/i.test(ref)) return { axis: [1, 0, 0], at };
  if (/Y_Axis/i.test(ref)) return { axis: [0, 1, 0], at };
  if (/Z_Axis|V_Axis/i.test(ref)) return { axis: [0, 0, 1], at };
  if (/N_Axis/i.test(ref)) return { axis: [1, 0, 0], at }; // legacy mapping, keep stable
  // The generic "Axis" or anything else defaults to +Z (sketch normal)
  return { axis: [0, 0, 1], at };
}

/**
 * Resolve a `EdgeN` ReferenceAxis against the linked sketch's geometry list.
 *
 * W1 (2026-09-27, Mannequin_mp corpus): Revolution037/Groove029 reference
 * `Sketch069` + `Edge3` — the axis is a sketch edge (a horizontal construction
 * line), which FreeCAD places at the sketch's in-plane coordinates. The axis
 * must be read from the sketch's `Geometry` property (1-based EdgeN order)
 * and transformed by the sketch's Placement into body coordinates.
 *
 * Only straight line segments resolve (the only edge kind the corpus uses as
 * a revolve axis); arcs/other kinds return undefined (explicit unsupported,
 * no silent fallback).
 *
 * @param sketchName - the linked sketch object name.
 * @param edgeOrdinal - 1-based edge ordinal from the `<Sub value="EdgeN"/>`.
 * @returns unit axis (sketch Placement applied) + axis base point, or
 *   undefined when the sketch/edge cannot be resolved.
 */
function resolveSketchEdgeAxis(sketchName: string, edgeOrdinal: number): { axis: [number, number, number]; at: [number, number, number] } | undefined {
  const sketch = docContext?.find((o) => o.name === sketchName);
  if (!sketch || sketch.type !== 'Sketcher::SketchObject') return undefined;
  const geomProp = sketch.properties.get('Geometry');
  const list = geomProp?.children[0];
  if (!list) return undefined;
  const edges = list.children.filter((c) => c.tagName === 'Geometry');
  const edge = edges[edgeOrdinal - 1]; // EdgeN is 1-based
  if (!edge) return undefined;
  const line = edge.children.find((c) => c.tagName === 'LineSegment');
  if (!line) return undefined; // arc/other edge as axis: unsupported
  const a = line.attributes;
  const sx = Number(a['StartX']), sy = Number(a['StartY']);
  const ex = Number(a['EndX']), ey = Number(a['EndY']);
  if (![sx, sy, ex, ey].every(Number.isFinite)) return undefined;
  const dx = ex - sx, dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len <= 0) return undefined;
  // Sketch-local direction → body coordinates via the sketch Placement
  // (sketches here carry identity or simple placements; rotate the 2D
  // direction by the placement quaternion, then normalize).
  const plc = placementOf(sketch);
  const m = quatToMatrix(plc.q);
  const local = [dx / len, dy / len, 0];
  const axis: [number, number, number] = [
    m[0]! * local[0]! + m[1]! * local[1]!,
    m[3]! * local[0]! + m[4]! * local[1]!,
    m[6]! * local[0]! + m[7]! * local[1]!,
  ];
  const mag = Math.hypot(...axis);
  if (mag <= 0) return undefined;
  const at: [number, number, number] = [plc.p[0], plc.p[1], plc.p[2]];
  return { axis: [axis[0]! / mag, axis[1]! / mag, axis[2]! / mag], at };
}

/**
 * Resolve a Pad/Pocket profile link. Modern files use `Profile`; files saved
 * by FreeCAD ≤ 0.19 store the sketch directly under `Sketch` (observed in
 * PadTest.fcstd, ProgramVersion 0.14/0.17 era).
 */
function profileLink(obj: FcstdObject): string | undefined {
  return propLink(obj, 'Profile') ?? propLink(obj, 'Sketch');
}

/**
 * Placement position (translation) of an object.
 *
 * @param obj - the FCStd object to read.
 * @returns the (Px, Py, Pz) translation from its Placement, or (0,0,0) when absent.
 */
export function placementPos(obj: FcstdObject): [number, number, number] {
  // Property → <PropertyPlacement Px=... Py=... Pz=.../>
  const pp = obj.properties.get('Placement')?.children[0];
  if (!pp) return [0, 0, 0];
  return [
    Number(pp.attributes['Px'] ?? 0),
    Number(pp.attributes['Py'] ?? 0),
    Number(pp.attributes['Pz'] ?? 0),
  ];
}

/**
 * A frozen `.brp` shape delivered through the container's `assets/` becomes an
 * addressable Shape via `cad.import_brep` — the **platform** BREP-asset import
 * op (`api/import-brep.ts`), which reads through the host asset resolver and
 * returns a BREP-backed Shape the rest of the chain can consume.
 *
 * GOTCHA (2026-09-21, found while verifying ArchDetail): the shape-asset rounds
 * used to emit a made-up `cad.import_shape`, which is **not** in the cad
 * namespace. 42 of the 50 corpus products therefore parsed clean but could not
 * RUN — `cliCheck` validates syntax and script-local references, never the
 * callee's existence, so only a real `run --mode brep` exposes this.
 *
 * Contract details:
 * - asset: the asset file name WITHOUT extension — that is the key rule of the
 *   documented directory mode of `FsAssetResolver` (`key = basename(file)`),
 *   which is how a container's `assets/` directory is exposed.
 *
 * C6 (non-solid first-class): `cad.import_brep` always imports with
 * `allowNonSolid` (wire/face/shell are first-class). There is no `format`
 * hint — the op goes straight to `loadBrep` on the OCCT kernel, which needs
 * no format detection. Booleans / up-to targets that require a solid still
 * fail at the **use site**, never at the import site.
 *
 * @param obj - the FCStd object whose frozen shape is being imported.
 * @param assetFile - the `.brp` member name recorded on the object's Shape/SubShape property.
 * @returns the `cad.import_brep` call binding `obj.name` to the imported geometry.
 */
function shapeAssetCall(obj: FcstdObject, assetFile: string): CadCall {
  const asset = assetFile.replace(/^.*[/\\]/, '').replace(/\.brp$/i, '');
  return {
    out: obj.name, op: 'cad.import_brep', source: obj.name, inputs: [],
    params: { asset },
  };
}

/**
 * M4 translate one object. `inputVar` maps a dependency object name to the
 * variable holding its geometry (sketch contours or prior solid).
 *
 * `docObjects` (optional) is the full document object list — needed by the
 * UpToFace datum-plane path to read the target plane's Placement (plan
 * extrude-upto-face §4.3-C1). When absent, UpToFace keeps the explicit bake.
 *
 * @param obj - the FCStd object to translate.
 * @param inputVar - resolves a dependency object name to the variable holding
 *   its geometry (sketch contours or prior solid).
 * @param docObjects - the full document object list, needed by the UpToFace
 *   datum-plane path; optional.
 * @param shapeCarriers - objects whose Shape is stored as a .brp member; optional.
 * @param brokenShapeAssets - objects whose Shape `file` attribute points at a missing/empty member (explicit gap); optional.
 * @param filletEdgesData - parsed PropertyFilletEdges binaries keyed by object name (Part::Chamfer/Fillet); optional.
 * @returns the cad-op call plan, or an explicit bake/preserve verdict with reason.
 */
export function translateObject(
  obj: FcstdObject,
  inputVar: (depName: string) => string | undefined,
  docObjects?: readonly FcstdObject[],
  /** H7: names of objects whose Shape is stored as a .brp member (probed from the ZIP). */
  shapeCarriers?: ReadonlySet<string>,
  /** E4: objects whose Shape `file` attribute points at a missing/empty member. */
  brokenShapeAssets?: ReadonlySet<string>,
  /** P8: parsed PropertyFilletEdges binaries keyed by object name (Part::Chamfer/Fillet). */
  filletEdgesData?: ReadonlyMap<string, FilletEdgeEntry[]>,
): TranslateVerdict {
  // P1-1（参数载体）：注入文档上下文，让 expressionBindingOf 能做
  // <<Label>>.Alias 三跳解析（引用算术需要全文档找 Spreadsheet 数据源）。
  if (docObjects) docContext = docObjects;
  // E4 (H12): a Shape/SubShape `file` attribute whose member is missing or
  // zero-bytes in the archive is a BROKEN asset, not a shape-asset — surface
  // it as an explicit convert-time gap instead of letting the object fall
  // through to python-opaque (which would silently swallow the defect).
  //
  // GOTCHA (2026-09-26): the evidence must NOT preempt a type we can actually
  // translate. `RND_455_00194.fcstd` stores a zero-byte `PartShape69.brp` for
  // `LinearPattern` and zero-byte caches for 23 `PartDesign::Mirrored`
  // features; FreeCAD routinely saves an empty shape cache for a feature whose
  // geometry is folded into the Body. Preempting turned a perfectly
  // translatable `PartDesign::PolarPattern`/`LinearPattern` (own branch below)
  // into a gap for a fact that says nothing about translatability. The check
  // therefore only applies to types that fall through to python-opaque /
  // type-not-whitelisted — which is exactly the fall-through E4 was written
  // for.
  if (brokenShapeAssets?.has(obj.name) && !isWhitelisted(obj.type)) {
    return { kind: 'baked', reason: 'shape-asset-broken: frozen .brp member missing or empty' };
  }
  // H7 follow-up (Body-less CAM corpus, 2026-09-20): a SubShape property whose
  // .brp member exists is the feature's own RESULT cache — the pocketed/
  // filleted geometry is already a fact delivered via assets/. shape-asset
  // beats an honest-but-useless dependency gap for Body-less files. Only
  // SubShape qualifies (Pads also carry Shape in these files — they must keep
  // the normal translation path).
  if (shapeCarriers?.has(obj.name) && obj.properties.has('SubShape')) {
    // The result cache is a real, addressable solid: downstream features
    // (Fillet Base→Pocket, Cut Base→…) must resolve it as a variable, so the
    // verdict emits a real load call instead of zero calls (hole_puzzle
    // GOTCHA: zero-call objects got no codegen variable and consumers gapped
    // with fillet-missing-base / cut-missing-dependency).
    const assetFile = obj.properties.get('SubShape')?.children[0]?.attributes['file'] ?? `${obj.name}.SubShape.brp`;
    return {
      kind: 'translated',
      calls: [shapeAssetCall(obj, assetFile)],
      reason: 'shape-asset',
    };
  }
  if (!isWhitelisted(obj.type)) {
    // GOTCHA (EngineBlock corpus, 2026-09-20): Shape-asset evidence PRECEDES
    // python-opaque. Draft circles carry Proxy (python evidence) AND a real
    // Shape .brp member; python-opaque baked them silently and downstream
    // Part::Extrusion gapped with extrusion-missing-base. Geometry is an
    // existing fact — import it.
    if (shapeCarriers?.has(obj.name)) {
      const assetFile = shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`;
      return {
        kind: 'translated',
        calls: [shapeAssetCall(obj, assetFile)],
        reason: 'shape-asset',
      };
    }
    // H10: property-evidenced Python features bake legitimately (C4) —
    // auditMapping renames this reason to `python-baked`. Everything else is
    // a plain translation gap.
    if (isPythonOpaque(obj)) return { kind: 'baked', reason: 'python-opaque' };
    // H7 first cut: a Part::Feature is a pure Shape carrier (corpus probe:
    // property surface is Shape [+ShapeMaterial] only; geometry lives in the
    // ZIP's .brp member). With shape evidence there is nothing to translate —
    // the geometry is delivered via assets/ (build-fai-zip M2.3 already copies
    // it), so record `translated` with no cad calls. Without evidence it is an
    // explicit gap, never a silent bake.
    if (obj.type === 'Part::Feature') {
      if (shapeCarriers?.has(obj.name)) return { kind: 'translated', calls: [], reason: 'shape-asset' };
      return { kind: 'baked', reason: 'shape-asset-missing' };
    }
    return { kind: 'baked', reason: `type-not-whitelisted: ${obj.type}` };
  }
  /** Map FreeCAD Part::Sweep `Transition` (enum label or index) → cad.sweep transitionMode. */
  function normalizeSweepTransition(raw: string | undefined): 'right' | 'transformed' | 'round' | undefined {
    if (raw === undefined) return undefined;
    if (raw === 'RightAngle' || raw === '0') return 'right';
    if (raw === 'Transformed' || raw === '1') return 'transformed';
    if (raw === 'Round' || raw === '2') return 'round';
    return undefined;
  }

  // `out` is the source object's own name. The M5 codegen uses it verbatim as
  // the generated variable name (sanitized by emitVar) — faijs variable names
  // are ANY legal JS identifier, never a `partN` counter. `partN` is only a
  // UI-layer detail (lang/allocate-id.ts derivePartName) and must not be
  // depended on here.
  const out = obj.name;
  switch (obj.type) {
    case 'Part::Box': {
      const l = propNum(obj, 'Length') ?? 0;
      const w = propNum(obj, 'Width') ?? 0;
      const h = propNum(obj, 'Height') ?? 0;
      // FCStd Box: corner at Placement, extends +X/+Y/+Z
      const [x, y, z] = placementPos(obj);
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.box', source: obj.name, inputs: [],
          params: { width: w, depth: l, height: h, at: [x, y, z], centered: false },
        }],
      };
    }
    case 'Part::Cylinder': {
      const r = propNum(obj, 'Radius') ?? 0;
      const h = propNum(obj, 'Height') ?? 0;
      const [x, y, z] = placementPos(obj);
      const angle = propNum(obj, 'Angle') ?? 360;
      if (angle !== 360) return { kind: 'baked', reason: 'cylinder-partial-angle' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.cylinder', source: obj.name, inputs: [],
          params: { radius: r, height: h, at: [x, y, z], centered: false },
        }],
      };
    }
    case 'Part::Compound': {
      // M13.1 probe (ArchDetail.FCStd): members live in a `Links`
      // PropertyLinkList; every corpus instance also stores a baked .brp,
      // but translating the member group keeps the chain explicit.
      const linksEl = obj.properties.get('Links')?.children[0];
      const members: string[] = [];
      for (const link of linksEl?.children ?? []) {
        const v = link.attributes['value'];
        if (v) members.push(v);
      }
      // C5 (2026-09-28, FCBL_curtain / FCBL_bed_double / FCBL_nightstand):
      // a `Part::Compound` Links list routinely contains NON-MODELING objects —
      // the FCBL family lists `App::VarSet` (a parameter container the Extrudes
      // read their expressions from) FIRST. FreeCAD's Part::Compound ignores
      // members without a Shape, but requiring all links to resolve a geometry
      // variable gapped the whole file. Skip members whose TYPE is non-modeling;
      // the predicate is the one shared with codegen's pre-translation
      // short-circuit and the C4 audit (structural-types.ts), so a member can
      // never be dropped here yet emitted as a modeling feature elsewhere.
      // A member absent from `docObjects` (translator called without the
      // document, as in unit tests) stays REQUIRED — never drop on ignorance.
      const objectsByName = new Map((docObjects ?? []).map((o) => [o.name, o]));
      const geometryMembers = members.filter((m) => {
        const member = objectsByName.get(m);
        return member ? !isNonModelingType(member.type) : true;
      });
      const vars = geometryMembers.map((m) => inputVar(m));
      // P1.6 (2026-09-28, arduino-mega corpus): a Part::Compound with an EMPTY
      // Links list (`<LinkList count="0">`) serializes no members at all —
      // FreeCAD dissolved them. The compound still carries its frozen result
      // Shape (.brp member): shape-asset import is the honest fallback (D8),
      // keeping downstream consumers alive.
      if (vars.length === 0 || vars.some((v) => v === undefined)) {
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: compound-missing-members fallback',
          };
        }
        return { kind: 'baked', reason: 'compound-missing-members' };
      }
      // `Part::Compound` 是几何对象（`Part::Feature` 子类，带 Shape + Placement）。
      // 用平台几何 compound（`cad.compound`，内核 `makeCompound`，持 OCCT 句柄，
      // 可变换/可导出），不再借用 ../3d_editor 的结构分组 op `cad.group`。
      // members 经 `params.members` 传递；`inputs` 仅作依赖登记（consumed / 变量重映射），
      // 由 `noPositionalArgs` 保证不被 renderArgs 当作位置参数渲染。
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.compound', source: obj.name, inputs: vars as string[],
          noPositionalArgs: true, params: { members: vars },
        }],
      };
    }
    case 'Part::Sphere': {
      const r = propNum(obj, 'Radius');
      if (r === undefined || r <= 0) return { kind: 'baked', reason: 'sphere-missing-radius' };
      const angle1 = propNum(obj, 'Angle1') ?? -90;
      const angle2 = propNum(obj, 'Angle2') ?? 90;
      const angle3 = propNum(obj, 'Angle3') ?? 360;
      if (angle1 !== -90 || angle2 !== 90 || angle3 !== 360) {
        // P1.1 (2026-09-28, multifuse-missing-dependency): a partial-angle
        // sphere used to bake with NO variable, so any Part::MultiFuse listing
        // it in `Shapes` gaped with `multifuse-missing-dependency` (led-5mm /
        // RGB-led-5mm corpus: Fusion.Shapes = [Cylinder, Cylinder001, Sphere]).
        // The sphere still carries its frozen result Shape (.brp member) —
        // importing it as a shape-asset is an honest fact, not fake
        // parametrization (D8), and keeps the fusion chain alive.
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: sphere-partial-angle fallback',
          };
        }
        return { kind: 'baked', reason: 'sphere-partial-angle' };
      }
      const [x, y, z] = placementPos(obj);
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.sphere', source: obj.name, inputs: [],
          params: { radius: r, at: [x, y, z] },
        }],
      };
    }
    case 'Part::Mirroring': {
      // P5: mirror Source across the plane through Base with normal Normal.
      // The result is the mirrored copy alone (FreeCAD does NOT fuse the
      // original in Part::Mirroring — the corpus pairs it with explicit
      // fusion features when needed), so this maps to `cad.mirror`, not
      // `cad.mirrorJoin`.
      const src = propLink(obj, 'Source');
      const s = src ? inputVar(src) : undefined;
      // P1.5 (2026-09-28): same frozen-result fallback as the pattern branches
      // below — an unresolvable Source must not orphan the downstream chain
      // when the mirror carries its own frozen Shape.
      if (!s) {
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: mirroring-missing-source fallback',
          };
        }
        return { kind: 'baked', reason: 'mirroring-missing-source' };
      }
      const base = propVecXYZ(obj, 'Base') ?? [0, 0, 0];
      const normalRaw = propVecXYZ(obj, 'Normal');
      if (!normalRaw || Math.hypot(...normalRaw) <= 0) {
        return { kind: 'baked', reason: 'mirroring-missing-normal' };
      }
      const normal = normalize3(normalRaw);
      // FreeCAD mirrors across the plane through (Base + Placement translation)
      // — Placement here is a pure translation in all corpus samples; the
      // plane point is Base shifted by it.
      const [px, py, pz] = placementPos(obj);
      const at = [base[0]! + px, base[1]! + py, base[2]! + pz] as [number, number, number];
      return {
        kind: 'translated',
        calls: [{
          // GOTCHA (2026-09-25, A1 mirror E_OP_FAILED): `cad.mirror(input,
          // options)` takes the SOURCE SHAPE as a POSITIONAL arg. Do NOT set
          // `noPositionalArgs` here — that flag is only for ops with zero
          // positional inputs (e.g. cad.compound({ members })), and setting it
          // made renderArgs drop `inputs[0]`, emitting
          // `cad.mirror({ normal, at })` with no geometry → E_OP_FAILED at run.
          out, op: 'cad.mirror', source: obj.name, inputs: [s],
          params: { normal, at },
        }],
      };
    }
    case 'Part::Cut': {
      const base = propLink(obj, 'Base');
      const tool = propLink(obj, 'Tool');
      const b = base ? inputVar(base) : undefined;
      const t = tool ? inputVar(tool) : undefined;
      if (!b || !t) return { kind: 'baked', reason: 'cut-missing-dependency' };
      return {
        kind: 'translated',
        calls: [{ out, op: 'cad.subtract', source: obj.name, inputs: [b, t], params: {} }],
      };
    }
    case 'Part::Fuse': {
      // P7: same Base/Tool PropertyLink serialization as Part::Cut, but
      // fuses instead of cutting.
      const fuseBase = propLink(obj, 'Base');
      const fuseTool = propLink(obj, 'Tool');
      const fb = fuseBase ? inputVar(fuseBase) : undefined;
      const ft = fuseTool ? inputVar(fuseTool) : undefined;
      if (!fb || !ft) return { kind: 'baked', reason: 'fuse-missing-dependency' };
      return {
        kind: 'translated',
        calls: [{ out, op: 'cad.union', source: obj.name, inputs: [fb, ft], params: {} }],
      };
    }
    case 'Part::MultiFuse': {
      // <LinkList count="N"><Link value="A"/>...</LinkList>
      const shapes = propLinkList(obj, 'Shapes');
      const inputs = shapes.map(inputVar);
      if (shapes.length < 2 || inputs.some((i) => i === undefined)) {
        return { kind: 'baked', reason: 'multifuse-missing-dependency' };
      }
      return {
        kind: 'translated',
        calls: [{ out, op: 'cad.union', source: obj.name, inputs: inputs as string[], params: {} }],
      };
    }
    case 'PartDesign::Pad': {
      const profile = profileLink(obj);
      const lenSym = propScalar(obj, 'Length');
      const reversed = propBool(obj, 'Reversed');
      const midplane = propBool(obj, 'Midplane');
      const profileVar = profile ? inputVar(profile) : undefined;
      if (!profileVar) return { kind: 'baked', reason: 'pad-missing-profile' };
      // M11.2: a non-constant expression binding (cross-object reference /
      // identifier arithmetic) leaves the length unknown — explicit bake,
      // never estimate (plan §12). C3 (2026-09-28): a binding that resolves to
      // arithmetic over lifted `const p_*` parameters is NOT unknown — it stays
      // symbolic and is emitted inline (`propScalar` reports it), so only a
      // genuinely unresolvable binding bakes here.
      if (!lenSym && hasNonConstantBinding(obj, 'Length')) {
        return { kind: 'baked', reason: 'pad-length-expression-non-constant' };
      }
      // M9.1/M9.2: Type-driven semantics — no silent Length fallback.
      const ftype = featureTypeOf(obj, 'pad');
      if (ftype === 'TwoLengths') {
        const len2Sym = propScalar(obj, 'Length2') ?? { value: 0 };
        // TwoLengths: Length forward + Length2 backward, fused. Named
        // intermediate vars so mapping/debug can locate each segment.
        const pos = `${out}__pos`;
        const neg = `${out}__neg`;
        const calls: CadCall[] = [
          { out: pos, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, emitScalar(lenSym ?? { value: 0 })]], params: {} },
          { out: neg, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, emitScalar(symNeg(len2Sym))]], params: {} },
          { out, op: 'cad.union', source: obj.name, inputs: [pos, neg], params: {} },
        ];
        return { kind: 'translated', calls };
      }
      if (ftype === 'UpToFace') {
        // extrude-upto-face plan §4.3-C1: when the target is a datum plane
        // (PartDesign::Plane — an infinite plane, not a solid face), the
        // extrude length is the exact signed distance from the profile plane
        // to the datum plane. Zero bake, no faceRef needed.
        const upTo = propLinkSub(obj, 'UpToFace');
        if (upTo && docObjects) {
          const target = docObjects.find((o) => o.name === upTo.obj);
          // C1 (extrude-upto-face §4.3-C1): datum plane (infinite plane) →
          // exact signed distance → cad.extrude({ length }). No faceRef needed.
          if (target && target.type === 'PartDesign::Plane') {
            const pl = placementOf(target);
            // datum plane normal = placement R * local +Z
            const m = quatToMatrix(pl.q);
            const normal: [number, number, number] = [m[2]!, m[5]!, m[8]!];
            // sketch normal (the extrude direction); the profile sketch lies on
            // its own placement, and the feature extrudes along it.
            const skPl = placementOf(docObjects.find((o) => o.name === (profile ?? '')) ?? target);
            const skM = quatToMatrix(skPl.q);
            const dir: [number, number, number] = [skM[2]!, skM[5]!, skM[8]!];
            // GOTCHA (probe-upto-padtest-verify.ts, PadTest Pad001): the datum
            // plane is an arbitrary plane, NOT axis-aligned to the extrude
            // direction. The signed distance to reach it along `dir` is
            //   t = ((pl.p - skPl.p) · n) / (dir · n)
            // where n is the datum plane normal — NOT the naive (Δp · dir),
            // which only works when n ∥ dir (axis-aligned). The naive form
            // yields −50 for PadTest while the true distance is +10; the
            // corrected form matches FreeCAD's Tip bbox exactly (diag 156.84).
            const denom = dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2];
            // plane parallel to the extrude direction → no finite intersection
            if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) {
              return { kind: 'baked', reason: 'uptoface-datum-plane-parallel' };
            }
            const dpn =
              (pl.p[0] - skPl.p[0]) * normal[0] +
              (pl.p[1] - skPl.p[1]) * normal[1] +
              (pl.p[2] - skPl.p[2]) * normal[2];
            const t = dpn / denom;
            if (Number.isFinite(t) && Math.abs(t) > 1e-9) {
              // GOTCHA (PadTest V6 residual, relErr 3.02%): the datum plane may
              // be TILTED relative to the extrude direction (Pad001: datum
              // normal (−0.038·…) not parallel to the sketch normal). A fixed
              // length `signed` gives a FLAT top; FreeCAD's Pad reaches the
              // PLANE, producing a slanted top (truth AddShape 4860.42 vs flat
              // disc 1874.83). Emit an explicit plane target instead and let
              // the kernel's half-space intersection produce the slanted cut.
              // The extrude runs in sketch-local coords, so transform the
              // global plane into the sketch frame: p_local = R⁻¹(p_g − sk.p),
              // n_local = R⁻¹(n_g) (R⁻¹ = Rᵀ).
              const inv = [0, 1, 2].map((c) => [
                skM[c]!, skM[3 + c]!, skM[6 + c]!,
              ]);
              const d = [
                pl.p[0] - skPl.p[0], pl.p[1] - skPl.p[1], pl.p[2] - skPl.p[2],
              ] as [number, number, number];
              const ptLocal: [number, number, number] = [
                inv[0]![0]! * d[0] + inv[0]![1]! * d[1] + inv[0]![2]! * d[2],
                inv[1]![0]! * d[0] + inv[1]![1]! * d[1] + inv[1]![2]! * d[2],
                inv[2]![0]! * d[0] + inv[2]![1]! * d[1] + inv[2]![2]! * d[2],
              ];
              const nLocal: [number, number, number] = [
                inv[0]![0]! * normal[0] + inv[0]![1]! * normal[1] + inv[0]![2]! * normal[2],
                inv[1]![0]! * normal[0] + inv[1]![1]! * normal[1] + inv[1]![2]! * normal[2],
                inv[2]![0]! * normal[0] + inv[2]![1]! * normal[1] + inv[2]![2]! * normal[2],
              ];
              return {
                kind: 'translated',
                reason: 'uptoface-via-datum-plane-distance',
                calls: [{
                  out, op: 'cad.extrude', source: obj.name, inputs: [profileVar],
                  params: { upTo: { plane: { point: ptLocal, normal: nLocal } } },
                }],
              };
            }
            return { kind: 'baked', reason: 'uptoface-datum-plane-degenerate-distance' };
          }
          // C2.2 (extrude-upto-face §4.3-C2 point 2): solid-feature target →
          // reference its face by ordinal via `cad.extrude({ upTo:
          // cad.faceRef(targetVar, N) })`. faceRef's ordinal is calibrated to
          // match FreeCAD's `FaceN` (R-A, same TopExp::MapShapes + IndexedMap
          // enumeration as edgeRef); the runtime naming layer resolves the ref
          // against the live target shape, so it enters the IR as a JsExpr.
          if (target) {
            const targetVar = inputVar(upTo.obj);
            if (targetVar) {
              const faceN = parseFaceSub(upTo.subs);
              if (faceN !== undefined) {
                return {
                  kind: 'translated',
                  reason: 'uptoface-via-faceRef',
                  calls: [{
                    out, op: 'cad.extrude', source: obj.name, inputs: [profileVar],
                    params: { upTo: jsExpr(`cad.faceRef(${targetVar}, ${faceN})`) },
                  }],
                };
              }
              // sub present but not a plain FaceN reference → explicit bake
              return { kind: 'baked', reason: 'uptoface-sub-unparseable' };
            }
          }
        }
        return { kind: 'baked', reason: 'uptoface-solid-face-unsupported' };
      }
      if (ftype === 'UpToLast' || ftype === 'UpToFirst') {
        // plan §4.3-C2: UpToLast/UpToFirst extrude to the far/near face of the
        // support (BaseFeature) via `cad.extrude({ upTo: 'last' | 'first' })`
        // (up-to lives on the platform op cad.extrude, never on fai_extrude).
        // The kernel up-to does the truncation; baseFeature must be resolvable
        // or we bake explicitly — no silent bbox-derived length guess.
        const base = propLink(obj, 'BaseFeature');
        const baseVar = base ? inputVar(base) : undefined;
        if (!baseVar) return { kind: 'baked', reason: 'pad-upTo-missing-base' };
        const upTo = ftype === 'UpToLast' ? 'last' : 'first';
        return {
          kind: 'translated',
          reason: `pad-${ftype}-via-baseFeature`,
          calls: [{
            out, op: 'cad.extrude', source: obj.name, inputs: [profileVar],
            params: { upTo, baseFeature: jsExpr(baseVar) },
          }],
        };
      }
      if (ftype !== 'Length') {
        // anything still non-Length (e.g. 'unknown') → explicit bake, never guess
        return { kind: 'baked', reason: `pad-type-${ftype}-unsupported` };
      }
      // cad.extrude extrudes the sketch face into a prism along +Z (the sketch
      // normal in body-local frame); length sign encodes direction.
      if (midplane) {
        // symmetric about the sketch plane: two half-prisms fused
        const half = symDiv(lenSym ?? { value: 0 }, 2);
        const pos = `${out}__pos`;
        const neg = `${out}__neg`;
        const calls: CadCall[] = [
          { out: pos, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, emitScalar(half)]], params: {} },
          { out: neg, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, emitScalar(symNeg(half))]], params: {} },
          { out, op: 'cad.union', source: obj.name, inputs: [pos, neg], params: {} },
        ];
        return { kind: 'translated', calls };
      }
      const signed = emitScalar(reversed ? symNeg(lenSym ?? { value: 0 }) : (lenSym ?? { value: 0 }));
      return {
        kind: 'translated',
        calls: [{ out, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, signed]], params: {} }],
      };
    }
    case 'PartDesign::Pocket': {
      const profile = profileLink(obj);
      const lenSym = propScalar(obj, 'Length');
      const reversed = propBool(obj, 'Reversed');
      const midplane = propBool(obj, 'Midplane');
      const base = propLink(obj, 'BaseFeature');
      const profileVar = profile ? inputVar(profile) : undefined;
      // GOTCHA (hole_puzzle corpus, 2026-09-20): FreeCAD 0.20+ PartDesign
      // files routinely OMIT BaseFeature on interior features — the base is
      // implied by the Body's feature order (chain head). A MISSING property
      // is "no explicit base" → emit the subtract with the BODY_CHAIN_BASE
      // marker; codegen retargets it at the chain head when folding. Only an
      // EXPLICIT base that fails to resolve is a dependency gap.
      const baseVar = base ? inputVar(base) : BODY_CHAIN_BASE;
      if (!profileVar || !baseVar) return { kind: 'baked', reason: 'pocket-missing-dependency' };
      if (!lenSym && hasNonConstantBinding(obj, 'Length')) {
        return { kind: 'baked', reason: 'pocket-length-expression-non-constant' };
      }
      // M9.1/M9.2/M9.3: Type-driven semantics — explicit bake for anything
      // beyond the supported set (no silent downgrade).
      const ftype = featureTypeOf(obj, 'pocket');
      if (ftype === 'UpToFace') {
        // C2.3 (extrude-upto-face §4.3-C2 point 4): Pocket UpToFace — same
        // datum-plane path as Pad (plane target in sketch-local frame); the
        // cut direction is handled by the kernel's auto-orientation toward
        // the plane (GOTCHA: Pocket cuts INTO the material, the plane lies
        // on the far side, and the kernel flips the extrude direction).
        const upTo = propLinkSub(obj, 'UpToFace');
        if (upTo && docObjects) {
          const target = docObjects.find((o) => o.name === upTo.obj);
          if (target && target.type === 'PartDesign::Plane') {
            const pl = placementOf(target);
            const m = quatToMatrix(pl.q);
            const normal: [number, number, number] = [m[2]!, m[5]!, m[8]!];
            const skPl = placementOf(docObjects.find((o) => o.name === (profile ?? '')) ?? target);
            const skM = quatToMatrix(skPl.q);
            const dir: [number, number, number] = [skM[2]!, skM[5]!, skM[8]!];
            const denom = dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2];
            if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) {
              return { kind: 'baked', reason: 'pocket-uptoface-datum-plane-parallel' };
            }
            // plane → sketch-local frame (p_local = R⁻¹(p_g − sk.p), n_local = R⁻¹ n)
            const inv = [0, 1, 2].map((c) => [skM[c]!, skM[3 + c]!, skM[6 + c]!]);
            const d = [pl.p[0] - skPl.p[0], pl.p[1] - skPl.p[1], pl.p[2] - skPl.p[2]] as [number, number, number];
            const ptLocal: [number, number, number] = [
              inv[0]![0]! * d[0] + inv[0]![1]! * d[1] + inv[0]![2]! * d[2],
              inv[1]![0]! * d[0] + inv[1]![1]! * d[1] + inv[1]![2]! * d[2],
              inv[2]![0]! * d[0] + inv[2]![1]! * d[1] + inv[2]![2]! * d[2],
            ];
            const nLocal: [number, number, number] = [
              inv[0]![0]! * normal[0] + inv[0]![1]! * normal[1] + inv[0]![2]! * normal[2],
              inv[1]![0]! * normal[0] + inv[1]![1]! * normal[1] + inv[1]![2]! * normal[2],
              inv[2]![0]! * normal[0] + inv[2]![1]! * normal[1] + inv[2]![2]! * normal[2],
            ];
            const cutVar = `${out}_cut`;
            const calls: CadCall[] = [
              {
                out: cutVar, op: 'cad.extrude', source: obj.name, inputs: [profileVar],
                params: { upTo: { plane: { point: ptLocal, normal: nLocal } } },
              },
              { out, op: 'cad.subtract', source: obj.name, inputs: [baseVar, cutVar], params: {} },
            ];
            return { kind: 'translated', reason: 'pocket-uptoface-via-datum-plane', calls };
          }
          return { kind: 'baked', reason: 'pocket-uptoface-solid-face-unsupported' };
        }
        return { kind: 'baked', reason: 'pocket-uptoface-sub-unparseable' };
      }
      if (ftype === 'UpToFirst') {
        // C2.3: Pocket UpToFirst — cut prism to the support's NEAR face along
        // the cut direction; the kernel truncates the prism against the
        // baseFeature (chain head), then the result is subtracted.
        const baseVarUp = baseVar;
        const cutVar = `${out}_cut`;
        const calls: CadCall[] = [
          {
            out: cutVar, op: 'cad.extrude', source: obj.name, inputs: [profileVar],
            params: { upTo: 'first', baseFeature: jsExpr(baseVarUp) },
          },
          { out, op: 'cad.subtract', source: obj.name, inputs: [baseVarUp, cutVar], params: {} },
        ];
        return { kind: 'translated', reason: 'pocket-uptofirst-via-baseFeature', calls };
      }
      if (ftype !== 'Length' && ftype !== 'TwoLengths' && ftype !== 'ThroughAll') {
        return { kind: 'baked', reason: `pocket-type-${ftype}-unsupported` };
      }
      // P1-1b (2026-09-23): Pocket Midplane — symmetric cut prism about the
      // sketch plane (same construction as the Pad midplane branch: two
      // half-prisms fused, then subtracted). Direction sign is irrelevant
      // (symmetric); ThroughAll keeps its far-beyond-extent depth.
      if (midplane) {
        const THROUGH_ALL_DEPTH = 1e6;
        const depthSym = ftype === 'ThroughAll' ? { value: THROUGH_ALL_DEPTH } : (lenSym ?? { value: 0 });
        const half = symDiv(depthSym, 2);
        const pos = `${out}_cut_pos`;
        const neg = `${out}_cut_neg`;
        const cutVar = `${out}_cut`;
        const calls: CadCall[] = [
          { out: pos, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, emitScalar(half)]], params: {} },
          { out: neg, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, emitScalar(symNeg(half))]], params: {} },
          { out: cutVar, op: 'cad.union', source: obj.name, inputs: [pos, neg], params: {} },
          { out, op: 'cad.subtract', source: obj.name, inputs: [baseVar, cutVar], params: {} },
        ];
        return { kind: 'translated', calls };
      }
      // Pocket cuts INTO the material: extrude the profile opposite the normal
      // (or along it when Reversed), then subtract from base.
      // ThroughAll (hole_puzzle corpus, 2026-09-20): FreeCAD truncates the
      // prism against the base solid, so a depth far beyond any realistic
      // base extent is safe — the subtract is exact either way.
      const THROUGH_ALL_DEPTH = 1e6;
      const depthSym = ftype === 'ThroughAll' ? { value: THROUGH_ALL_DEPTH } : (lenSym ?? { value: 0 });
      // C3: a Length bound to lifted parameters stays symbolic; ThroughAll is a
      // constant by construction, so only the Length branch ever carries `expr`.
      const signed = emitScalar(reversed ? depthSym : symNeg(depthSym));
      const cutVar = `${out}_cut`;
      const calls: CadCall[] = [{
        out: cutVar, op: 'cad.extrude', source: obj.name, inputs: [profileVar], literals: [[0, 0, signed]], params: {},
      }];
      calls.push({ out, op: 'cad.subtract', source: obj.name, inputs: [baseVar, cutVar], params: {} });
      return { kind: 'translated', calls };
    }
    case 'Part::Extrusion': {
      const base = propLink(obj, 'Base');
      const baseVar = base ? inputVar(base) : undefined;
      if (!baseVar) return { kind: 'baked', reason: 'extrusion-missing-base' };
      const dir = propVecXYZ(obj, 'Dir') ?? propVec(obj, 'Dir') ?? [0, 0, 1];
      // FreeCAD 0.20+ serializes the flag as `Reversed`; older files used
      // `Reverse`. Accept both.
      const reversed = propBool(obj, 'Reversed') || propBool(obj, 'Reverse');
      // W2 (2026-09-27, Shutter Double doors): `Part::Extrusion` extrudes a
      // GLOBAL `Dir` against a profile that codegen emits in the SKETCH-LOCAL
      // frame (M8.3 — `cad.profile` lays the face on the sketch's own plane,
      // the result is re-placed afterwards). When the base sketch carries a
      // rotated Placement, the global Dir must be rotated INTO that local
      // frame (Rᵀ·dir) before extruding, or the sweep direction lies IN the
      // profile plane → zero-area degenerate solid (sketch on XZ: Q=(0,.7071,0,
      // .7071), Dir=(0,-10,0) → all faces at z≈0, volume 0). Non-sketch bases
      // (solids) are already in the global frame — leave them untouched.
      // codegen's M8.3 placement step resolves the sketch via the SAME `Base`
      // link (see its baseLinkResolution note) and re-places the result.
      let effDir = dir;
      if (docObjects && base) {
        const baseObj = docObjects.find((o) => o.name === base);
        if (baseObj?.type === 'Sketcher::SketchObject') {
          const skPl = placementOf(baseObj);
          if (!isIdentityPlacement(skPl)) {
            const m = quatToMatrix(skPl.q);
            // Rᵀ (inverse rotation): global dir → sketch-local dir
            effDir = [
              m[0]! * dir[0]! + m[3]! * dir[1]! + m[6]! * dir[2]!,
              m[1]! * dir[0]! + m[4]! * dir[1]! + m[7]! * dir[2]!,
              m[2]! * dir[0]! + m[5]! * dir[1]! + m[8]! * dir[2]!,
            ];
          }
        }
      }
      // E4 (2026-09-23): Part::Extrusion serializes in three shapes. New
      // format: LengthFwd/LengthRev (unit Dir). Old format: only Dir, whose
      // magnitude IS the extrusion length. Legacy: Length + Dir. The previous
      // code only knew the legacy shape → len=0 → E_EXTRUDE_ZERO_VECTOR on
      // 918 corpus runs.
      const lengthFwd = propNum(obj, 'LengthFwd');
      const lengthRev = propNum(obj, 'LengthRev');
      const taperAngle = propNum(obj, 'TaperAngle') ?? 0;
      if (taperAngle !== 0) {
        // No-heuristic-fallback: silently ignoring a taper would produce wrong
        // geometry. Bake with an explicit reason instead.
        return { kind: 'baked', reason: 'extrusion-taper-unsupported' };
      }
      const unitDir = normalize3(effDir);
      const calls: CadCall[] = [];
      const emitExtrude = (outName: string, fwdLen: number, revLen: number) => {
        if (fwdLen > 0) {
          calls.push({
            out: revLen > 0 ? `${outName}_fwd` : outName,
            op: 'cad.extrude', source: obj.name, inputs: [baseVar],
            literals: [[unitDir[0] * fwdLen, unitDir[1] * fwdLen, unitDir[2] * fwdLen]], params: {},
          });
        }
        if (revLen > 0) {
          // `|| 0` normalizes -0 to +0 (JSON/对拍 noise otherwise).
          calls.push({
            out: fwdLen > 0 ? `${outName}_rev` : outName,
            op: 'cad.extrude', source: obj.name, inputs: [baseVar],
            literals: [[(-unitDir[0] * revLen) || 0, (-unitDir[1] * revLen) || 0, (-unitDir[2] * revLen) || 0]], params: {},
          });
        }
      };
      if (lengthFwd !== undefined || lengthRev !== undefined) {
        const symmetric = propBool(obj, 'Symmetric');
        const fwd = lengthFwd ?? 0;
        const revRaw = lengthRev ?? 0;
        // FreeCAD semantics: Symmetric extrudes LengthFwd on BOTH sides;
        // Reversed swaps the fwd/rev sides (same magnitudes).
        const fwdLen = symmetric ? fwd : (reversed ? revRaw : fwd);
        const revLen = symmetric ? fwd : (reversed ? fwd : revRaw);
        if (fwdLen > 0 && revLen > 0) {
          emitExtrude(out, fwdLen, revLen);
          calls.push({ out, op: 'cad.union', source: obj.name, inputs: [`${out}_fwd`, `${out}_rev`], params: {} });
        } else {
          emitExtrude(out, fwdLen, revLen);
        }
        if (calls.length === 0) return { kind: 'baked', reason: 'extrusion-zero-length' };
        return { kind: 'translated', calls };
      }
      const legacyLen = propNum(obj, 'Length');
      if (legacyLen !== undefined) {
        // Legacy shape: Length + unit Dir.
        const s = reversed ? -1 : 1;
        return {
          kind: 'translated',
          calls: [{
            out, op: 'cad.extrude', source: obj.name, inputs: [baseVar],
            literals: [[s * effDir[0]! * legacyLen, s * effDir[1]! * legacyLen, s * effDir[2]! * legacyLen]], params: {},
          }],
        };
      }
      // Old format: |Dir| IS the extrusion length; Dir is the vector.
      const mag = Math.hypot(effDir[0], effDir[1], effDir[2]);
      if (mag <= 0) return { kind: 'baked', reason: 'extrusion-zero-length' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.extrude', source: obj.name, inputs: [baseVar],
          literals: [reversed ? [-effDir[0], -effDir[1], -effDir[2]] : effDir], params: {},
        }],
      };
    }
    case 'Part::Revolution': {
      // P6: Part-workbench revolve — Source profile + axis given DIRECTLY as
      // Base/Axis PropertyVector (GOTCHA: valueX/Y/Z child-element form, NOT
      // the value="x y z" attribute form propVec reads; PartDesign::Revolution
      // instead stores a ReferenceAxis string — different serialization, so
      // this is a separate branch, not a shared one).
      const revSrc = propLink(obj, 'Source');
      const revVar = revSrc ? inputVar(revSrc) : undefined;
      if (!revVar) {
        return { kind: 'baked', reason: revSrc ? `part-revolution-source-baked-upstream:${revSrc}` : 'part-revolution-missing-source' };
      }
      const axisRaw = propVecXYZ(obj, 'Axis');
      if (!axisRaw || Math.hypot(...axisRaw) <= 0) {
        return { kind: 'baked', reason: 'part-revolution-missing-axis' };
      }
      const axis = normalize3(axisRaw);
      const base = propVecXYZ(obj, 'Base') ?? [0, 0, 0];
      const [rpx, rpy, rpz] = placementPos(obj);
      const at = [base[0]! + rpx, base[1]! + rpy, base[2]! + rpz] as [number, number, number];
      const revAngleDeg = propNum(obj, 'Angle') ?? 360;
      if (revAngleDeg <= 0 || revAngleDeg > 360) {
        return { kind: 'baked', reason: 'part-revolution-angle-out-of-range' };
      }
      const revAngle = (revAngleDeg * Math.PI) / 180;
      if (propStr(obj, 'Symmetric') === 'true') {
        return { kind: 'baked', reason: 'part-revolution-symmetric-unsupported' };
      }
      return {
        kind: 'translated',
        calls: [{
          // GOTCHA (2026-09-25, A3 revolve REVOLVE_FAILED): same root cause as
          // the mirror branch — `cad.revolve(input, { axis, at, angle })` takes
          // the source shape as a POSITIONAL arg. `noPositionalArgs: true` made
          // renderArgs drop `inputs[0]`, emitting `cad.revolve({ axis, at, angle })`
          // with no geometry → REVOLVE_FAILED at run.
          out, op: 'cad.revolve', source: obj.name, inputs: [revVar],
          params: { axis, at, angle: revAngle },
        }],
      };
    }
    case 'PartDesign::Revolution': {
      const profile = profileLink(obj);
      const profileVar = profile ? inputVar(profile) : undefined;
      if (!profileVar) {
        // P2-1 (2026-09-24, Mannequin_mp): a `revolution-missing-profile`
        // cascade lie — 13 Revolutions had a VALID Profile link (e.g.
        // Revolution033 → Sketch061) whose target sketch was baked upstream
        // (unsupported-geometry), so inputVar resolved undefined. Distinguish
        // "no link at all" from "link exists but upstream not translated".
        return { kind: 'baked', reason: profile ? `revolution-profile-baked-upstream:${profile}` : 'revolution-missing-profile' };
      }
      const angleDeg = propNum(obj, 'Angle') ?? 360;
      const angle = (angleDeg * Math.PI) / 180;
      // ReferenceAxis is a LinkSub: the axis name (H_Axis/V_Axis/EdgeN…) is the
      // <Sub> child, not the value attribute (which names the linked sketch).
      const axisInfo = resolveAxisRef(obj, 'ReferenceAxis');
      if (!axisInfo) return { kind: 'baked', reason: 'revolution-edge-axis-unsupported' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.revolve', source: obj.name, inputs: [profileVar],
          params: { axis: axisInfo.axis, at: axisInfo.at, angle },
        }],
      };
    }
    case 'PartDesign::Groove': {
      // P2-2 (2026-09-24): Groove = Revolution + subtract — revolve the
      // profile around the axis, then cut it from the base feature. Same
      // Profile/ReferenceAxis/Angle serialization as Revolution.
      const grooveProfile = profileLink(obj);
      const grooveProfileVar = grooveProfile ? inputVar(grooveProfile) : undefined;
      if (!grooveProfileVar) {
        return {
          kind: 'baked',
          reason: grooveProfile ? `groove-profile-baked-upstream:${grooveProfile}` : 'groove-missing-profile',
        };
      }
      const baseVar = inputVar(propLink(obj, 'BaseFeature') ?? '');
      if (!baseVar) return { kind: 'baked', reason: 'groove-missing-base' };
      const gAngleDeg = propNum(obj, 'Angle') ?? 360;
      const gAngle = (gAngleDeg * Math.PI) / 180;
      const gAxis = resolveAxisRef(obj, 'ReferenceAxis');
      if (!gAxis) return { kind: 'baked', reason: 'groove-edge-axis-unsupported' };
      const grooveVar = `${out}_groove`;
      return {
        kind: 'translated',
        calls: [
          {
            out: grooveVar, op: 'cad.revolve', source: obj.name, inputs: [grooveProfileVar],
            params: { axis: gAxis.axis, at: gAxis.at, angle: gAngle },
          },
          { out, op: 'cad.subtract', source: obj.name, inputs: [baseVar, grooveVar], params: {} },
        ],
      };
    }
    case 'PartDesign::LinearPattern': {
      // P3-1 (2026-09-23): FreeCAD serializes Transformed features with the
      // patterned features in `Originals` (PropertyLinkList); `Source` only
      // exists on some versions. Read Source first, then fall back to
      // Originals[0] (multi-original → fuse the patterned copies below).
      const source = propLink(obj, 'Source') ?? propLinkList(obj, 'Originals')[0];
      const originals = source ? [source] : [];
      const sourceVar = originals.length > 0 ? inputVar(originals[0]!) : undefined;
      // P1.5 (2026-09-28, DIP 28 corpus): Transformed features sometimes
      // serialize NEITHER Source NOR Originals (LinkList count=0) — the
      // patterned feature is implied and unrecoverable from Document.xml.
      // The pattern still carries its frozen result Shape: shape-asset
      // fallback keeps the chain alive (D8: honest fact, no fake pattern).
      if (!sourceVar) {
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: linear-pattern-missing-source fallback',
          };
        }
        return { kind: 'baked', reason: 'linear-pattern-missing-source' };
      }
      const dirInfo = resolveAxisRef(obj, 'Direction');
      if (!dirInfo) return { kind: 'baked', reason: 'linear-pattern-edge-dir-unsupported' };
      const occ = Math.max(2, Math.round(propNum(obj, 'Occurrences') ?? 2));
      const length = propNum(obj, 'Length') ?? 0;
      const spacing = occ > 1 ? length / (occ - 1) : 0;
      if (originals.length === 1) {
        return {
          kind: 'translated',
          calls: [{
            out, op: 'cad.linearPattern', source: obj.name, inputs: [sourceVar],
            literals: [dirInfo.axis, occ, spacing], params: {},
          }],
        };
      }
      // Multi-original: pattern each, then fuse.
      const calls: CadCall[] = originals.map((o, i) => {
        const v = inputVar(o);
        if (!v) return null;
        return {
          out: i === 0 ? `${out}_p0` : `${out}_p${i}`, op: 'cad.linearPattern', source: obj.name, inputs: [v],
          literals: [dirInfo.axis, occ, spacing], params: {},
        } as CadCall;
      }).filter((c): c is CadCall => c !== null);
      for (let i = 1; i < calls.length; i++) {
        calls.push({
          out: i === calls.length - 1 ? out : `${out}_u${i}`,
          op: 'cad.union', source: obj.name,
          inputs: [i === 1 ? calls[0]!.out : `${out}_u${i - 1}`, calls[i]!.out], params: {},
        });
      }
      return { kind: 'translated', calls };
    }
    case 'PartDesign::PolarPattern': {
      const sourcePolar = propLink(obj, 'Source') ?? propLinkList(obj, 'Originals')[0];
      const sourceVar = sourcePolar ? inputVar(sourcePolar) : undefined;
      // P1.5 (2026-09-28): same empty-Originals / frozen-result fallback as
      // the LinearPattern branch above.
      if (!sourceVar) {
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: polar-pattern-missing-source fallback',
          };
        }
        return { kind: 'baked', reason: 'polar-pattern-missing-source' };
      }
      const axisInfo = resolveAxisRef(obj, 'Axis');
      if (!axisInfo) return { kind: 'baked', reason: 'polar-pattern-edge-axis-unsupported' };
      const occ = Math.max(2, Math.round(propNum(obj, 'Occurrences') ?? 2));
      const angle = propNum(obj, 'Angle') ?? 360;
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.circularPattern', source: obj.name, inputs: [sourceVar],
          literals: [axisInfo.axis, occ, angle], params: {},
        }],
      };
    }
    case 'PartDesign::Fillet': {
      const base = propLinkSub(obj, 'Base');
      const baseVar = base ? inputVar(base.obj) : undefined;
      if (!baseVar) return { kind: 'baked', reason: 'fillet-missing-base' };
      if (propBool(obj, 'UseAllEdges')) return { kind: 'baked', reason: 'fillet-all-edges-unsupported' };
      if (!base || base.subs.length === 0) return { kind: 'baked', reason: 'fillet-no-edges' };
      const ordinals = parseEdgeSubs(base.subs);
      // P1.4 (2026-09-28, Shopping Handle corpus): FreeCAD PartDesign fillets
      // may select FACES (`Face57`) — "fillet every edge of this face". cad.fillet
      // takes explicit edge ordinals and post-fillet ordinals shift, so face
      // selection cannot be emitted faithfully. The feature still carries its
      // frozen result Shape (.brp member): importing it as a shape-asset is an
      // honest fact (D8), keeps downstream Base chains alive, and beats baking
      // the whole downstream fillet stack with fillet-missing-base.
      if (!ordinals) {
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: fillet-non-edge-sub fallback',
          };
        }
        return { kind: 'baked', reason: 'fillet-non-edge-sub' };
      }
      const radius = propNum(obj, 'Radius');
      if (radius === undefined || !(radius > 0)) return { kind: 'baked', reason: 'fillet-bad-radius' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.fillet', source: obj.name, inputs: [baseVar],
          params: { edges: edgeRefArgs(baseVar, ordinals), radius },
        }],
      };
    }
    case 'PartDesign::Chamfer': {
      const base = propLinkSub(obj, 'Base');
      const baseVar = base ? inputVar(base.obj) : undefined;
      if (!baseVar) return { kind: 'baked', reason: 'chamfer-missing-base' };
      if (propBool(obj, 'UseAllEdges')) return { kind: 'baked', reason: 'chamfer-all-edges-unsupported' };
      if (!base || base.subs.length === 0) return { kind: 'baked', reason: 'chamfer-no-edges' };
      const ordinals = parseEdgeSubs(base.subs);
      // P1.4 (2026-09-28): same face-selection / frozen-result fallback as the
      // PartDesign::Fillet branch above.
      if (!ordinals) {
        if (shapeCarriers?.has(obj.name)) {
          return {
            kind: 'translated',
            calls: [shapeAssetCall(obj, shapeBrpFile(obj) ?? `${obj.name}.Shape.brp`)],
            reason: 'shape-asset: chamfer-non-edge-sub fallback',
          };
        }
        return { kind: 'baked', reason: 'chamfer-non-edge-sub' };
      }
      const edges = edgeRefArgs(baseVar, ordinals);
      // ChamferType enum (FeatureChamfer.cpp:55): 0 "Equal distance" (the
      // default when the property is absent, i.e. files predating it),
      // 1 "Two distances", 2 "Distance and Angle".
      const type = Math.round(propNum(obj, 'ChamferType') ?? 0);
      const size = propNum(obj, 'Size');
      if (type === 1) {
        const size2 = propNum(obj, 'Size2');
        if (size === undefined || !(size > 0) || size2 === undefined || !(size2 > 0)) {
          return { kind: 'baked', reason: 'chamfer-bad-two-distances' };
        }
        return {
          kind: 'translated',
          calls: [{
            out, op: 'cad.chamfer', source: obj.name, inputs: [baseVar],
            params: { edges, type: 'twoDistances', width1: size, width2: size2 },
          }],
        };
      }
      if (type === 2) {
        // FreeCAD's Angle is degrees, range 0–180 (floatAngle); cad.chamfer
        // accepts degrees in the open interval (0, 90) only.
        const angle = propNum(obj, 'Angle');
        if (size === undefined || !(size > 0) || angle === undefined || !(angle > 0 && angle < 90)) {
          return { kind: 'baked', reason: 'chamfer-bad-distance-angle' };
        }
        return {
          kind: 'translated',
          calls: [{
            out, op: 'cad.chamfer', source: obj.name, inputs: [baseVar],
            params: { edges, type: 'distanceAngle', width: size, angle },
          }],
        };
      }
      if (type !== 0) return { kind: 'baked', reason: `chamfer-unknown-type: ${type}` };
      if (size === undefined || !(size > 0)) return { kind: 'baked', reason: 'chamfer-bad-size' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.chamfer', source: obj.name, inputs: [baseVar],
          params: { edges, type: 'equal', width: size },
        }],
      };
    }
    case 'Part::Chamfer': {
      // P8: Part-workbench chamfer. GOTCHA: edge selection AND sizes do NOT
      // live in Document.xml — the `Edges` property points at a binary
      // PropertyFilletEdges ZIP member (parsed by convert, passed in via
      // filletEdgesData). XML-only reading yields no size at all.
      const chBase = propLink(obj, 'Base');
      const chBaseVar = chBase ? inputVar(chBase) : undefined;
      if (!chBaseVar) return { kind: 'baked', reason: 'chamfer-missing-base' };
      const chEntries = filletEdgesData?.get(obj.name);
      if (!chEntries || chEntries.length === 0) {
        return { kind: 'baked', reason: 'chamfer-edges-data-missing' };
      }
      // cad.chamfer 'equal' takes ONE width for ALL edges. Mixed sizes across
      // edges cannot be emitted as sequential calls either: after the first
      // chamfer the shape's edge ordinals shift, so the second call's
      // EdgeN refs would point at the wrong edges (corpus: 1/109 objects).
      const chSizes = new Set(chEntries.map((e) => e.size1));
      if (chSizes.size > 1) return { kind: 'baked', reason: 'chamfer-mixed-sizes' };
      // Asymmetric size1 != size2 (two-distance chamfer): 0 corpus
      // occurrences; the Size1/Size2 face-side correspondence to
      // cad.chamfer twoDistances width1/width2 is unverified — honest bake.
      if (chEntries.some((e) => e.size1 !== e.size2)) {
        return { kind: 'baked', reason: 'chamfer-asymmetric-sizes' };
      }
      const chSize = chEntries[0]!.size1;
      if (!(chSize > 0)) return { kind: 'baked', reason: 'chamfer-bad-size' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.chamfer', source: obj.name, inputs: [chBaseVar],
        params: { edges: edgeRefArgs(chBaseVar, chEntries.map((e) => e.edge)), type: 'equal', width: chSize },
      }],
    };
  }
    case 'Part::Fillet': {
      // P9: Part-workbench fillet. Same binary PropertyFilletEdges member as
      // Part::Chamfer (parsed by convert, passed in via filletEdgesData). The
      // radius lives ONLY in that binary member — Document.xml carries no
      // usable radius.
      const fBase = propLink(obj, 'Base');
      const fBaseVar = fBase ? inputVar(fBase) : undefined;
      if (!fBaseVar) return { kind: 'baked', reason: 'fillet-missing-base' };
      const fEntries = filletEdgesData?.get(obj.name);
      if (!fEntries || fEntries.length === 0) {
        return { kind: 'baked', reason: 'fillet-edges-data-missing' };
      }
      // cad.fillet (M1) supports ONE uniform radius for all edges. A constant
      // fillet stores radius in both size1 and size2; anything else (size1 !=
      // size2, or differing radius across edges) is a variable-radius fillet
      // that M1 cannot emit as a single call — and sequential calls would shift
      // edge ordinals (same hazard as chamfer). Honest bake, no silent loss.
      if (fEntries.some((e) => e.size1 !== e.size2)) {
        return { kind: 'baked', reason: 'fillet-asymmetric-sizes' };
      }
      const fRadii = new Set(fEntries.map((e) => e.size1));
      if (fRadii.size > 1) return { kind: 'baked', reason: 'fillet-variable-radius' };
      const fRadius = fEntries[0]!.size1;
      if (!(fRadius > 0)) return { kind: 'baked', reason: 'fillet-bad-radius' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.fillet', source: obj.name, inputs: [fBaseVar],
          params: { edges: edgeRefArgs(fBaseVar, fEntries.map((e) => e.edge)), radius: fRadius },
        }],
      };
    }
    case 'Part::Sweep': {
      // P2-3: FreeCAD Part::Sweep → cad.sweep(profile, spine, opts).
      // Real FCStd (corpus-verified 2026-09-24): the section is carried in
      // `Sections` (App::PropertyLinkList, usually length 1) — NOT `Profile`,
      // which is absent in the corpus. We accept either, preferring the
      // standard `Profile` and falling back to `Sections[0]`.
      // The path is `Spine` (App::PropertyLinkSub): { obj: sketch, subs: edges }.
      // We pass the base object as the spine; cad.sweep now tolerates a face
      // argument and takes its outer-ring wire as the path (api/sweep.ts
      // toProfileWireView), which is exact for the dominant case where the
      // selected sub-edges ARE the full outline. Multi-edge sub-path selection
      // that is a strict subset is a P4-1 refinement (curve/attachment).
      // Mode: Frenet (0, default) / Binormal (1) / Auxiliary (2). Auxiliary
      // needs a second supporting spine we do not carry → honest bake. Check
      // this BEFORE dependency resolution: an unsupported mode is a property of
      // this object alone, independent of whether its profile/spine resolved
      // (cf. the "Auxiliary mode" test where inputVar is stubbed away).
      const modeRaw = propStr(obj, 'Mode');
      if (modeRaw === 'Auxiliary' || modeRaw === '2') {
        return { kind: 'baked', reason: 'sweep-auxiliary-unsupported' };
      }
      const sweepProfile = propLink(obj, 'Profile') ?? propLinkList(obj, 'Sections')[0];
      const sweepSpineSub = propLinkSub(obj, 'Spine');
      const sweepSpine = sweepSpineSub?.obj;
      const profileVar = sweepProfile ? inputVar(sweepProfile) : undefined;
      const spineVar = sweepSpine ? inputVar(sweepSpine) : undefined;
      if (!profileVar) {
        return { kind: 'baked', reason: sweepProfile ? `sweep-profile-baked-upstream:${sweepProfile}` : 'sweep-missing-profile' };
      }
      if (!spineVar) {
        return { kind: 'baked', reason: sweepSpine ? `sweep-spine-baked-upstream:${sweepSpine}` : 'sweep-missing-spine' };
      }
      const frenet = modeRaw === undefined || modeRaw === 'Frenet' || modeRaw === '0' || propBool(obj, 'Frenet');
      const transition = normalizeSweepTransition(propStr(obj, 'Transition'));
      const opts: Record<string, unknown> = {};
      if (frenet) opts.frenet = true;
      if (transition) opts.transitionMode = transition;
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.sweep', source: obj.name, inputs: [profileVar, spineVar], params: opts,
        }],
      };
    }
    case 'Part::Loft': {
      // P2-3: FreeCAD Part::Loft → cad.loft([sections], opts). `Sections` is a
      // PropertyLinkList of already-translated profile faces/wires; cad.loft
      // adapts each face → outer-ring wire (api/loft.ts toProfileWireView).
      const sections = propLinkList(obj, 'Sections');
      // Closed loft needs a `closed` option cad.loft does not expose → honest
      // bake. Check this BEFORE dependency resolution: an unsupported option is
      // a property of this object alone, independent of whether its sections
      // resolved (cf. the "Closed=true" test where inputVar is stubbed away).
      if (propBool(obj, 'Closed')) return { kind: 'baked', reason: 'loft-closed-unsupported' };
      const sectionVars = sections.map((s) => inputVar(s));
      if (sections.length < 2) {
        // Genuinely fewer than two profiles → not a loft, no upstream involvement.
        return { kind: 'baked', reason: 'loft-missing-sections' };
      }
      const missingIdx = sectionVars.findIndex((v) => v === undefined);
      if (missingIdx >= 0) {
        // A section resolved to an object that itself got baked upstream → we
        // cannot reconstruct its geometry here → honest bake with the culprit.
        return { kind: 'baked', reason: `loft-section-baked-upstream:${sections[missingIdx]}` };
      }
      const ruled = propBool(obj, 'Ruled'); // FC default true; emit only when false
      const params: Record<string, unknown> = {};
      if (ruled === false) params.ruled = false;
      // H14 (Beds, 2026-09-26): sketch sections are emitted as bare
      // `cad.profile` faces in sketch-LOCAL frame — codegen's M8.3 placement
      // step places only the FEATURE result (a Pad places its extrude by the
      // sketch's Placement), and a loft has NO single 'Sketch' property, so
      // nothing re-orients its sections. Each sketch section must be rigidly
      // placed by its OWN sketch Placement before skinning; otherwise every
      // section collapses onto the local XY plane and ThruSections yields a
      // degenerate zero-height "solid" (Beds s13/s25/s26/s32: 7 faces,
      // volume 0 → parity solids 10vs6, volume/area/com off). Non-sketch
      // sections (shape assets / features) are already placed by their own
      // emitting statement — leave them untouched (no double-place).
      const calls: CadCall[] = [];
      const placedVars = sectionVars.map((v, i) => {
        const sec = docObjects?.find((o) => o.name === sections[i]);
        if (!sec || sec.type !== 'Sketcher::SketchObject') return v!;
        const pl = placementOf(sec);
        if (isIdentityPlacement(pl)) return v!;
        const pv = `${out}__sec${i}`;
        calls.push({
          out: pv, op: 'cad.place', source: obj.name, inputs: [v!],
          params: { rotation: [...pl.q] as [number, number, number, number], position: [...pl.p] as [number, number, number] },
        });
        return pv;
      });
      // Sections rendered as a positional array literal. Remap-safe: inputVar
      // already returns the renamed var (deps are processed before dependents,
      // cf. the fillet edgeRefArgs JsExpr precedent).
      calls.push({
        out, op: 'cad.loft', source: obj.name, inputs: [],
        literals: [jsExpr(`[${placedVars.join(', ')}]`)], params,
      });
      return { kind: 'translated', calls };
    }
    case 'Part::Helix': {
      // P2-3: FreeCAD Part::Helix (3D curve primitive) → cad.helix({radius,pitch,turns}).
      // cad.helix yields a 1D curve usable as a sweep spine. FC Helix props:
      // Radius / Pitch / Height (+ optional Angle cone taper, Turns alias).
      // The object's own Placement is applied by codegen's normal cad.place step,
      // so we do NOT bake origin here (that would double-place).
      const hRadius = propNum(obj, 'Radius');
      const hPitch = propNum(obj, 'Pitch');
      const hHeight = propNum(obj, 'Height');
      const hTurns = propNum(obj, 'Turns');
      const hAngle = propNum(obj, 'Angle') ?? 0;
      if (!(hRadius !== undefined && hRadius > 0)) return { kind: 'baked', reason: 'helix-missing-radius' };
      if (!(hPitch !== undefined && hPitch !== 0)) return { kind: 'baked', reason: 'helix-missing-pitch' };
      // cad.helix is cylindrical; a cone-taper helix is unsupported → honest bake.
      if (hAngle !== 0) return { kind: 'baked', reason: 'helix-cone-unsupported' };
      const turns = hHeight !== undefined ? hHeight / hPitch : hTurns;
      if (!(turns !== undefined && turns > 0)) return { kind: 'baked', reason: 'helix-missing-turns' };
      return {
        kind: 'translated',
        calls: [{
          out, op: 'cad.helix', source: obj.name, inputs: [],
          params: { radius: hRadius, pitch: hPitch, turns },
        }],
      };
    }
    default:
      return { kind: 'baked', reason: `type-not-implemented: ${obj.type}` };
  }
}

function propLinkList(obj: FcstdObject, name: string): string[] {
  const listEl = obj.properties.get(name)?.children[0];
  if (!listEl) return [];
  const out: string[] = [];
  for (const link of listEl.children) {
    const v = link.attributes['value'];
    if (v) out.push(v);
  }
  return out;
}
