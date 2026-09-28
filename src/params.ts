/**
 * C1/C2/C4 (2026-09-28 plan §3 C 组) — leaf parameters lifted to faijs
 * top-level `const`s.
 *
 * Three sources are lifted, each a "leaf" the user can drive in FreeCAD and
 * therefore must stay editable in the produced `.fai.js`:
 *
 * | source | FCStd shape | emitted |
 * |---|---|---|
 * | `Spreadsheet::Sheet` | aliased `<Cell address alias content/>` | `const p_<alias> = <value>` |
 * | `App::VarSet` | plain numeric properties (`App::PropertyLength` …) | `const p_<prop> = <value>` |
 * | `Sketcher::SketchObject` | `<Constrain Name Type Value IsDriving/>` | `const p_<Sketch>_<Name> = <value>` |
 *
 * GOTCHA (2026-09-26, expressions-object-ref-gotcha): a VarSet variable is a
 * PLAIN property, not a spreadsheet cell — `spreadsheetAliasValue` only knows
 * `Spreadsheet::Sheet`, so VarSet reached the evaluator only after the B1 work
 * taught `docReferenceValue` about generic `Object.Property` refs.
 *
 * Naming (C4): every parameter is `p_`-prefixed (so it can never collide with a
 * translated object's variable name) and deduped with the same `_2`/`_3` suffix
 * scheme codegen's `emitVar` uses. The provenance of each parameter is carried
 * in {@link LeafParam.source} and lands in `mapping.json.params` so a UI can
 * list the drivable parameters.
 *
 * Values are the convert-time evaluation (one solve, plan §0.1): the emitted
 * `const` default reproduces the geometry the convert-time solve produced, and
 * changing the parameter at run time recomputes.
 */
import type { FcstdObject } from './document.js';
import { evalWithDoc, spreadsheetAliasValue, sheetCellElements, fcstdObjectLabel } from './expressions.js';
import { ConstraintType } from './sketch-parse.js';

/** One leaf parameter lifted into a faijs top-level `const`. */
export interface LeafParam {
  /** emitted identifier — `p_`-prefixed, deduped, valid in JS/Python/C/Java */
  name: string;
  /** convert-time evaluated default (written as the `const` right-hand side) */
  value: number;
  /** provenance for `mapping.json` (C4), e.g. `Spreadsheet::Sheet.Alias:Data.width` */
  source: string;
}

/** A named, driving, dimensional sketch constraint eligible for lifting (C2). */
export interface SketchConstraintParam {
  /** sketch object name (used in the emitted identifier and the reference key) */
  sketch: string;
  /** sketch Label when present — the alternate reference key FreeCAD uses */
  sketchLabel: string;
  /** the constraint's user-given `<Constrain Name=…>` */
  constraint: string;
  /** stored driving value */
  value: number;
}

/**
 * The leaf-parameter table for one document: the ordered `const` list plus a
 * reference index used to rewrite expression references (C3).
 */
export interface ParamTable {
  /** parameters in emission order (deterministic for a given document) */
  list: readonly LeafParam[];
  /**
   * Rewrite an expression reference to its parameter name, when that reference
   * is one of the lifted leaves. `(label, seg, sub)` mirrors the reference
   * shapes `evalWithDoc` parses: `<<L>>.Alias` / `L.Alias` → `(L, Alias, undefined)`;
   * `Sketch.Constraints.Name` → `(Sketch, 'Constraints', Name)`.
   *
   * @param label - the referenced object's Label or name.
   * @param seg - the second reference segment (alias / property / `Constraints`).
   * @param sub - the third segment for `Sketch.Constraints.<Name>`, else undefined.
   * @returns the parameter name, or undefined when the reference is not a leaf.
   */
  refName(label: string, seg: string, sub?: string): string | undefined;
}

/**
 * Constraint types carrying a driving scalar dimension (C2 scope: length /
 * distance / angle / radius / diameter). Pure geometric constraints
 * (coincident / horizontal / parallel / tangent / …) stay inside the
 * `cad.sketch` constraint array — they are not user-drivable parameters.
 */
const DIMENSIONAL_TYPES: ReadonlySet<number> = new Set<number>([
  ConstraintType.Distance,
  ConstraintType.DistanceX,
  ConstraintType.DistanceY,
  ConstraintType.Angle,
  ConstraintType.Radius,
  ConstraintType.Diameter,
]);

const RESERVED_JS_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'enum', 'await', 'static', 'implements', 'package', 'protected', 'interface',
  'private', 'public', 'arguments', 'eval', 'true', 'false', 'null', 'undefined',
  'NaN', 'Infinity',
]);

/**
 * Reuse of codegen's identifier rules — kept here so the parameter allocator
 * cannot drift from the variable allocator (both must produce names legal in
 * the four target languages, plan §2.6).
 * @param raw - the source alias / property / constraint name.
 * @returns a legal identifier body (the `p_` prefix is added by the caller).
 */
