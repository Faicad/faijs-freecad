/**
 * M1.1 — FCStd container unpacking.
 *
 * Validation rules per plan §5.5.6 (corrected): a file is an FCStd iff it opens
 * as a ZIP and contains `Document.xml` at its root. The ZIP comment is advisory
 * only and must never cause rejection.
 *
 * faijs contract: unit mm, errors via Result (ok/err).
 */
import { unzipSync } from 'fflate';
import { err, ok, type Result } from '@faicad/faijs/api/result';

/**
 * One raw file inside the FCStd ZIP container.
 */
export interface FcstdMember {
  /** path inside the ZIP, e.g. "Document.xml", "PartShape.brp" */
  path: string;
  /** the member's raw bytes */
  bytes: Uint8Array;
}

/**
 * The unpacked FCStd container: all ZIP members plus the advisory comment.
 */
export interface FcstdArchive {
  members: Map<string, Uint8Array>;
  /** advisory ZIP comment; may be empty (2/56 samples have empty comments) */
  zipComment: string;
}

/**
 * Structured unpack failure: not a valid ZIP, or missing root `Document.xml`.
 */
export type UnpackError =
  | { kind: 'not-zip'; message: string }
  | { kind: 'no-document-xml'; message: string };

/**
 * Unpack an FCStd file. Only requirement: valid ZIP + root `Document.xml`.
 *
 * @param data - the raw FCStd file bytes.
 * @returns the unpacked archive, or a structured UnpackError.
 */
export function unpackFcstd(data: Uint8Array): Result<FcstdArchive, UnpackError> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch (e) {
    return err({
      kind: 'not-zip',
      message: `cannot open as ZIP: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!('Document.xml' in entries)) {
    return err({ kind: 'no-document-xml', message: 'root Document.xml not found in ZIP' });
  }
  // fflate does not expose the raw ZIP comment through unzipSync; read it
  // directly from the EOCD record (22 bytes from end when comment is empty,
  // else longer). Advisory only — never used for validation.
  const comment = readZipComment(data) ?? '';
  return ok({ members: new Map(Object.entries(entries)), zipComment: comment });
}

function readZipComment(data: Uint8Array): string | null {
  // scan for EOCD signature 0x06054b50 from the end
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (
      data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06
    ) {
      const len = data[i + 20]! | (data[i + 21]! << 8);
      const start = i + 22;
      if (start + len > data.length) return null;
      return new TextDecoder('latin1').decode(data.subarray(start, start + len));
    }
  }
  return null;
}

/**
 * UTF-8 text decode helper for XML members.
 *
 * @param archive - the unpacked FCStd container.
 * @param path - member path inside the ZIP, e.g. "Document.xml".
 * @returns the member decoded as UTF-8 text, or undefined when absent.
 */
export function memberText(archive: FcstdArchive, path: string): string | undefined {
  const bytes = archive.members.get(path);
  if (!bytes) return undefined;
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Detect whether a `.brp` (CASCADE Topology) member embeds a non-identity
 * `Locations` transform in its header.
 *
 * GOTCHA (2026-09-26, Beds.FCStd vs TO92): FreeCAD writes the Placement into
 * the .brp's `Locations` block for SOME objects only — within Beds itself,
 * `Section.Shape.brp` embeds z=1500 (pre-placed) while `Section002.Shape.brp`
 * embeds it too but `read_brep_member`'s raw bbox stays local-frame... the two
 * conventions coexist in ONE document. Re-emitting `cad.place` on top of an
 * embedded location double-applies it (Section landed at z=3000, truth 1500);
 * skipping it for local-frame assets leaves them at the origin (old H13 bug).
 *
 * The discriminator is the header itself: the block after `Locations N` starts
 * with a count line, then `r00 r01 r02 tx` per row. A translation-only
 * embedded location shows a non-zero 4th column on the last row. Rows of
 * `1 0 0 0 / 0 1 0 0 / 0 0 1 0` mean identity (not embedded).
 *
 * @param data - the raw `.brp` member bytes.
 * @returns true when a non-identity location transform is embedded.
 */
export function brpHasEmbeddedLocation(data: Uint8Array): boolean {
  return brpEmbeddedLocation(data) !== null;
}

/**
 * Extract the translation embedded in the .brp's FIRST location block, or
 * null when the block is absent/identity.
 *
 * GOTCHA (2026-09-26, Beds.FCStd): the embedded location is NOT always the
 * Document Placement — `Section.Shape.brp` embeds z=1500 == its Placement
 * (truly pre-placed), but `Section002.Shape.brp` embeds (1500,0,600) while
 * the Document Placement is (0,600,1500): the two compose, they do NOT
 * coincide. The skip-place predicate must therefore compare embedded vs
 * Document translation, not merely "has any embedding".
 *
 * @param data - the raw `.brp` member bytes.
 * @returns [tx, ty, tz] of the embedded location, or null when identity/absent.
 */
export function brpEmbeddedLocation(data: Uint8Array): [number, number, number] | null {
  // .brp members are ASCII (CASCADE Topology V1 text format)
  const head = new TextDecoder('utf-8').decode(data.slice(0, 4096));
  const li = head.indexOf('Locations');
  if (li === -1) return null;
  const lines = head.slice(li).split(/\r?\n/);
  // lines[0] = 'Locations K' (K location blocks); lines[1] = K.
  // Each block: '<rowcount>' (always 3) then 3 matrix rows of
  // 'r00 r01 r02 tx'. Identity = all rows canonical, tx=0.
  const count = Number(lines[1]);
  if (!Number.isFinite(count) || count < 1) return null;
  // GOTCHA: no rowcount line — after the block count, 3 matrix rows follow
  // directly ('r00 r01 r02 tx' per line), then the next section (Curve2ds…).
  let tx = 0, ty = 0, tz = 0;
  let i = 2;
  for (let r = 0; r < 3 && i < lines.length; r++, i++) {
    const v = lines[i]!.trim().split(/\s+/).map(Number);
    if (v.length < 4) return null;
    const [r0, r1, r2, t] = v as [number, number, number, number];
    const expect = r === 0 ? [1, 0, 0] : r === 1 ? [0, 1, 0] : [0, 0, 1];
    if (Math.abs(r0 - expect[0]!) > 1e-9 || Math.abs(r1 - expect[1]!) > 1e-9 ||
        Math.abs(r2 - expect[2]!) > 1e-9) {
      // rotation embedded — non-identity by definition
      if (r === 0) tx = t; else if (r === 1) ty = t; else tz = t;
      // rotation rows carry the translation in the 4th column per row; keep
      // scanning — the composite translation is spread across rows
    } else if (r === 0) tx = t;
    else if (r === 1) ty = t;
    else tz = t;
  }
  if (Math.abs(tx) < 1e-9 && Math.abs(ty) < 1e-9 && Math.abs(tz) < 1e-9) return null;
  return [tx, ty, tz];
}
