/**
 * FCStd fidelity ledger schema (`mapping.json`, docs/fai-zip-format.md §8.2).
 *
 * `mapping.json` is a convention of **this producer**, not part of the `.fai.zip`
 * format: the container itself — `manifest.json`, `models[]`, assets and the
 * read/write API — belongs to the format and lives in core
 * (`@faicad/faijs/io/fai-zip`). What stays here is the per-object accounting a
 * conversion must produce so that nothing is lost silently (V3).
 */
import type { FcstdObject } from './document.js';

/**
 * Per-object fidelity ledger. Every `<ObjectData>` object must have exactly one
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

/** One lifted leaf parameter, recorded so a UI can list what it may re-drive (C4). */
export interface ParamMappingEntry {
  /** emitted `const` identifier (`p_`-prefixed, deduped) */
  name: string;
  /** provenance: which FCStd leaf this came from, e.g. `Spreadsheet::Sheet.Alias:Data.width` */
  source: string;
}

/** mapping.json schema: the per-object fidelity ledger (zero silent loss, V3). */
export interface FaiMapping {
  /** one entry per <ObjectData> object */
  objects: ObjectMappingEntry[];
  /**
   * C1/C2/C4 (2026-09-28 plan): the lifted leaf parameters, in `const` emission
   * order. Omitted when the document has none.
   */
  params?: ParamMappingEntry[];
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
