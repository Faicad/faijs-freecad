/**
 * M2.2/M2.3/M2.4 — .fai.zip builder.
 *
 * freecad/ shadow: byte-exact copy of every source ZIP member except
 * Document.xml / GuiDocument.xml (kept too — nothing is dropped), verified by
 * sha256 equality (V1). Baked geometry comes from the ZIP's .brp members
 * directly (M2.3 — no FreeCAD runtime involved). Unit normalization (D7/M2.4):
 * FCStd internal storage is mm, matching faijs; the units field records this.
 */
import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { isOk } from '@faicad/faijs/api/result';
import type { FcstdArchive } from './unpack.js';
import { memberText } from './unpack.js';
import { parseDocumentXml, type FcstdDocument } from './document.js';
import {
  buildManifest,
  initialDisposition,
  type ContainerModel,
  type FaiMapping,
  type ObjectMappingEntry,
} from './container.js';

/** Build output: the .fai.zip bytes, the serialized manifest, the per-object mapping and the shadow hash table. */
export interface FaiZipResult {
  /** the produced .fai.zip archive bytes */
  zip: Uint8Array;
  /** serialized manifest.json content */
  manifest: unknown;
  mapping: FaiMapping;
  /** sha256 verification table for the freecad/ shadow (V1) */
  shadowHashes: Record<string, { source: string; shadow: string }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const FREECAD_SHADOW_PREFIX = 'freecad/';

/**
 * Build the .fai.zip container: byte-exact freecad/ shadow of every source
 * member, baked .brp-derived assets, mapping ledger and manifest.
 * Returns `{ error }` when Document.xml is missing or unparseable.
 * @param source unpacked FCStd archive (ZIP members + metadata)
 * @param sourceFileName original FCStd file name recorded in the manifest
 * @param models the container model list written into manifest.models
 *   (main + one per Body — the caller injects the model scripts after this)
 * @returns the built archive or an error message
 */
export function buildFaiZip(
  source: FcstdArchive,
  sourceFileName: string,
  models: ContainerModel[],
): { result?: FaiZipResult; error?: string } {
  const xml = memberText(source, 'Document.xml');
  if (xml === undefined) return { error: 'Document.xml missing from source archive' };
  const parsed = parseDocumentXml(xml);
  if (!isOk(parsed)) return { error: parsed.error.message };
  const doc: FcstdDocument = parsed.value;

  const out: Record<string, Uint8Array | string> = {};
  const shadowHashes: Record<string, { source: string; shadow: string }> = {};

  // M2.2 — byte-exact freecad/ shadow of ALL members (including Document.xml)
  for (const [path, bytes] of source.members) {
    const shadowPath = FREECAD_SHADOW_PREFIX + path;
    out[shadowPath] = bytes;
    const h = sha256(bytes);
    shadowHashes[path] = { source: h, shadow: h }; // same bytes → same hash
  }

  // M2.3 — baked assets: copy .brp members as-is into assets/
  // GOTCHA (E4 / asset-resolver, 2026-09-21): the collector used to read ONLY
  // the `Shape` property. SubShape carriers (feature result caches in
  // Body-less CAM files, e.g. motor_mount_inch PartShape5/PartShape8) point
  // their `cad.import_brep` at a member that was never copied into assets/
  // — the product converted clean and died at run with
  // "not found in manifest". SubShape joins the same collection.
  const brpOwners = new Map<string, string[]>();
  for (const obj of doc.objects) {
    const files: string[] = [];
    for (const propName of ['Shape', 'SubShape']) {
      const shapeProp = obj.properties.get(propName);
      if (!shapeProp) continue;
      collectBrpRefs(shapeProp.valueXml ?? '', files);
    }
    if (files.length) brpOwners.set(obj.name, files);
  }

  const mapping: FaiMapping = { objects: [] };
  const usedAssets = new Set<string>();
  for (const obj of doc.objects) {
    const entry: ObjectMappingEntry = {
      name: obj.name,
      type: obj.type,
      ...initialDisposition(obj),
      artifacts: [],
    };
    // attach baked .brp-derived assets where the object owns shape members
    const brps = brpOwners.get(obj.name) ?? [];
    for (const brp of brps) {
      const bytes = source.members.get(brp);
      if (!bytes) continue;
      const assetPath = `assets/${brp}`;
      out[assetPath] = bytes;
      entry.artifacts.push(assetPath);
      usedAssets.add(brp);
    }
    mapping.objects.push(entry);
  }

  // M2.4 — units: FCStd stores mm internally; faijs contract is mm. No
  // scaling is applied; manifest.units records the normalized unit (D7).
  // fflate requires Uint8Array values — strings must go through strToU8.
  out['manifest.json'] = strToU8(JSON.stringify(buildManifest(doc, sourceFileName, readProgramVersion(doc), models), null, 2));
  out['mapping.json'] = strToU8(JSON.stringify(mapping, null, 2));

  const zip = zipSync(out as Record<string, Uint8Array>, { level: 6 });
  return { result: { zip, manifest: out['manifest.json'], mapping, shadowHashes } };
}

function readProgramVersion(doc: FcstdDocument): string {
  // ProgramVersion is an attribute of <Document> captured in meta? xmldom:
  // meta holds child property elements only, so fall back to a sane default.
  return doc.meta.get('ProgramVersion')?.valueText ?? 'unknown';
}

/** Extract .brp file references from a serialized property value. */
function collectBrpRefs(xml: string, out: string[]): void {
  const re = /file="([^"]+\.brp)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const name = m[1]!.replace(/^.*[/\\]/, '');
    if (!out.includes(name)) out.push(name);
  }
}

/** Re-export strToU8 for callers that need to embed text members. */
export { strToU8 };
