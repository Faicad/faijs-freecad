/**
 * M2.1 — .fai.zip container schemas (manifest.json / mapping.json).
 *
 * Container layout (plan §2.1, 前文 A §6):
 *   manifest.json   — container manifest, entry point, units
 *   mapping.json    — per-object fidelity ledger; zero silent loss (R7)
 *   model/*.fai.js  — translated model scripts
 *   assets/*.step   — baked geometry fallback set
 *   freecad/*       — byte-exact shadow of the source ZIP members
 */
import type { FcstdDocument, FcstdObject } from './document.js';

/** manifest.json schema: source provenance, units and entry point for the .fai.zip container. */
export interface FaiManifest {
  /** container format version */
  format: 1;
  source: {
    /** original FCStd file name (not full path) */
    file: string;
    programVersion: string;
    schemaVersion: number;
  };
  /** unit normalization applied to all coordinates (D7); always "mm" */
  units: 'mm';
  /** D-A: FCStd port output is BREP-chain-only (sketch/extrude/... are brep
   * impls without mesh); execution must use `--mode brep`. */
  requiresBrep: true;
  /** entry script inside model/ */
  entry: string;
}

/**
 * Per-object fidelity ledger. Every <ObjectData> object must have exactly one
 * disposition: translated | baked | preserved-only (V3 zero-silent-loss).
 */
export type ObjectDisposition = 'translated' | 'baked' | 'preserved-only';

/** One mapping.json entry: a single object's fidelity disposition, reason and produced artifacts. */
export interface ObjectMappingEntry {
  /** FCStd object name */
  name: string;
  type: string;
  disposition: ObjectDisposition;
  /** why not translated (required when disposition !== 'translated') */
  reason?: string;
  /** produced artifacts, container-relative paths */
  artifacts: string[];
  /** M3 sketch fidelity level (D3) */
  sketch?: {
    level: 'solved' | 'initial-value' | 'baked';
    reason?: string;
    /** GCS primitives for future editable-sketch upgrade (D1) */
    gcs?: unknown;
  };
}

/** mapping.json schema: the per-object fidelity ledger (zero silent loss, V3). */
export interface FaiMapping {
  /** one entry per <ObjectData> object */
  objects: ObjectMappingEntry[];
}

/**
 * Assemble the container manifest.json from the parsed document.
 * @param doc parsed FCStd document (SchemaVersion read from meta)
 * @param sourceFile original FCStd file name (not full path)
 * @param programVersion FreeCAD program version that wrote the document
 * @returns the manifest with format 1, mm units and the BREP-chain entry point
 */
export function buildManifest(
  doc: FcstdDocument,
  sourceFile: string,
  programVersion: string,
): FaiManifest {
  return {
    format: 1,
    source: {
      file: sourceFile,
      programVersion,
      schemaVersion: Number(doc.meta.get('SchemaVersion')?.valueText ?? 4),
    },
    units: 'mm',
    requiresBrep: true,
    entry: 'model/main.fai.js',
  };
}

/**
 * Default disposition for an object type before feature translation (M4).
 * @param obj the FCStd object to classify
 * @returns `baked` for sketches and non-datum objects, `preserved-only` for datum types
 */
export function initialDisposition(obj: FcstdObject): { disposition: ObjectDisposition; reason?: string } {
  if (obj.type === 'Sketcher::SketchObject') {
    return { disposition: 'baked', reason: 'pending-sketch-channel' };
  }
  if (obj.type === 'App::Origin' || obj.type === 'App::Plane' || obj.type === 'App::Line') {
    return { disposition: 'preserved-only', reason: 'datum' };
  }
  // M2 stage: everything non-datum is baked from the ZIP's .brp members
  return { disposition: 'baked', reason: 'feature-translation-pending' };
}
