/**
 * B0 — THE FCStd → .fai.zip conversion pipeline (batch CLI and tests share it;
 * `src/fcstd/cli.ts` is its only CLI). Returns a structured summary; the caller
 * decides exit codes and output formatting (C4: batch driver must never absorb
 * failures).
 *
 * 2026-09-20: the M5.4-era dev script `scripts/fcstd-to-fai-zip.ts` was a second
 * implementation of this same pipeline (no C4 audit, no exit-code contract) and
 * has been deleted. Whether the conversion entry is published or not, this file
 * is the single implementation.
 *
 * Dispositions (plan §2, C4): translated | python-baked | preserved-only.
 * Any other baked reason = translation gap → result.ok = false, no zip
 * written (final check `auditMapping`).
 */
import { readFileSync } from 'node:fs';
import { unpackFcstd, memberText, brpEmbeddedLocation } from './unpack.js';
import { parseFilletEdges, type FilletEdgeEntry } from './fillet-edges.js';
import { parseDocumentXml } from './document.js';
import { parseSketchObject } from './sketch-parse.js';
import { createNodePlanegcsSolver } from '@faicad/faijs-sketch/node';
import { classifySketch } from '@faicad/faijs-sketch';
import { resolveExternalGeometry } from './external-geo.js';
import { extractContours } from '@faicad/faijs-sketch';
import type { Contour } from '@faicad/faijs-sketch';
import { fromFreeCadGeoms, fromFreeCadConstraints } from '@faicad/faijs-sketch';
import type { SketchGeom, SketchConstraint } from '@faicad/faijs-sketch';
import { isDraft2DObject, extractDraftDrawing } from './draft-draw.js';
import type { DraftDrawing } from './draft-draw.js';
import { generateModel } from './codegen.js';
import { collectLeafParams, sketchConstraintCandidate } from './params.js';
import type { SketchConstraintParam } from './params.js';
import { fcstdObjectLabel } from './expressions.js';
import { setParamContext } from './feature-translate.js';
import { jsExpr } from './feature-translate.js';
import type { Placement } from './placement.js';
import { quatToMatrix } from './placement.js';
import { effectivePlacement } from './attachment.js';
import { buildFaiZip } from './build-fai-zip.js';
import { isOk } from '@faicad/faijs/api/result';
import { readZipEntries } from '@faicad/faijs/io/zip';
import { writeZipEntries } from '@faicad/faijs/io';
import {
  STRUCTURAL_TYPES,
  STRUCTURAL_TYPES_EXTENDED,
  isFemStructural,
  isNonModelingType,
} from './structural-types.js';

// Kept on this module's public surface: these sets are part of the
// `./fcstd-convert` contract that the batch project and its tests consume. The
// definitions live in `structural-types.ts` so codegen can share them without
// a circular import.
export { STRUCTURAL_TYPES, STRUCTURAL_TYPES_EXTENDED, isFemStructural };

/** V2 tolerance: solver must reproduce stored geometry (single source). */
export const SKETCH_T1 = 1e-6;

/** Dispositions allowed in a conforming container (C4). */
export const ALLOWED_DISPOSITIONS = new Set(['translated', 'python-baked', 'preserved-only', 'skipped-empty']);

/**
 * Optional knobs for `convertFcstdFile`.
 */
export interface ConvertOptions {
  /**
   * Return the container bytes even when the mapping audit reports gaps.
   *
   * Diagnostics only. C4 requires that a gapped document produces **no
   * product**, and the CLI never sets this — `ok` stays false and the exit
   * code stays 2 regardless. It exists because everything the pipeline built
   * before the audit is otherwise unobservable for exactly the documents that
   * need triage: gaps and non-L0 sketches usually co-occur (a sketch the
   * solver cannot handle usually starves the features built on it), so
   * "which contour assets / mapping entries would this document have had"
   * cannot be answered from `gaps[]` alone.
   */
  keepGappedContainer?: boolean;
}

