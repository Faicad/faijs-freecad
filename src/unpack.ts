/**
 * M1.1 — FCStd container unpacking.
 *
 * Validation rules per plan §5.5.6 (corrected): a file is an FCStd iff it opens
 * as a ZIP and contains `Document.xml` at its root. The ZIP comment is advisory
 * only and must never cause rejection.
 *
 * faijs contract: unit mm, errors via Result (ok/err).
 */
import { readZipEntries } from '@faicad/faijs/io/zip';
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
  let entries: Map<string, Uint8Array>;
  try {
    entries = readZipEntries(data);
  } catch (e) {
    return err({
      kind: 'not-zip',
      message: `cannot open as ZIP: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!entries.has('Document.xml')) {
    return err({ kind: 'no-document-xml', message: 'root Document.xml not found in ZIP' });
  }
  // readZipEntries filters directory entries; the ZIP comment is advisory only
  // and must never cause rejection (fflate does not expose it through the read
  // entry either, so we read the EOCD record directly).
  const comment = readZipComment(data) ?? '';
  return ok({ members: entries, zipComment: comment });
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
 * Extract the transform embedded in the .brp's FIRST location block, or
 * null when the block is absent/identity.
 *
 * GOTCHA (2026-09-26, Beds.FCStd): the embedded location is NOT always the
 * Document Placement — `Section.Shape.brp` embeds z=1500 == its Placement
 * (truly pre-placed), but `Section002.Shape.brp` embeds (1500,0,600) while
 * the Document Placement is (0,600,1500): the two compose, they do NOT
 * coincide. The skip-place predicate must therefore compare embedded vs
 * Document translation, not merely "has any embedding".
 *
 * GOTCHA (2026-10-03, FCBL_chair_upholstered): the old version returned the
 * translation ONLY and treated a zero translation as identity — a pure
 * ROTATION embedding (90°X, tx=ty=tz=0) was reported as `null`, the
 * pre-placed skip never fired, and the child asset got `cad.place`-ed a
 * second time (the extrude direction then lay IN the profile plane →
 * degenerate zero-volume sheet → downstream kernel fuse failure). The
 * return is now the full transform (rotation rows + translation); identity
 * means BOTH rotation and translation are identity.
 *
 * @param data - the raw `.brp` member bytes.
 * @returns the embedded 3×4 transform (3 matrix rows of 'r00 r01 r02 tx'),
 *   or null when identity/absent.
 */
export function brpEmbeddedLocation(data: Uint8Array): [[number, number, number, number], [number, number, number, number], [number, number, number, number]] | null {
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
  const rows: [[number, number, number, number], [number, number, number, number], [number, number, number, number]] = [
    [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0],
  ];
  let i = 2;
  for (let r = 0; r < 3 && i < lines.length; r++, i++) {
    const v = lines[i]!.trim().split(/\s+/).map(Number);
    if (v.length < 4) return null;
    rows[r] = [v[0]!, v[1]!, v[2]!, v[3]!];
  }
  // identity ⇒ null (caller falls back to the normal place path)
  const expect: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(rows[r]![c]! - expect[r]![c]!) > 1e-9) return rows;
    }
  }
  if (Math.abs(rows[0]![3]!) > 1e-9 || Math.abs(rows[1]![3]!) > 1e-9 || Math.abs(rows[2]![3]!) > 1e-9) return rows;
  return null;
}
