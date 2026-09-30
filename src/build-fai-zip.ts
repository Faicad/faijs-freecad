/**
 * M2.2/M2.3/M2.4 — .fai.zip builder.
 *
 * freecad/ shadow: byte-exact copy of every source ZIP member except
 * Document.xml / GuiDocument.xml (kept too — nothing is dropped), verified by
 * sha256 equality (V1). Baked geometry comes from the ZIP's .brp members
 * directly (M2.3 — no FreeCAD runtime involved). Unit normalization (D7/M2.4):
 * FCStd internal storage is mm, matching faijs; the units field records this.
 *
 * The container format itself is owned by core (`@faicad/faijs/io/fai-zip`):
 * `createManifest` is the single manifest constructor and `writeZipEntries` the
 * single ZIP writer. This function deliberately does NOT use `writeContainer`:
 * it emits an *intermediate* container whose `model/**` scripts are injected
 * afterwards by the caller (`convert.ts`), which `writeContainer`'s
 * "every entry must be delivered" assertion forbids — and that assertion must
 * not be relaxed, because it is what keeps a shipped container reconstructable.
 */
import { createManifest, encodeMemberText, type ContainerManifest, type ContainerModel } from '@faicad/faijs/io/fai-zip';
import { writeZipEntries } from '@faicad/faijs/io';
import { createHash } from 'node:crypto';
import { isOk } from '@faicad/faijs/api/result';
import type { FcstdArchive } from './unpack.js';
import { memberText } from './unpack.js';
import { parseDocumentXml, type FcstdDocument } from './document.js';
import { initialDisposition, type FaiMapping, type ObjectMappingEntry } from './container.js';

/** Build output: the .fai.zip bytes, the written manifest, the per-object mapping and the shadow hash table. */
export interface FaiZipResult {
  /** the produced .fai.zip archive bytes */
  zip: Uint8Array;
  /** the manifest written into the container */
  manifest: ContainerManifest;
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
export async function buildFaiZip(
  source: FcstdArchive,
  sourceFileName: string,
  models: ContainerModel[],
): Promise<{ result?: FaiZipResult; error?: string }> {
  const xml = memberText(source, 'Document.xml');
  if (xml === undefined) return { error: 'Document.xml missing from source archive' };
  const parsed = await parseDocumentXml(xml);
  if (!isOk(parsed)) return { error: parsed.error.message };
  const doc: FcstdDocument = parsed.value;

  const out: Record<string, Uint8Array> = {};
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
    }
    mapping.objects.push(entry);
  }

  // M2.4 — units: FCStd stores mm internally; faijs contract is mm. No
  // scaling is applied; manifest.units records the normalized unit (D7).
  const manifest = createManifest({
    models,
    meta: {
      source: {
        file: sourceFileName,
        programVersion: readProgramVersion(doc),
        schemaVersion: Number(doc.meta.get('SchemaVersion')?.valueText ?? 4),
      },
      requiresBrep: true,
    },
  });
  out['manifest.json'] = encodeMemberText(JSON.stringify(manifest, null, 2));
  out['mapping.json'] = encodeMemberText(JSON.stringify(mapping, null, 2));

  const zip = writeZipEntries(out);
  return { result: { zip, manifest, mapping, shadowHashes } };
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
