/**
 * Design probe for the A1 analytic Draft-drawing emission
 * (`docs/plans/2026-09-29-fcstd-draft-sprocket-timeout-plan.md` §A1).
 *
 * Context: `draft-draw.ts` today rebuilds a Draft contour from `wireframe()` —
 * a pure TESSELLATION — and emits ONE `pen.polyline([…])` call. `Sprocket ANSI
 * simplex 1x1 z21` is 168 analytic edges (126 circle + 42 line) that tessellate
 * to ~7000 points and never finish. The fix emits segments instead of points,
 * which changes the SHAPE of the emitted `.fai.js` — so this probe decides, by
 * EXECUTION, which emission form the dialect actually accepts:
 *
 *   F1 — a BLOCK-bodied arrow with N pen commands (draft-draw keeps `cad.draw`,
 *        so nothing downstream changes; needs the dialect to accept `{ … }`).
 *   F2 — the same N segments as a `ProfileLoop` (`{segments:[…]}`) fed straight
 *        to `cad.profile` (single object-literal argument ⇒ no AST depth risk).
 *   F3 — `ProfileLoop` fed straight to `cad.sketchOnPlane` (the form the fcstd
 *        codegen would need if it drops the `cad.draw` intermediate).
 *   F4 — F1 at real scale (168 segments), to confirm no depth/parse limit bites.
 *
 * Every case is built from the SAME analytic data so the four are comparable.
 *
 * Usage: node --import tsx packages/faijs-freecad/scripts/probe-draw-analytic.ts
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

/** Rounded to 1e-6 like the real emitter, so source size stays realistic. */
const f = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/**
 * The measured Sprocket signature: a closed loop of `teeth` repeats, each
 * `[line, arc, arc]`. Radii are the measured order of magnitude (r ≈ 23 mm on a
 * 21-tooth sprocket), angles walk the loop so the contour actually closes.
 */
function sprocketSegments(teeth: number): string[] {
  const segs: string[] = [];
  const rTip = 78;
  const rRoot = 62;
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a0 = i * step;
    // root arc (center at origin, from the previous tooth's flank to this one)
    const aRoot0 = a0 + step * 0.1;
    const aRoot1 = a0 + step * 0.35;
    segs.push(
      `{"kind":"arc","cx":0,"cy":0,"radius":${rRoot},"startAngle":${f(aRoot0)},"endAngle":${f(aRoot1)},` +
        `"ccw":true,"x1":${f(rRoot * Math.cos(aRoot0))},"y1":${f(rRoot * Math.sin(aRoot0))},` +
        `"x2":${f(rRoot * Math.cos(aRoot1))},"y2":${f(rRoot * Math.sin(aRoot1))}}`,
    );
    // root → tip flank (line)
    const aTip0 = a0 + step * 0.5;
    segs.push(
      `{"kind":"line","x1":${f(rRoot * Math.cos(aRoot1))},"y1":${f(rRoot * Math.sin(aRoot1))},` +
        `"x2":${f(rTip * Math.cos(aTip0))},"y2":${f(rTip * Math.sin(aTip0))}}`,
    );
    // tip arc
    const aTip1 = a0 + step * 0.8;
    segs.push(
      `{"kind":"arc","cx":0,"cy":0,"radius":${rTip},"startAngle":${f(aTip0)},"endAngle":${f(aTip1)},` +
        `"ccw":true,"x1":${f(rTip * Math.cos(aTip0))},"y1":${f(rTip * Math.sin(aTip0))},` +
        `"x2":${f(rTip * Math.cos(aTip1))},"y2":${f(rTip * Math.sin(aTip1))}}`,
    );
    // tip → root line
    const aRoot2 = a0 + step * 0.9;
    segs.push(
      `{"kind":"line","x1":${f(rTip * Math.cos(aTip1))},"y1":${f(rTip * Math.sin(aTip1))},` +
        `"x2":${f(rRoot * Math.cos(aRoot2))},"y2":${f(rRoot * Math.sin(aRoot2))}}`,
    );
    // close the tooth back onto the next root arc
    segs.push(
      `{"kind":"arc","cx":0,"cy":0,"radius":${rRoot},"startAngle":${f(aRoot2)},"endAngle":${f(aRoot0 + step)},` +
        `"ccw":true,"x1":${f(rRoot * Math.cos(aRoot2))},"y1":${f(rRoot * Math.sin(aRoot2))},` +
        `"x2":${f(rRoot * Math.cos(aRoot0 + step))},"y2":${f(rRoot * Math.sin(aRoot0 + step))}}`,
    );
  }
  return segs;
}

