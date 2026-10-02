#!/usr/bin/env node
/**
 * fcstd CLI — batch driver entry: .FCStd → .fai.zip with a machine contract.
 *
 * Exit codes (plan §5.2):
 *   0 = converted; mapping final check passed (only translated /
 *       python-baked / preserved-only dispositions)
 *   2 = translation gaps (non-Python baked) — NO zip written
 *   1 = internal error (read/unpack/parse/codegen/container failure)
 *
 * stdout: exactly one JSON line (the summary). Human chatter is forbidden on
 * stdout; diagnostics go to stderr (which must stay empty on success).
 *
 * Run (published):  faijs-freecad-convert <in.FCStd> [out.fai.zip]
 * Run (in-repo):    npm run fcstd:convert -w @faicad/faijs -- <in.FCStd> [out.fai.zip]
 * With no <out>, acts as a dry audit (no file written).
 */
import { writeFileSync } from 'node:fs';
import { convertFcstdFile } from './convert.js';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: faijs-freecad-convert <in.FCStd> [out.fai.zip]');
  process.exit(1);
}

const summary = await convertFcstdFile(input);
if (summary.ok && output && summary.zip) {
  writeFileSync(output, summary.zip);
}
// stdout contract: ONE json line, no binary payload — zip bytes are stripped
// before serialization (they are written to <out> above, never printed).
const { zip: _zip, ...report } = summary;
void _zip;
console.log(JSON.stringify(report));

if (!summary.ok) {
  process.exit(summary.gaps.length > 0 ? 2 : 1);
}
