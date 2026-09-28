/**
 * Design probe for the A4 Draft-drawing chain (2026-09-28).
 *
 * Decides, by EXECUTION (not inference), which emission target is viable:
 *   Q1 — does `cad.draw(...)` return something `cad.extrude` accepts?
 *   Q2 — does `cad.profile({contours})` work for the same polylines?
 *   Q3 — is a 150-call member chain over the AST depth limit?
 *   Q4 — does a batched array arg stay under the depth limit at 1500 points?
 *   Q5 — does `cad.draw` work when fed TWO contours in one session?
 *
 * Usage: npx tsx packages/fcstd/scripts/probe-draw-design.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { mergeDrawNamespace } from '../../draw/src/namespace.js';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeDrawNamespace(mergeSketchNamespace(createApiNamespace()));

/** Build a `.fai.js` source for one case. */
const cases: Array<{ id: string; src: string }> = [
  {
    id: 'Q1 draw-BP-into-extrude',
    src: [
      'function mk() { return cad.draw((pen) => pen.lineTo([40, 0]).lineTo([40, 20]).lineTo([0, 0])); }',
      'let b = mk();',
      'let e = cad.extrude(b, [0, 0, 10]);',
    ].join('\n'),
  },
  {
    id: 'Q1b draw-BP-into-sweep',
    src: [
      'function p1() { return cad.draw((pen) => pen.lineTo([10, 0]).lineTo([10, 10]).lineTo([0, 10]).lineTo([0, 0])); }',
      'function p2() { return cad.draw((pen) => pen.lineTo([0, 0]).lineTo([0, 50])); }',
      'let a = p1();',
      'let b = p2();',
      'let s = cad.sweep(a, b, { frenet: true });',
    ].join('\n'),
  },
  {
    id: 'Q2 profile-polyline-into-extrude',
    src: [
      'let p = cad.profile({ contours: [{ segments: [',
      "  { kind: 'line', x1: 0, y1: 0, x2: 40, y2: 0 },",
      "  { kind: 'line', x1: 40, y1: 0, x2: 40, y2: 20 },",
      "  { kind: 'line', x1: 40, y1: 20, x2: 0, y2: 0 },",
      '] }] });',
      'let e = cad.extrude(p, [0, 0, 10]);',
    ].join('\n'),
  },
  {
    id: 'Q3 150-chained-lineTo',
    src: [
      'function mk() { return cad.draw((pen) => ' +
        Array.from({ length: 150 }, (_, i) => `lineTo([${i}, ${i}])`).join('.').replace(/^/, 'pen.') +
        '); }',
      'let b = mk();',
    ].join('\n'),
  },
  {
    id: 'Q4 batched-1500-points',
    src: [
      'let pts = ' +
        JSON.stringify(Array.from({ length: 1500 }, (_, i) => [i, i * 2])) +
        ';',
      'let p = cad.profile({ contours: [{ segments: pts.slice(1).map((q, i) => ({ kind: "line", x1: pts[i][0], y1: pts[i][1], x2: q[0], y2: q[1] })) }] });',
    ].join('\n'),
  },
  {
    id: 'Q5 two-contours-in-one-session',
    src: [
      'function mk() { return cad.draw((pen) => pen.lineTo([10, 0]).lineTo([10, 10]).lineTo([0, 0]).movePointerTo([30, 30]).lineTo([40, 30]).lineTo([30, 30])); }',
      'let b = mk();',
    ].join('\n'),
  },
];

for (const c of cases) {
  const scratch = mkdtempSync(join(tmpdir(), 'fai-dsn-'));
  mkdirSync(join(scratch, 'assets'), { recursive: true });
  const entry = join(scratch, 'main.fai.js');
  writeFileSync(entry, c.src + '\n');
  let line: string;
  try {
    const r = await cliRun(entry, join(scratch, 'out.step'), {
      mode: 'brep', assetsDir: join(scratch, 'assets'), projectRoot: scratch, libs: { cad: CAD_NS },
    });
    const stepBytes = readdirSync(scratch).filter((f) => f.endsWith('.step'))
      .reduce((n, f) => n + readFileSync(join(scratch, f)).length, 0);
    line = `ok=${r.ok} step=${stepBytes}B err=${String((r as { error?: unknown }).error ?? '')}`;
  } catch (e) {
    line = `THREW: ${String((e as Error).message ?? e)}`;
  }
  console.log(`[${c.id}] ${line}`);
}
