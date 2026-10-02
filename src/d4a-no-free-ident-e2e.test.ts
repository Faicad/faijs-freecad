/**
 * D4a (2026-10-02) — every generated `.fai.js` module must be free of
 * undeclared identifiers.
 *
 * The faijs parser rejects a file that references a name which is neither
 * declared (`let`) nor imported in that same module:
 *
 *   [security] SEC_FREE_IDENT line 5: unknown identifier "Pad010"
 *              (not declared, not a known namespace)
 *
 * The FCStd codegen routes calls across Body modules. Before D4a, a call whose
 * input was an INTERNAL variable of another Body (Body007's `Sketch007`,
 * Body001's `Chamfer`) was pushed to `main.fai.js`, which is wired only to each
 * Body's terminal alias — so the internal var was emitted as a bare identifier
 * with no declaration and no import. The owning Body then referenced a main
 * variable it could not see (a cycle). D4a fixes the routing so an own'd call
 * STAYS in its Body and gains a named import for each foreign input.
 *
 * This suite is the acceptance gate for that class: convert a real document,
 * parse every emitted module with acorn, and assert that each module's
 * referenced identifiers are all either declared locally or imported. The
 * parser is used instead of a regex — a regex cannot tell a JSON key or a word
 * inside a comment from a real reference and produces noise (~3000 false hits
 * across the corpus).
 *
 * Corpus-dependent, exactly like compound-members-e2e.test.ts: the FreeCAD
 * library lives in the sibling checkout, so the suite SKIPS (never fails) when
 * absent.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as acornParse } from 'acorn';
import { readZipEntries } from '@faicad/faijs/io/zip';
import { convertFcstdFile } from './convert.js';

const here = dirname(fileURLToPath(import.meta.url));
// src → packages/faijs-freecad → packages → repo root → D:/Faicad (sibling checkout).
const CORPUS = join(here, '..', '..', '..', '..', 'FreeCAD-library');
const dec = new TextDecoder();

/** Names the faijs execution sandbox provides (K5: `cad` is injected). */
const GLOBALS = new Set(['cad', 'undefined', 'NaN', 'Infinity', 'globalThis']);

interface Node {
  type: string;
  name?: string;
  start?: number;
  end?: number;
  params?: Node[];
  id?: Node;
  key?: Node;
  param?: Node;
  computed?: boolean;
  [k: string]: unknown;
}

/**
 * Collect the identifier names a module DECLARES (bindings: `let`, import
 * specifiers, function params) and the names it REFERENCES. `referenced −
 * declared − GLOBALS` is exactly the set the parser rejects.
 */
function analyze(src: string): { declared: Set<string>; referenced: Set<string> } {
  const ast = acornParse(src, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as Node;
  const declared = new Set<string>();
  const referenced = new Set<string>();

  function isBinding(n: Node, parent: Node | undefined): boolean {
    if (!parent) return false;
    if (parent.type === 'VariableDeclarator' && parent.id === n) return true;
    if (parent.type === 'ImportSpecifier') return true;
    if (parent.type === 'ImportDefaultSpecifier') return true;
    if (parent.type === 'ImportNamespaceSpecifier') return true;
    if (
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression'
    ) {
      if (parent.params?.includes(n)) return true;
      if (parent.id === n) return true;
    }
    if (parent.type === 'CatchClause' && parent.param === n) return true;
    return false;
  }

  function walk(n: Node | undefined, parent?: Node): void {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier' && typeof n.name === 'string') {
      if (isBinding(n, parent)) declared.add(n.name);
      else referenced.add(n.name);
    }
    // A property NAME is not a variable reference: `cad.sketch(...)` must not
    // report `sketch`, and `{ geoms: ... }` must not report `geoms`. Only a
    // computed key (`{ [x]: 1 }` / `a[x]`) is a real reference.
    if (n.type === 'Property' && n.key?.type === 'Identifier' && !n.computed) {
      if (n.key.name) declared.add(n.key.name); // suppress as a "free" hit
    }
    if (n.type === 'MemberExpression' && n.property?.type === 'Identifier' && !n.computed) {
      if (n.property.name) declared.add(n.property.name);
    }
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const v = (n as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof (c as Node).type === 'string') walk(c as Node, n);
      } else if (v && typeof (v as Node).type === 'string') {
        walk(v as Node, n);
      }
    }
  }
  walk(ast);
  return { declared, referenced };
}

/** Convert one corpus document and return every free identifier per module. */
async function freeIdentsByModule(abs: string): Promise<Map<string, string[]>> {
  const s = await convertFcstdFile(abs);
  if (!s.ok || !s.zip) throw new Error(`conversion failed: ${String(s.error)}`);
  const entries = readZipEntries(s.zip);
  const out = new Map<string, string[]>();
  for (const [p, bytes] of entries) {
    if (!p.endsWith('.fai.js') || !bytes) continue;
    const { declared, referenced } = analyze(dec.decode(bytes));
    const free = [...referenced].filter((id) => !declared.has(id) && !GLOBALS.has(id));
    if (free.length) out.set(p, free.sort());
  }
  return out;
}

const CASES = [
  // Nut Tuerca M3: `Chamfer` internal to Body001, consumed by a Body feature.
  {
    name: 'Nut Tuerca M3 (Chamfer internal to Body001)',
    rel: join('Mechanical Parts', 'Fasteners', 'Nuts', 'Metric', 'Nut Tuerca M3.FCStd'),
  },
  // ComputerDesk: `Sketch007` internal to Body007, consumed by Body008.
  {
    name: 'ComputerDesk (Sketch007 internal to Body007)',
    rel: join('Industrial Design', 'Tables', 'ComputerDesk (100 x 50 x 75 cm WDH).FCStd'),
  },
  // Screw tornillo: `Chamfer001` internal to Body002.
  {
    name: 'Screw tornillo screwdriver flat M3x12 (Chamfer001 internal to Body002)',
    rel: join(
      'Mechanical Parts',
      'Fasteners',
      'Bolts & Screws',
      'Metric',
      'Screw tornillo screwdriver flat  M3x12 .FCStd',
    ),
  },
];

const present = CASES.filter((c) => existsSync(join(CORPUS, c.rel)));

describe('D4a — generated modules carry no free identifiers (SEC_FREE_IDENT)', () => {
  it.skipIf(present.length === 0)('keeps every emitter module self-contained', async () => {
    const failures: string[] = [];
    for (const c of present) {
      const free = await freeIdentsByModule(join(CORPUS, c.rel));
      for (const [mod, ids] of free) failures.push(`${c.name} → ${mod}: ${ids.join(', ')}`);
    }
    expect(failures, `undeclared identifiers:\n${failures.join('\n')}`).toEqual([]);
  });
});