/** F1/F4: block-bodied arrow body — one statement per segment. */
function penBlock(segs: readonly string[], indent: string): string {
  const out: string[] = [];
  for (const raw of segs) {
    const s = JSON.parse(raw) as Record<string, number | string>;
    if (s.kind === 'line') {
      out.push(`${indent}pen.lineTo([${s.x1}, ${s.y1}]);`);
    } else {
      const cx = s.cx as number;
      const cy = s.cy as number;
      const r = s.radius as number;
      const mid = ((s.startAngle as number) + (s.endAngle as number)) / 2;
      out.push(
        `${indent}pen.threePointsArcTo([${s.x2}, ${s.y2}], [${f(cx + r * Math.cos(mid))}, ${f(cy + r * Math.sin(mid))}]);`,
      );
    }
  }
  return out.join('\n');
}

const cases: Array<{ id: string; src: string }> = [];

// ── F1: block-bodied arrow, small loop (5 teeth = 25 segments) ──
{
  const segs = sprocketSegments(5);
  const start = JSON.parse(segs[0]!) as Record<string, number>;
  cases.push({
    id: 'F1 block-body-arrow 25-segments',
    src: [
      'function mk() {',
      '  return cad.draw((pen) => {',
      `    pen.movePointerTo([${start.x1}, ${start.y1}]);`,
      penBlock(segs, '    '),
      '  });',
      '}',
      'let b = mk();',
      'let p = cad.sketchOnPlane({ contours: [b], plane: {"name":"XY"} });',
      'let e = cad.extrude(p, [0, 0, 10]);',
    ].join('\n'),
  });
}

// ── F2: ProfileLoop through cad.profile ──
{
  const segs = sprocketSegments(5);
  cases.push({
    id: 'F2 profile-loop→cad.profile',
    src: [
      `let p = cad.profile({ contours: [{ "segments": [${segs.join(',')}] }] });`,
      'let e = cad.extrude(p, [0, 0, 10]);',
    ].join('\n'),
  });
}

// ── F3: ProfileLoop straight into cad.sketchOnPlane ──
{
  const segs = sprocketSegments(5);
  cases.push({
    id: 'F3 profile-loop→sketchOnPlane',
    src: [
      `let p = cad.sketchOnPlane({ contours: [{ "segments": [${segs.join(',')}] }], plane: {"name":"XY"} });`,
      'let e = cad.extrude(p, [0, 0, 10]);',
    ].join('\n'),
  });
}

// ── F4: F1 at real scale (21 teeth = 105 segments) ──
{
  const segs = sprocketSegments(21);
  const start = JSON.parse(segs[0]!) as Record<string, number>;
  cases.push({
    id: `F4 block-body-arrow ${segs.length}-segments`,
    src: [
      'function mk() {',
      '  return cad.draw((pen) => {',
      `    pen.movePointerTo([${start.x1}, ${start.y1}]);`,
      penBlock(segs, '    '),
      '  });',
      '}',
      'let b = mk();',
      'let p = cad.sketchOnPlane({ contours: [b], plane: {"name":"XY"} });',
      'let e = cad.extrude(p, [0, 0, 10]);',
    ].join('\n'),
  });
}

for (const c of cases) {
  const scratch = mkdtempSync(join(tmpdir(), 'fai-a1-'));
  mkdirSync(join(scratch, 'assets'), { recursive: true });
  const entry = join(scratch, 'main.fai.js');
  writeFileSync(entry, c.src + '\n');
  const t0 = Date.now();
  let line: string;
  try {
    const r = await cliRun(entry, join(scratch, 'out.step'), {
      mode: 'brep', assetsDir: join(scratch, 'assets'), projectRoot: scratch, libs: { cad: CAD_NS },
    });
    const stepBytes = readdirSync(scratch).filter((x) => x.endsWith('.step'))
      .reduce((n, x) => n + readFileSync(join(scratch, x)).length, 0);
    line = `ok=${r.ok} step=${stepBytes}B err=${String((r as { error?: unknown }).error ?? '')}`;
  } catch (e) {
    line = `THREW: ${String((e as Error).message ?? e).slice(0, 240)}`;
  }
  console.log(`[${c.id}] srcBytes=${c.src.length} ${Date.now() - t0}ms ${line}`);
}
