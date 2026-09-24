/**
 * P8 — Part::PropertyFilletEdges binary parser (Part::Chamfer / Part::Fillet).
 *
 * GOTCHA: the chamfer size and edge selection do NOT live in Document.xml —
 * the `Edges` property serializes as `<FilletEdges file="EdgesN"/>` pointing
 * at a raw binary ZIP member: int32 entryCount, then per entry
 * { int32 edgeOrdinal (1-based, matches LinkSub "EdgeN"), float64 size1,
 * float64 size2 } — 20 bytes per entry. Reading XML attributes for the size
 * yields nothing; the binary member is the only source.
 */

/** One entry of the FilletEdges binary: an edge ordinal and its two sizes. */
export interface FilletEdgeEntry {
  /** 1-based edge ordinal (FreeCAD `EdgeN`) */
  edge: number
  size1: number
  size2: number
}

/**
 * Parse a PropertyFilletEdges binary member.
 *
 * @param data - the raw ZIP member bytes, or undefined when missing.
 * @returns the parsed entries, or undefined when the data is absent/truncated
 *   (caller surfaces an explicit gap — no silent loss).
 */
export function parseFilletEdges(data: Uint8Array | undefined): FilletEdgeEntry[] | undefined {
  if (!data || data.length < 4) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getInt32(0, true);
  if (count < 0 || 4 + count * 20 > data.length) return undefined;
  const out: FilletEdgeEntry[] = [];
  for (let k = 0; k < count; k++) {
    const off = 4 + k * 20;
    out.push({
      edge: view.getInt32(off, true),
      size1: view.getFloat64(off + 4, true),
      size2: view.getFloat64(off + 12, true),
    });
  }
  return out;
}
