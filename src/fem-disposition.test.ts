/**
 * H7 companion (2026-09-20): FEM workbench objects are simulation semantics,
 * not modeling geometry. They must land in a structured non-modeling
 * disposition (preserved-only) instead of `type-not-whitelisted` gaps that
 * block the whole file — the modeling part of e.g. box_static.FCStd is just
 * a Part::Box + material.
 *
 * Corpus facts (probe, 2026-09-20):
 * - Python subclasses (FemAnalysisPython / FemMeshObjectPython /
 *   FemSolverObjectPython / FemMeshShapeBaseObjectPython / FemResultObjectPython
 *   / Fem::FeaturePython) carry Proxy → already handled by H10 (python-opaque).
 * - Native classes WITHOUT Proxy used to gap: Fem::FemMeshObject,
 *   Fem::ConstraintFixed/Force/Pressure/Contact/Bearing/Displacement,
 *   Fem::FemResultObject, Fem::FemPostPipeline and the post-processing filters.
 * - FemMesh/result field data (FemMesh / Data properties) is large derived
 *   data: NOT copied into the container (regenerable from the shape).
 *
 * 2026-09-21: the explicit type list was replaced by a NAMESPACE rule
 * (`Fem::` prefix) — see `isFemStructural`. Four rounds of "add the types the
 * sweep surfaced" kept uncovering the next layer, so the census (not the list)
 * is what this suite pins.
 *
 * Remote task on record (user, 2026-09-20): faijs will eventually port
 * FreeCAD's FEM analysis capability — that is a separate future feature; this
 * change only stops FEM objects from blocking conversion.
 */
import { describe, it, expect } from 'vitest';
import { isFemStructural, STRUCTURAL_TYPES, STRUCTURAL_TYPES_EXTENDED } from './convert.js';

describe('H7-FEM: simulation objects are structured non-modeling, not gaps', () => {
  it('GOTCHA: native FEM classes WITHOUT Proxy are the gap source — all must be recognized', () => {
    for (const t of [
      'Fem::FemMeshObject',
      'Fem::FemResultObject',
      'Fem::ConstraintFixed',
      'Fem::ConstraintForce',
      'Fem::ConstraintPressure',
      'Fem::ConstraintContact',
      'Fem::ConstraintBearing',
      'Fem::ConstraintDisplacement',
      'Fem::FemPostPipeline',
    ]) {
      expect(isFemStructural(t), t).toBe(true);
    }
  });

  it('does not over-match: non-FEM types stay unrecognized', () => {
    expect(isFemStructural('Part::Box')).toBe(false);
    expect(isFemStructural('PartDesign::Pad')).toBe(false);
    expect(isFemStructural('Fem::FemAnalysis')).toBe(true); // container too
    // Python subclasses carry Proxy → H10 python-opaque takes them; the
    // namespace rule also covers them, but they must never fall into
    // type-not-whitelisted
    expect(isFemStructural('Fem::FemMeshObjectPython')).toBe(true);
  });

  // 2026-09-21: the rule is the NAMESPACE (`Fem::`), not an enumerated list —
  // four whack-a-mole rounds proved an explicit list always trails the corpus.
  // This test pins the CENSUS instead: every `Fem::` type the 56-sample corpus
  // contains (fcstd-port `out/probe-fem-types.mjs`) must be recognized, and
  // the three that were still blocking `all_objects` when the list was dropped
  // are called out explicitly (regression: they were the 4th round).
  it('census: every Fem:: type in the 56-sample corpus is recognized', () => {
    const census = [
      'Fem::FeaturePython',
      'Fem::FemSolverObjectPython',
      'Fem::FemResultObjectPython',
      'Fem::ConstraintFixed',
      'Fem::ConstraintForce',
      'Fem::FemMeshObjectPython',
      'Fem::FemAnalysis',
      'Fem::ConstraintPython',
      'Fem::FemMeshObject',
      'Fem::ConstraintPressure',
      'Fem::FemPostPipeline',
      'Fem::FemPostWarpVectorFilter',
      'Fem::FemAnalysisPython',
      'Fem::FemMeshShapeBaseObjectPython',
      'Fem::ConstraintContact',
      'Fem::ConstraintDisplacement',
      'Fem::FemPostClipFilter',
      'Fem::FemResultObject',
      'Fem::ConstraintBearing',
      'Fem::ConstraintFluidBoundary',
      'Fem::ConstraintGear',
      'Fem::ConstraintHeatflux',
      'Fem::ConstraintInitialTemperature',
      'Fem::ConstraintPlaneRotation',
      'Fem::ConstraintPulley',
      'Fem::ConstraintTemperature',
      'Fem::ConstraintTransform',
      'Fem::FemMeshShapeNetgenObject',
      'Fem::FemPostScalarClipFilter',
    ];
    for (const t of census) expect(isFemStructural(t), t).toBe(true);
    // the last three were the ones still gapping when the enumerated list was
    // replaced by the namespace rule
    for (const t of ['Fem::FemPostClipFilter', 'Fem::FemPostScalarClipFilter', 'Fem::FemMeshShapeNetgenObject']) {
      expect(isFemStructural(t), t).toBe(true);
    }
  });
});

describe('2026-09-20 triage: assembly/import container types are structured non-modeling', () => {
  it('GOTCHA: App::Link, Assembly containers, import placeholders → preserved-only, never gaps', () => {
    // AssemblyExample (Assembly::AssemblyObject + JointGroup + App::Link),
    // ProjectTest (App::InventorObject), TestVRMLTextures (App::VRMLObject).
    // Containers/links/import placeholders produce no geometry; they must
    // not block files whose modeling content converts fine.
    for (const t of [
      'App::Link',
      'App::LinkElement',
      'Assembly::AssemblyObject',
      'Assembly::JointGroup',
      'App::InventorObject',
      'App::VRMLObject',
    ]) {
      expect(STRUCTURAL_TYPES_EXTENDED.has(t), t).toBe(true);
    }
    // modeling features must NOT be captured
    expect(STRUCTURAL_TYPES_EXTENDED.has('Part::Mirroring')).toBe(false);
    expect(STRUCTURAL_TYPES_EXTENDED.has('PartDesign::AdditiveSphere')).toBe(false);
  });
});

describe('2026-09-21 triage: TechDraw drawing objects are non-modeling documentation', () => {
  it('GOTCHA (ArchDetail): page / SVG template / projected view → preserved-only', () => {
    // These three were the LAST blockers of ArchDetail.FCStd once the
    // Part::Compound member ordering was fixed. They are the 2D drawing
    // workbench's output layer: a sheet, its SVG template, and a projected
    // view of some source shape. None carries a Shape .brp (unlike every
    // modeling object in the file), so there is nothing to translate — same
    // category as App::TextDocument / App::Annotation.
    for (const t of [
      'TechDraw::DrawPage',
      'TechDraw::DrawSVGTemplate',
      'TechDraw::DrawViewDraft',
    ]) {
      expect(STRUCTURAL_TYPES.has(t), t).toBe(true);
    }
    // The 3D content a view projects is translated through the referenced
    // object, NOT through the view — so real modeling types must stay out of
    // the structural set.
    expect(STRUCTURAL_TYPES.has('Part::Mirroring')).toBe(false);
    expect(STRUCTURAL_TYPES.has('PartDesign::AdditiveSphere')).toBe(false);
    expect(STRUCTURAL_TYPES.has('Part::Revolution')).toBe(false);
  });
});
