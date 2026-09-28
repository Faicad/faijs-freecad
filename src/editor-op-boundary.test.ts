import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SYMBOL_TABLE, symbolTableNames } from '@faicad/faijs/symbol-table';
// A2 (2026-09-28): the lowering now emits `cad.sketch` (parametric sketch
// translation). Its symbols live in the sketch library and join SYMBOL_TABLE
// only when a host registers them — register here so the boundary guard sees
// the same namespace a real run host has.
import { registerSketchSymbols, unregisterSketchSymbols } from '@faicad/faijs-sketch';

/**
 * Editor-owned op boundary guard (2026-09-21) — see
 * .agents/notes/implemented/architecture/2026-09-21-editor-owned-ops-deprecation.md
 *
 * FCStd conversion is a platform capability. The sibling `../3d_editor`
 * project's interaction ops serve that editor's canvas, drag and timeline
 * model, so they are deprecated on the faijs platform surface (their source
 * JSDoc carries `@deprecated`).
 *
 * 2026-09-21 (H11): the platform now owns the three ops the conversion layer
 * needed — `cad.import_brep` (frozen BREP asset → Shape), `cad.compound`
 * (geometry compound on the OCCT kernel) and `cad.place` (rigid placement from
 * a quaternion). The FCStd lowering therefore borrows **nothing** from the
 * editor, and this guard pins that from three sides: the deprecation markers
 * may not be dropped, the borrow count must stay zero, and every callee the
 * lowering emits must be a real member of the cad namespace.
 *
 * 2026-09-23 (D1, editor extension library split): `load`, `group`, `assembly`
 * and `copy` left core entirely into `@faicad/faijs-extra`, so they can no
 * longer be pinned here — their boundary is guarded by the extension library's
 * own membership test. Per D1 option C the four transform ops **stay in core**
 * (`translate` is the only transform op the weapp end side runs), and they are
 * what remains editor-owned on the platform surface.
 */

/**
 * Ops owned by `../3d_editor`'s interaction model that still live in core, and
 * the file that declares them.
 *
 * D1 option C: the transform family stays whole. `translate` is a general
 * geometric transform and the only transform op the weapp end side executes;
 * splitting the family would leave the end side without it. `load` /
 * `group` / `assembly` / `copy` moved to `@faicad/faijs-extra` and are no longer
 * reachable from here.
 */
const EDITOR_OWNED: Record<string, string> = {
  translate: 'api/transform.ts',
  rotate_euler: 'api/transform.ts',
  scale: 'api/transform.ts',
  scale3d: 'api/transform.ts',
};

/**
 * The borrow the FCStd lowering is allowed to keep, with the number of emitted
 * sites per op — now EMPTY: platform ops replaced every one of them.
 *
 * GOTCHA: before H11 this had to count `cad.group` THREE times, not one —
 * besides the `Part::Compound` branch in `feature-translate.ts`, `codegen.ts`
 * used it twice as the product-aggregation outlet (multi-Body documents and
 * single-file roots). Grepping `feature-translate.ts` alone finds only a third
 * of it. That is why the scan below walks every non-test file in this
 * directory instead of just the translator.
 */
const DECLARED_BORROW: Record<string, number> = {};

const here = dirname(fileURLToPath(import.meta.url));
// This test moved to `packages/fcstd/src` with the fcstd package extraction;
// the editor-owned op sources it pins still live in the core engine package.
const coreSrcRoot = join(here, '..', '..', 'core', 'src');

function read(relative: string): string {
  return readFileSync(join(coreSrcRoot, relative), 'utf-8');
}

/**
 * Every cad op name the FCStd lowering can emit, scraped from this directory's
 * non-test sources. Two emission shapes count: a call-plan `op: 'cad.x'` field,
 * and a literal `cad.x(` inside a generated template string (the aggregation
 * outlets in `codegen.ts`).
 *
 * Deliberately a text scan, not an import: the point is to see what the
 * lowering SAYS, including a name that no longer exists anywhere else.
 */
function loweringCallees(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(here)) {
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
    // Strip comments first: the doc comments illustrate the call shape with a
    // placeholder (`let <Name> = cad.x(...)` in codegen.ts, where <Name> is the
    // FCStd source object name, never partN), and a placeholder is not an
    // emission. Only real code counts.
    const text = readFileSync(join(here, entry), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    names.push(
      ...[...text.matchAll(/op: 'cad\.(\w+)'/g)].map((m) => m[1]!),
      ...[...text.matchAll(/cad\.(\w+)\(/g)].map((m) => m[1]!),
    );
  }
  return names;
}

describe('editor-owned op boundary', () => {
  registerSketchSymbols();
  afterAll(() => unregisterSketchSymbols());

  it('every editor-owned op still carries @deprecated in its source JSDoc', () => {
    for (const [op, file] of Object.entries(EDITOR_OWNED)) {
      const text = read(file);
      const nameAt = text.indexOf(`@name ${op}\n`);
      expect(nameAt, `${file} declares @name ${op}`).toBeGreaterThan(-1);
      const jsdocEnd = text.indexOf('*/', nameAt);
      const jsdoc = text.slice(nameAt, jsdocEnd);
      expect(jsdoc, `${op} carries @deprecated`).toContain('@deprecated');
    }
  });

  it('the fcstd lowering borrows exactly the declared editor-owned ops', () => {
    const found: Record<string, number> = {};
    for (const name of loweringCallees()) {
      if (!(name in EDITOR_OWNED)) continue;
      found[name] = (found[name] ?? 0) + 1;
    }
    expect(found).toEqual(DECLARED_BORROW);
  });

  // The statically checkable half of the H11 bug. The shape-asset rounds used
  // to emit a made-up `cad.import_shape`; 42 of 50 corpus products parsed clean
  // and could not RUN, because `cliCheck` validates syntax and script-local
  // references but never the callee's existence. The symbol table is generated
  // from the cad namespace itself, so this catches the same mistake without
  // running anything: a name the lowering emits must be a name the namespace
  // has.
  it('every callee the fcstd lowering emits exists in the cad namespace', () => {
    // GOTCHA (A2, 2026-09-28): `Object.keys(SYMBOL_TABLE)` sees only the
    // GENERATED platform table — library ops registered via
    // registerSymbolTableEntries (e.g. `sketch` from @faicad/faijs-sketch)
    // live in a separate extension map. Use symbolTableNames(), the union
    // view, or every library op the lowering emits is a false unknown.
    const known = new Set(symbolTableNames());
    const unknown = [...new Set(loweringCallees())].filter((n) => !known.has(n));
    expect(unknown).toEqual([]);
  });
});