/** Structured result of one FCStd → .fai.zip conversion; the caller decides exit codes and formatting. */
export interface ConvertSummary {
  /** input file path */
  file: string;
  /** conversion succeeded AND mapping final check passed */
  ok: boolean;
  /** translation gaps (non-Python baked) — empty when ok */
  gaps: { name: string; type: string; reason: string }[];
  counts: { translated: number; pythonBaked: number; preservedOnly: number; baked: number };
  sketches: { total: number; l0: number; l1: number; l2: number };
  /** container bytes (undefined when ok=false, unless `keepGappedContainer`) */
  zip?: Uint8Array;
  /** human-readable failure when the pipeline itself failed */
  error?: string;
  elapsedMs: number;
}

/**
 * C4 final check: reclassify `baked` entries. A baked disposition is only
 * legitimate for Python-opaque objects (python-baked), structural/datum
 * containers (preserved-only), or preserved display members. Everything
 * else is a translation gap.
 */
function auditMapping(
  mapping: { objects: { name: string; type: string; disposition: string; reason?: string }[] },
): ConvertSummary['gaps'] {
  const gaps: ConvertSummary['gaps'] = [];
  for (const o of mapping.objects) {
    if (o.disposition === 'baked') {
      // python-opaque stays legitimate but is renamed for the ledger
      if (o.reason === 'python-opaque') {
        o.disposition = 'python-baked';
      } else if (o.reason === 'sketch-empty-geoms') {
        // K 组（2026-10-03, endstop-v1-2-makerbot）：GeometryList count="0" 的
        // 真空草图对几何零贡献（Document.xml 实证），不构成翻译缺口——如实记为
        // skipped-empty，不再把整个产品拉成 gap。消费者（Pad/Pocket 引用空草图）
        // 会各自按 missing-dependency 记账，不在这里替它们保持红。
        o.disposition = 'skipped-empty';
      } else if (STRUCTURAL_TYPES.has(o.type) || isFemStructural(o.type) || STRUCTURAL_TYPES_EXTENDED.has(o.type)) {
        o.disposition = 'preserved-only';
        o.reason = o.reason
          ?? (isFemStructural(o.type) ? 'fem-simulation'
            : STRUCTURAL_TYPES_EXTENDED.has(o.type) ? 'container-link' : 'structural');
      } else {
        gaps.push({ name: o.name, type: o.type, reason: o.reason ?? 'unspecified' });
      }
    }
  }
  return gaps;
}

/**
 * Convert one FCStd file through the full pipeline (unpack → parse → sketch
 * solving → codegen → container build) and return a structured summary.
 * @param input path to the .FCStd file to convert
 * @param opts optional knobs (see {@link ConvertOptions}); defaults keep the C4 contract
 * @returns a summary with ok=false (and no zip, unless `keepGappedContainer`) on any pipeline failure or translation gap
 */
