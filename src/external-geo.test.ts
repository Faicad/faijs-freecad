/**
 * External-geometry resolution tests (synthetic; corpus-dependent cases live
 * in fcstd-port). GOTCHA (hole_puzzle corpus, 2026-09-20): external links
 * whose SOURCE is a PartDesign feature (Chamfer002/Pocket002…) store that
 * feature's shape in `SubShape`, not `Shape` — the shape-file lookup must
 * fall back or every external link fails with "source shape not loadable"
 * (misreported as "no links" by the sketch verdict).
 *
 * GOTCHA (corner corpus, 2026-09-28): a link may name a `VertexN` (not only an
 * `EdgeN`). Vertices resolve to a SINGLE sketch-local point and must keep their
 * SOURCE index in the ExternalGeometry list, because the solver addresses them
 * as geoId `-3 - linkIndex`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';
import { shapeBrpFile, resolveExternalGeometry } from './external-geo.js';
import type { FcstdArchive } from './unpack.js';
import type { FcstdDocument, FcstdObject, FcstdProperty } from './document.js';

function obj(name: string, props: Record<string, string>): FcstdObject {
  const properties = new Map(
    Object.entries(props).map(([k, file]) => [
      k,
      {
        name: k, type: '', tagName: 'Property',
        children: [{ name: 'Part', type: '', tagName: 'Part', children: [], valueXml: '', valueText: '', attributes: { file } }],
        valueXml: '', valueText: '', attributes: {},
      } as never,
    ]),
  );
  return { type: 'PartDesign::Feature', name, properties };
}

describe('external-geo shape-file lookup', () => {
  it('prefers the Shape property when present', () => {
    const o = obj('Pad', { Shape: 'PartShape1.brp', SubShape: 'PartShape2.brp' });
    expect(shapeBrpFile(o)).toBe('PartShape1.brp');
  });

  it('GOTCHA (hole_puzzle): falls back to SubShape for PartDesign features whose result cache is the only shape', () => {
    const o = obj('Chamfer002', { SubShape: 'PartShape5.brp' });
    expect(shapeBrpFile(o)).toBe('PartShape5.brp');
  });

  it('returns undefined when neither property carries a file', () => {
    expect(shapeBrpFile(obj('Empty', {}))).toBeUndefined();
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const BOSS_BRP = join(here, '..', '..', 'fixtures', 'data', 'brp', 'boss-solid.brp');

/** Minimal FcstdProperty factory (attributes on the node itself). */
function node(name: string, children: FcstdProperty[] = [], attributes: Record<string, string> = {}): FcstdProperty {
  return { name, type: '', tagName: name, children, valueXml: '', valueText: '', attributes };
}

/** `<ExternalGeometry>` with one `<Link obj=… sub=…>` per entry, in list order. */
function extGeoProp(links: { obj: string; sub: string }[]): FcstdProperty {
  return node('ExternalGeometry', [node('LinkList', links.map((l) => node('Link', [], { obj: l.obj, sub: l.sub })))]);
}

/** Identity sketch Placement (Px..Pz = 0, Q0..Q3 = 0,0,0,1). */
function identityPlacement(): FcstdProperty {
  return node('Placement', [node('Placement', [], { Px: '0', Py: '0', Pz: '0', Q0: '0', Q1: '0', Q2: '0', Q3: '1' })]);
}

describe('external-geo Vertex links', () => {
  const archive: FcstdArchive = {
    members: new Map([['PartShape1.brp', new Uint8Array(readFileSync(BOSS_BRP))]]),
    zipComment: '',
  };
  const doc: FcstdDocument = {
    objects: [
      {
        name: 'Src',
        type: 'PartDesign::Pad',
        properties: new Map([['Shape', node('Shape', [node('Part', [], { file: 'PartShape1.brp' })])]]),
      },
    ],
    typeIndex: new Map(),
    meta: new Map(),
  };

  beforeAll(async () => {
    await initOcctWasm();
  });

  // boss-solid.brp vertex order, measured through the same kernel (probe-boss.mjs).
  const V1 = [5694.288319240878, 10417.725083368045];
  const V2 = [3694.288319240878, 10417.725083368045];

  it('resolves a VertexN link to a single sketch-local point', async () => {
    const res = await resolveExternalGeometry(
      extGeoProp([{ obj: 'Src', sub: 'Vertex1' }]), doc, archive, identityPlacement(),
    );
    expect(res.failures).toEqual([]);
    expect(res.links).toHaveLength(1);
    expect(res.links[0]!.polyline).toHaveLength(1);
    expect(res.links[0]!.polyline[0]![0]).toBeCloseTo(V1[0]!, 3);
    expect(res.links[0]!.polyline[0]![1]).toBeCloseTo(V1[1]!, 3);
  });

  it('ordinals are 1-based — Vertex2 is a different vertex than Vertex1', async () => {
    const res = await resolveExternalGeometry(
      extGeoProp([{ obj: 'Src', sub: 'Vertex2' }]), doc, archive, identityPlacement(),
    );
    expect(res.links[0]!.polyline[0]![0]).toBeCloseTo(V2[0]!, 3);
  });

  it('GOTCHA: linkIndex keeps SOURCE order, so an unresolvable link does not shift later geoIds', async () => {
    // `Face1` is not supported; FreeCAD still keeps slot -3 for it, so the
    // vertex must report linkIndex 1 (geoId -4), never 0. Deriving the geoId
    // from the filtered position shifted every later ref onto a non-existent
    // external and the solver dropped those constraints with no record.
    const res = await resolveExternalGeometry(
      extGeoProp([{ obj: 'Src', sub: 'Face1' }, { obj: 'Src', sub: 'Vertex1' }]),
      doc, archive, identityPlacement(),
    );
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.reason).toContain('unsupported sub-element');
    expect(res.links).toHaveLength(1);
    expect(res.links[0]!.linkIndex).toBe(1);
  });

  it('records an out-of-range vertex ordinal as a failure instead of throwing', async () => {
    const res = await resolveExternalGeometry(
      extGeoProp([{ obj: 'Src', sub: 'Vertex99' }]), doc, archive, identityPlacement(),
    );
    expect(res.links).toEqual([]);
    expect(res.failures[0]!.reason).toContain('out of range');
  });
});
