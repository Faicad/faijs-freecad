/**
 * Probe: does the `cad.draw` pen actually expose `moveTo` / a 2-arg `lineTo`?
 * Static reading says no (the pen is `BaseSketcher2d`: `movePointerTo(Point2)`,
 * `lineTo(Point2)`). This runs it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRun } from '@faicad/faijs/node';
import { createApiNamespace } from '@faicad/faijs';
import { mergeDrawNamespace } from '../../draw/src/namespace.js';
import { mergeSketchNamespace, installSketchSolver } from '@faicad/faijs-sketch';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';

installSketchSolver(createNodePlanegcsSolver);
const CAD_NS = mergeSketchNamespace(mergeDrawNamespace(createApiNamespace()));

const scratch = mkdtempSync(join(tmpdir(), 'fai-pen-'));
// Same shape the fcstd emitter uses: the arrow lives in a FUNCTION BODY
// (expression position is rejected by the dialect: "unsupported value
// expression: ArrowFunctionExpression").
const wrap = (body: string): string =>
  `function drawX() {\n  return cad.draw(${body});\n}\nlet d = drawX();\n`;
const cases: [string, string][] = [
  ['emitted-as-is (moveTo + 2-arg lineTo)', '(pen) => pen.moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).close()'],
  ['pen API as actually declared', '(pen) => pen.movePointerTo([0, 0]).lineTo([10, 0]).lineTo([10, 10]).close()'],
  ['two contours via two movePointerTo', '(pen) => pen.movePointerTo([0, 0]).lineTo([10, 0]).close().movePointerTo([0, 5]).lineTo([10, 5])'],
];
for (const [idx, [label, src]] of cases.entries()) {
  const file = join(scratch, `case${idx}.fai.js`);
  writeFileSync(file, wrap(src));
  try {
    const r = await cliRun(file, join(scratch, `out${idx}.step`), {
      mode: 'brep', projectRoot: scratch, libs: { cad: CAD_NS },
    });
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} | ${label} | ${r.ok ? '' : String((r as { error?: unknown }).error ?? '')}`);
  } catch (e) {
    console.log(`THROW| ${label} | ${String((e as Error).message ?? e).slice(0, 200)}`);
  }
}