export async function convertFcstdFile(input: string, opts?: ConvertOptions): Promise<ConvertSummary> {
  const t0 = Date.now();
  const baseName = input.replace(/^.*[/\\]/, '').replace(/\.fcstd$/i, '');
  const fail = (error: string): ConvertSummary => ({
    file: input, ok: false, gaps: [],
    counts: { translated: 0, pythonBaked: 0, preservedOnly: 0, baked: 0 },
    sketches: { total: 0, l0: 0, l1: 0, l2: 0 }, error, elapsedMs: Date.now() - t0,
  });

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(readFileSync(input));
  } catch (e) {
    return fail(`read failed: ${(e as Error).message}`);
  }
  const unpacked = unpackFcstd(raw);
  if (!isOk(unpacked)) return fail(`unpack failed: ${JSON.stringify(unpacked.error)}`);
  const xml = memberText(unpacked.value, 'Document.xml');
  if (xml === undefined) return fail('Document.xml missing');
  const doc = await parseDocumentXml(xml);
  if (!isOk(doc)) return fail(`parse failed: ${doc.error.message}`);

  // M3: solve every sketch (same pipeline as the dev script)
  const solver = await createNodePlanegcsSolver();
  const sketchVerdict = new Map<string, { level: 'L0' | 'L1' | 'L2'; reason?: string; loopCount?: number }>();
  const sketchContours = new Map<string, Contour[]>();
  // A2 (2026-09-28 plan): canonical geoms+constraints per parameterizable sketch —
  // the convert-time solve is now only a FIDELITY PRECHECK; the emitted
  // `cad.sketch` re-solves at run time (D2 decision (b)).
  const sketchInputs = new Map<string, { geoms: SketchGeom[]; constraints: SketchConstraint[]; closureUnobservable?: boolean }>();
  // C2 (2026-09-28 plan): named dimensional constraints lifted to `const p_*`.
  // The candidate list feeds the shared parameter allocator; the index list says
  // which canonical constraint carries the parameter so its `value` can be
  // rewritten to the parameter reference after the table exists.
  const sketchParamCandidates: SketchConstraintParam[] = [];
  const sketchConParamIdx = new Map<string, { idx: number; name: string }[]>();
  for (const obj of doc.value.objects) {
    if (obj.type !== 'Sketcher::SketchObject') continue;
    const sk = parseSketchObject(obj.properties.get('Geometry'), obj.properties.get('Constraints'), false);
    const offPlane = sk.geoms.some((g) => {
      const zs = g.kind === 'point' ? [g.z]
        : g.kind === 'line' ? [g.z1, g.z2]
        : g.kind === 'bspline' ? [g.z1, g.z2] // P4: spline endpoints carry z
        : [g.cz];
      return zs.some((z) => Math.abs(z) > 1e-9);
    });
    const preBlocked =
      offPlane ? 'sketch-geometry-off-plane'
      : sk.geoms.some((g) => !Number.isFinite((g as { x?: number }).x ?? 0)) ? 'unsupported-geometry'
      : undefined;
    if (preBlocked) {
      sketchVerdict.set(obj.name, { level: 'L2', reason: preBlocked });
      continue;
    }
    let external: { geoId: number; polyline: [number, number][] }[] | undefined;
    if (sk.externalGeoIds.length > 0) {
      const ext = await resolveExternalGeometry(
        obj.properties.get('ExternalGeometry'), doc.value, unpacked.value, obj.properties.get('Placement'),
      );
      // P3-3 (2026-09-24): external EDGES are discretized to polylines — a
      // straight edge yields 2 points, an ARC yields many. The old
      // `length === 2` filter silently dropped every arc link with no
      // failure record (sketch baked `external-geometry-unresolved: no
      // links` while resolveExternalGeometry had actually succeeded). The
      // solver pins multi-point polylines as fixed sampled targets
      // (planegcs-backend M6.3), so any deduped polyline >= 2 is usable.
      // 2026-09-28: a `VertexN` link resolves to a SINGLE point — also a
      // usable fixed target — so the filter is >= 1 now.
      const usable = ext.links.filter((l) => l.polyline.length >= 1);
      if (usable.length === 0) {
        sketchVerdict.set(obj.name, {
          level: 'L2',
          reason: `external-geometry-unresolved: ${ext.failures[0]?.reason ?? 'no links'}`,
        });
        continue;
      }
      // geoId must follow the SOURCE link order (`-3 - linkIndex`), not the
      // position inside `usable`: FreeCAD keeps slot `-3 - i` for the i-th
      // ExternalGeometry entry even when an earlier link fails to resolve, so
      // deriving it from the filtered index shifted every later ref onto a
      // non-existent geoId — dropped silently by the solver's unresolvable
      // check, with no failure record anywhere.
      external = usable.map((l) => ({ geoId: -3 - l.linkIndex, polyline: l.polyline }));
    }
    try {
      const r = await solver.solve(sk.geoms, sk.constraints, external);
      if (!isOk(r)) {
        sketchVerdict.set(obj.name, { level: 'L2', reason: 'solver-error' });
        continue;
      }
      const verdict = classifySketch(r.value, sk.geoms, SKETCH_T1);
      const contours = verdict.level === 'L0' ? extractContours(r.value.geoms) : [];
      sketchVerdict.set(obj.name, { ...verdict, loopCount: contours.length });
      if (verdict.level === 'L0') sketchContours.set(obj.name, contours);
      // D2 (b): non-failed outcomes keep the parametric translation — the
      // convert-time solve above stays only as the fidelity precheck; the
      // emitted `cad.sketch` re-solves at run time. GOTCHA: FcstdSolveOutcome
      // has no `status` field (that is the canonical SolveOutcome) — failed is
      // `!converged && reason === 'failed'`; conflicting/redundant stay
      // parametric per D2.
      const solveFailed = !r.value.converged && r.value.reason === 'failed';
      if (!solveFailed) {
        const geoms = fromFreeCadGeoms(sk.geoms);
        const proj = fromFreeCadConstraints(sk.constraints, geoms);
        // K 组 (2026-10-04): the projection DROPS constraint refs it cannot
        // map (axis refs like Sketch037's coincident to the X axis, external
        // refs — `external-or-axis-ref` — and other unmapped kinds), so a
        // sketch whose profile closes THROUGH a dropped constraint looks
        // provably-open to the topology discriminator even though the
        // run-time solve (which gets the full picture) closes it fine —
        // Kitchen_cabinet_base Sketch037/229/036, FCBL_curtain Sketch. One
        // flag covers every blind spot: closure is UNOBSERVABLE when any
        // constraint was dropped OR external geometry is present; the
        // emission gate never bakes what the discriminator cannot see.
        sketchInputs.set(obj.name, {
          geoms,
          constraints: proj.constraints,
          closureUnobservable: proj.unmapped.length > 0 || sk.externalGeoIds.length > 0,
        });
        // C2: correlate every projected constraint with its FCStd source, in
        // input order minus the unmapped indices (`unmapped` is exactly the
        // projection's own rejection ledger, so the two can never disagree).
        const unmapped = new Set(proj.unmapped.map((u) => u.index));
        const label = fcstdObjectLabel(obj) ?? obj.name;
        const lifted: { idx: number; name: string }[] = [];
        let idx = 0;
        for (let i = 0; i < sk.constraints.length; i++) {
          if (unmapped.has(i)) continue;
          const src = sk.constraints[i]!;
          const cand = sketchConstraintCandidate(obj.name, label, src);
          if (cand) {
            sketchParamCandidates.push(cand);
            lifted.push({ idx, name: cand.constraint });
          }
          idx++;
        }
        if (lifted.length > 0) sketchConParamIdx.set(obj.name, lifted);
      }
    } catch (e) {
      sketchVerdict.set(obj.name, { level: 'L2', reason: `solver-throw: ${(e as Error).message.slice(0, 60)}` });
    }
  }

  // A4: rebuild Draft drawing objects (`Part::Part2DObjectPython`) from their
  // frozen Shape .brp wireframes — the drawing process is re-emitted as a
  // `cad.draw` pen chain (D1: drawings → cad.draw, not profile/baked).
  const draftDrawings = new Map<string, DraftDrawing>();
  for (const obj of doc.value.objects) {
    if (!isDraft2DObject(obj)) continue;
    if (!obj.properties.get('Shape')?.children[0]?.attributes['file']) continue; // no frozen shape → not drawable
    try {
      const d = await extractDraftDrawing(obj, unpacked.value);
      if (d) draftDrawings.set(obj.name, d);
    } catch {
      // leave unbuilt — the object falls through to its previous handling
    }
  }

  // M4/M5: translate + codegen
  // H3: attachment-resolved placements — an attached sketch's stored Placement
  // is recomputed by FreeCAD from Support ∘ AttachmentOffset; resolve the chain
  // so non-XY-plane sketches land on their support frame (fall back to the
  // stored value when the attachment is deactivated or unresolvable).
  const placements = new Map<string, Placement>();
  for (const obj of doc.value.objects) {
    placements.set(obj.name, effectivePlacement(obj, placements));
  }
  // H7: objects whose Shape is stored as a ZIP .brp member (pure-Shape
  // carriers, e.g. Part::Feature) — collected from the archive members so the
  // translator can record `shape-asset` instead of a translation gap.
  // H7 follow-up: SubShape carriers (feature result caches in Body-less
  // PartDesign files) join the same set — the translator only honors SubShape
  // evidence for features whose SubShape .brp member exists.
  // GOTCHA (PadTest, 2026-09-21): non-modeling types are EXCLUDED. A
  // `PartDesign::Plane` also has a Shape .brp — the plane face — so the
  // generic rule imported it as a solid and the Body chain unioned the datum
  // plane into the part (a bare face cannot take part in the boolean). A
  // datum's shape is support geometry for attachment/up-to resolution.
  const shapeCarriers = new Set<string>();
  // E4: objects whose Shape/SubShape `file` attribute points at a missing or
  // ZERO-BYTE member (FC_site_simple-102: `Site.Shape.brp` exists but is 0
  // bytes). They must surface as an explicit convert-time gap — without this
  // the object falls through to python-opaque and the broken-asset fact is
  // silently swallowed into `python-baked` (the product then reports no
  // geometry instead of naming the defect).
  const brokenShapeAssets = new Set<string>();
  for (const obj of doc.value.objects) {
    if (isNonModelingType(obj.type)) continue;
    const shapeFile = obj.properties.get('Shape')?.children[0]?.attributes['file'];
    const subShapeFile = obj.properties.get('SubShape')?.children[0]?.attributes['file'];
    const shapeOk = shapeFile !== undefined && !!memberText(unpacked.value, shapeFile);
    const subShapeOk = subShapeFile !== undefined && !!memberText(unpacked.value, subShapeFile);
    if (shapeOk || subShapeOk) shapeCarriers.add(obj.name);
    else if (shapeFile !== undefined || subShapeFile !== undefined) brokenShapeAssets.add(obj.name);
  }

  // P8: parse the binary PropertyFilletEdges members for Part::Chamfer /
  // Part::Fillet objects (edge selection + sizes do NOT live in Document.xml).
  const filletEdgesData = new Map<string, FilletEdgeEntry[]>();
  for (const obj of doc.value.objects) {
    if (obj.type !== 'Part::Chamfer' && obj.type !== 'Part::Fillet') continue;
    const file = obj.properties.get('Edges')?.children[0]?.children[0]?.attributes['file']
      ?? obj.properties.get('Edges')?.children[0]?.attributes['file'];
    if (!file) continue;
    const parsed = parseFilletEdges(unpacked.value.members.get(file));
    if (parsed) filletEdgesData.set(obj.name, parsed);
  }

  // C1/C2/C4 (2026-09-28 plan): lift the document's leaf parameters BEFORE
  // codegen — the translator must know them to keep bound properties symbolic
  // (C3), and codegen emits them as `const p_*` headers in the modules that
  // reference them (C1). The table is injected as a module context exactly like
  // the existing docContext, because `translateObject`'s signature is shared by
  // the whole call graph.
  const paramTable = collectLeafParams(doc.value.objects, sketchParamCandidates);
  setParamContext(paramTable);
  // C2: rewrite each lifted sketch constraint's value to its parameter
  // reference. The canonical type declares `value?: number`; the reference is a
  // JsExpr that the M5 renderer emits verbatim, and the run-time `cad.sketch`
  // re-solves with the parameter's value — the geometry is identical to the
  // convert-time solve (the `const` default IS that value).
  for (const [sketch, lifted] of sketchConParamIdx) {
    const inputs = sketchInputs.get(sketch);
    if (!inputs) continue;
    for (const { idx, name } of lifted) {
      const p = paramTable.refName(sketch, 'Constraints', name);
      const c = inputs.constraints[idx];
      if (p === undefined || c === undefined) continue;
      (c as unknown as { value?: unknown }).value = jsExpr(p);
    }
  }

  let gen;
  try {
    // Pre-placed assets: skip cad.place ONLY when the .brp's embedded location
    // EQUALS the Document Placement (Section: embedded z=1500 == doc (0,0,1500)
    // → already placed once). When they differ (Section002: embedded
    // (1500,0,600) vs doc (0,600,1500)) the two compose — the place must still
    // be emitted, targeting the residual (doc − embedded) transform.
    // 2026-10-03 (FCBL_chair_upholstered): equality now covers ROTATION too —
    // the old check compared only the translation, so a pure-rotation embed
    // (90°X, zero translation) read as "no embedding" and the child asset was
    // `cad.place`-ed a second time (degenerate sheet → kernel fuse failure).
    const prePlacedAssets = new Set<string>();
    for (const obj of doc.value.objects) {
      if (!shapeCarriers.has(obj.name)) continue;
      const shapeFile = obj.properties.get('Shape')?.children[0]?.attributes['file']
        ?? obj.properties.get('SubShape')?.children[0]?.attributes['file'];
      if (!shapeFile) continue;
      const member = unpacked.value.members.get(shapeFile);
      if (!member) continue;
      const embedded = brpEmbeddedLocation(member);
      if (!embedded) continue; // identity/absent → normal place path
      const pl = placements?.get(obj.name);
      if (!pl) continue;
      // embedded rows are [r00 r01 r02 tx]; the placement quaternion gives the
      // same rotation matrix (row-major, 3×3) plus translation p.
      const m = quatToMatrix(pl.q);
      let equal = true;
      for (let r = 0; r < 3 && equal; r++) {
        for (let c = 0; c < 3; c++) {
          if (Math.abs(embedded[r]![c]! - m[r * 3 + c]!) > 1e-6) { equal = false; break; }
        }
        if (Math.abs(embedded[r]![3]! - pl.p[r]!) > 1e-6) equal = false;
      }
      if (equal) prePlacedAssets.add(obj.name);
    }
    gen = generateModel(
      doc.value, sketchVerdict, sketchContours, baseName, placements, shapeCarriers,
      brokenShapeAssets, filletEdgesData, prePlacedAssets, sketchInputs, draftDrawings,
      paramTable.list,
    );
  } catch (e) {
    return fail(`codegen failed: ${(e as Error).message}`);
  }

  // M2: container with shadow, then inject model/ + updated mapping
  const built = await buildFaiZip(
    unpacked.value,
    baseName + '.FCStd',
    // unified format v3: main aggregate + one model per Body (§5 Phase 3.2)
    [
      { id: 'main', entry: 'model/main.fai.js', label: baseName },
      ...gen.files.map((f) => ({ id: f.body, entry: f.path, label: f.body })),
    ],
  );
  if (built.error || !built.result) return fail(`container build failed: ${built.error ?? 'unknown'}`);
  const members: Record<string, Uint8Array> = {};
  for (const [k, v] of readZipEntries(built.result.zip)) members[k] = v;
  members['model/main.fai.js'] = new TextEncoder().encode(gen.code);
  for (const f of gen.files) members[f.path] = new TextEncoder().encode(f.code);

  const mapping = built.result.mapping;
  for (const o of gen.objects) {
    const entry = mapping.objects.find((e) => e.name === o.name);
    if (!entry) continue;
    entry.disposition = o.disposition;
    if (o.reason) entry.reason = o.reason;
    if (o.sketch) {
      entry.sketch = {
        level: o.sketch.level === 'L0' ? 'solved' : o.sketch.level === 'L1' ? 'initial-value' : 'baked',
        reason: o.sketch.reason,
        gcs: o.sketch,
      };
    }
    if (o.disposition === 'translated' && !entry.artifacts.includes('model/main.fai.js')) {
      entry.artifacts.push('model/main.fai.js');
    }
  }

  // M11.4 (G9): L1/L2 sketches persist raw geometry as a contour asset
  for (const obj of doc.value.objects) {
    if (obj.type !== 'Sketcher::SketchObject') continue;
    const verdict = sketchVerdict.get(obj.name);
    if (!verdict || verdict.level === 'L0') continue;
    const sk = parseSketchObject(obj.properties.get('Geometry'), obj.properties.get('Constraints'), false);
    const asset = {
      sketch: obj.name,
      level: verdict.level,
      reason: verdict.reason,
      geoms: sk.geoms,
      constraints: sk.constraints.map((c) => ({ index: c.index, type: c.type, refs: c.refs, value: c.value, isDriving: c.isDriving })),
    };
    const path = `assets/${obj.name}.contour.json`;
    members[path] = new TextEncoder().encode(JSON.stringify(asset, null, 2));
    const entry = mapping.objects.find((e) => e.name === obj.name);
    if (entry && !entry.artifacts.includes(path)) entry.artifacts.push(path);
  }

  // C4 (2026-09-28 plan): record every lifted leaf parameter with its source,
  // so a UI can list the drivable parameters without parsing the generated JS.
  if (paramTable.list.length > 0) {
    mapping.params = paramTable.list.map((p) => ({ name: p.name, source: p.source }));
  }

  // C4 final check: reclassify python-opaque; everything else baked = gap
  const gaps = auditMapping(mapping);
  members['mapping.json'] = new TextEncoder().encode(JSON.stringify(mapping, null, 2));

  const counts = { translated: 0, pythonBaked: 0, preservedOnly: 0, baked: 0 };
  const countsAny = counts as typeof counts & { skippedEmpty?: number };
  countsAny.skippedEmpty = 0;
  for (const o of mapping.objects) {
    const d = o.disposition as string; // auditMapping may rename baked -> python-baked
    if (d === 'translated') counts.translated++;
    else if (d === 'python-baked') counts.pythonBaked++;
    else if (d === 'preserved-only') counts.preservedOnly++;
    else if (d === 'skipped-empty') countsAny.skippedEmpty!++;
    else counts.baked++;
  }
  const sketches = { total: sketchVerdict.size, l0: 0, l1: 0, l2: 0 };
  for (const v of sketchVerdict.values()) sketches[v.level.toLowerCase() as 'l0' | 'l1' | 'l2']++;

  if (gaps.length > 0) {
    // C4: translation gaps → no container produced (exit contract: 2).
    // `keepGappedContainer` is a diagnostics-only escape hatch (see ConvertOptions).
    if (!opts?.keepGappedContainer) {
      return { file: input, ok: false, gaps, counts, sketches, elapsedMs: Date.now() - t0 };
    }
    const gappedZip = writeZipEntries(members);
    return { file: input, ok: false, gaps, counts, sketches, zip: gappedZip, elapsedMs: Date.now() - t0 };
  }

  const zip = writeZipEntries(members);
  return { file: input, ok: true, gaps, counts, sketches, zip, elapsedMs: Date.now() - t0 };
}

// Public conversion surface re-exports (former top-level `fcstd-convert` barrel).
// The batch project's tooling consumes these without reaching into `src/`.
export { createNodePlanegcsSolver as createPlanegcsSolver, planegcsWasmPath } from '@faicad/faijs-sketch/node';
export { classifySketch, maxPointDistance } from '@faicad/faijs-sketch';
export type { SketchVerdict } from '@faicad/faijs-sketch';

export { resolveExternalGeometry } from './external-geo.js';
export type { ExternalGeoResult, ExternalLink } from './external-geo.js';
export { isWhitelisted } from './feature-translate.js';
