/**
 * M2.1 — .fai.zip container schemas (manifest.json / mapping.json).
 *
 * Container layout (docs/fai-zip-format.md, unified format v3):
 *   manifest.json   — container manifest, units, models[], active
 *   mapping.json    — per-object fidelity ledger; zero silent loss (R7)
 *   model/*.fai.js  — translated model scripts (main + one per Body)
 *   assets/*.brp    — baked BREP carriers
 *   freecad/*       — byte-exact shadow of the source ZIP members
 */
import type { FcstdDocument, FcstdObject } from './document.js';

/** One model in the container: entry script (+ optional data member). */
export interface ContainerModel {
  /** model identifier: unique in the container, stable (switch/data key) */
  id: string;
  /** container path of the model's entry script, inside model/ */
  entry: string;
  /** display name; never used as an identifier */
  label?: string;
  /** container path of the model's data member; absent = no data member */
  data?: string;
}

/** manifest.json schema (unified .fai.zip format v3, docs/fai-zip-format.md §4). */
export interface ContainerManifest {
  /** container format identifier — MUST be 3 in this revision */
  format: 3;
  /** unit normalization applied to all coordinates; always "mm" */
  units: 'mm';
  /** complete model list (length ≥ 1) */
  models: ContainerModel[];
  /** id of the initially active model; absent = models[0] */
  active?: string;
  /** ISO 8601 timestamp. Display only */
  createdAt?: string;
  /** version of the producing tool. Display only */
  appVersion?: string;
  /** container display name. Display only */
  label?: string;
  /** FCStd conversion provenance. Display only */
  source?: {
    /** original FCStd file name (not full path) */
    file: string;
    programVersion: string;
    schemaVersion: number;
  };
  /** the model graph requires the BREP chain (fcstd: brep-only output) */
  requiresBrep?: boolean;
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
 * @param models the container model list (main + one per Body, §5 Phase 3.2)
 * @returns the manifest with format 3, mm units and the model list
 */
export function buildManifest(
  doc: FcstdDocument,
  sourceFile: string,
  programVersion: string,
  models: ContainerModel[],
): ContainerManifest {
  return {
    format: 3,
    source: {
      file: sourceFile,
      programVersion,
      schemaVersion: Number(doc.meta.get('SchemaVersion')?.valueText ?? 4),
    },
    units: 'mm',
    requiresBrep: true,
    models,
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
