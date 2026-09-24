/**
 * External-geometry resolution tests (synthetic; corpus-dependent cases live
 * in fcstd-port). GOTCHA (hole_puzzle corpus, 2026-09-20): external links
 * whose SOURCE is a PartDesign feature (Chamfer002/Pocket002…) store that
 * feature's shape in `SubShape`, not `Shape` — the shape-file lookup must
 * fall back or every external link fails with "source shape not loadable"
 * (misreported as "no links" by the sketch verdict).
 */
import { describe, it, expect } from 'vitest';
import { shapeBrpFile } from './external-geo.js';
import type { FcstdObject } from './document.js';

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