function sanitizeIdent(raw: string): string {
  let s = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  if (s.length === 0) s = '_';
  if (!/^[A-Za-z_$]/.test(s)) s = `_${s}`;
  if (RESERVED_JS_WORDS.has(s)) s = `${s}_`;
  return s;
}

/** `p_`-prefixed deduping allocator; suffix scheme mirrors codegen's `emitVar`. */
function makeParamNamer(): (raw: string) => string {
  const seen = new Set<string>();
  return (raw: string): string => {
    let name = `p_${sanitizeIdent(raw)}`;
    if (seen.has(name)) {
      let i = 2;
      while (seen.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    seen.add(name);
    return name;
  };
}

/**
 * Decide whether a parsed constraint qualifies as a lifted leaf parameter (C2).
 *
 * Requirements, each with its reason: a user-given `Name` (unnamed dimensions
 * are not addressable, so nothing can drive them); driving (a reference
 * constraint computes from geometry — making it a `const` would invert the
 * dependency); a dimensional type ({@link DIMENSIONAL_TYPES}); own-geometry
 * refs only (`geoId < 0` is an axis/external ref, which `fromFreeCadConstraints`
 * cannot project and the emitted `cad.sketch` therefore cannot carry).
 *
 * @param sketch - the owning sketch's object name.
 * @param sketchLabel - the owning sketch's Label (reference key fallback).
 * @param con - the parsed FCStd constraint.
 * @returns the candidate, or undefined when the constraint is not liftable.
 */
export function sketchConstraintCandidate(
  sketch: string,
  sketchLabel: string,
  con: { name: string; type: number; value: number; isDriving: boolean; refs: { geoId: number }[] },
): SketchConstraintParam | undefined {
  if (con.name === '') return undefined;
  if (!con.isDriving) return undefined;
  if (!DIMENSIONAL_TYPES.has(con.type)) return undefined;
  if (con.refs.length === 0) return undefined;
  if (con.refs.some((r) => r.geoId < 0)) return undefined;
  if (!Number.isFinite(con.value)) return undefined;
  return { sketch, sketchLabel, constraint: con.name, value: con.value };
}

/**
 * Collect the document's leaf parameters (C1 spreadsheet + VarSet, C2 sketch
 * constraints) and build the reference index.
 *
 * @param docObjects - the whole document's objects (references resolve by Label
 *   first, then by name, mirroring FreeCAD).
 * @param sketchConstraints - already-projected, correlated sketch-constraint
 *   candidates (the caller correlates them with the canonical projection so a
 *   path that cannot be projected never contributes an unused parameter).
 * @returns the ordered parameter list plus the reference lookup.
 */
export function collectLeafParams(
  docObjects: readonly FcstdObject[],
  sketchConstraints: readonly SketchConstraintParam[] = [],
): ParamTable {
  const namer = makeParamNamer();
  const list: LeafParam[] = [];
  const byKey = new Map<string, string>();

  const add = (raw: string, value: number, source: string, keys: readonly string[]): void => {
    const name = namer(raw);
    list.push({ name, value, source });
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, name);
  };

  for (const obj of docObjects) {
    const label = fcstdObjectLabel(obj) ?? obj.name;
    if (obj.type === 'Spreadsheet::Sheet') {
      // GOTCHA: the reference is `<<Label>>.Alias` — the LABEL, not the object
      // name (expressions-alias.test.ts). Both keys are registered so a
      // name-based reference from a hand-written file still resolves.
      for (const cell of sheetCellElements(obj)) {
        const alias = cell.attributes['alias'];
        if (alias === undefined || alias === '') continue;
        const value = spreadsheetAliasValue(docObjects, label, alias);
        if (value === undefined) continue; // unresolvable cell → not a parameter
        add(alias, value, `Spreadsheet::Sheet.Alias:${label}.${alias}`,
          [`ref:${label}.${alias}`, `ref:${obj.name}.${alias}`]);
      }
    } else if (obj.type === 'App::VarSet') {
      // A VarSet variable is a plain property. Numeric-only: a Bool/String cell
      // is not a drivable dimension (GOTCHA 2026-09-26 — `Drawers_A_Side_…`).
      for (const [propName] of obj.properties) {
        const value = evalWithDoc(`${obj.name}.${propName}`, docObjects);
        if (value === undefined) continue;
        add(propName, value, `App::VarSet.Property:${label}.${propName}`,
          [`ref:${label}.${propName}`, `ref:${obj.name}.${propName}`]);
      }
    }
  }

  for (const c of sketchConstraints) {
    add(`${c.sketch}_${c.constraint}`, c.value,
      `Sketcher::SketchObject.Constraint:${c.sketch}.${c.constraint}`,
      [`con:${c.sketch}#${c.constraint}`, `con:${c.sketchLabel}#${c.constraint}`]);
  }

  return {
    list,
    refName(label: string, seg: string, sub?: string): string | undefined {
      return sub === undefined
        ? byKey.get(`ref:${label}.${seg}`)
        : byKey.get(`con:${label}#${sub}`);
    },
  };
}
