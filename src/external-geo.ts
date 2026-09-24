/**
 * M6.3 — external geometry resolution: decode ExternalGeometry links
 * (App::PropertyLinkSubList), load the source object's .brp via OCCT,
 * extract the named edge polyline (TopExp::MapShapes + IndexedMap order —
 * Edge13 = wireframe edgeGroups[12], verified against hole_puzzle.fcstd),
 * and project it into sketch-local 2D via the sketch Placement inverse.
 *
 * Result: fixed 2D segments/points that the solver treats as immutable
 * constraints targets (geoId -3, -4, ... in link order).
 */
import { initOcctWasm } from '@faicad/faijs/occt-kernel/occtKernel';
import { memberText, type FcstdArchive } from './unpack.js';
import type { FcstdDocument, FcstdObject, FcstdProperty } from './document.js';

/**
 * One resolved external-geometry link of a sketch.
 */
export interface ExternalLink {
  /** source object name, e.g. "Chamfer002" */
  obj: string;
  /** sub-element name, e.g. "Edge13" */
  sub: string;
  /** resolved sketch-local 2D polyline */
  polyline: [number, number][];
}

/**
 * Result of external-geometry resolution: successfully projected links plus
 * per-link failures (with a human-readable reason) for the caller to report.
 */
export interface ExternalGeoResult {
  links: ExternalLink[];
  failures: { obj: string; sub: string; reason: string }[];
}

/** Quaternion (x,y,z,w) inverse-rotate + translate into sketch-local frame. */
function makeInverseTransformer(q: [number, number, number, number], p: [number, number, number]) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  const [qx, qy, qz, qw] = [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n]; // conjugate
  return (w: [number, number, number]): [number, number, number] => {
    // local = R⁻¹ · (world − P): subtract the translation FIRST, then rotate
    // by the conjugate quaternion. GOTCHA (probe-hole-ext.ts): rotating first
    // and subtracting after (R⁻¹·v − P) is only correct for identity rotation
    // — with Sketch005's 90° placement it shifted projected points by the
    // rotated translation (−140,30 instead of (−40,40)) and the solver chased
    // the wrong frame (delta 1.0e2).
    const [vx, vy, vz] = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    const rx = vx + qw * tx + (qy * tz - qz * ty);
    const ry = vy + qw * ty + (qz * tx - qx * tz);
    const rz = vz + qw * tz + (qx * ty - qy * tx);
    return [rx, ry, rz];
  };
}

function placementOf(obj: FcstdObject): { q: [number, number, number, number]; p: [number, number, number] } {
  const el = obj.properties.get('Placement')?.children[0];
  const a = el?.attributes ?? {};
  return {
    p: [Number(a['Px'] ?? 0), Number(a['Py'] ?? 0), Number(a['Pz'] ?? 0)],
    q: [Number(a['Q0'] ?? 0), Number(a['Q1'] ?? 0), Number(a['Q2'] ?? 0), Number(a['Q3'] ?? 1)],
  };
}

/**
 * The `.brp` member holding an object's shape: the `Shape` property when
 * present, else `SubShape` (GOTCHA, hole_puzzle corpus 2026-09-20: PartDesign
 * features like Chamfer002/Pocket002 store their result cache in SubShape and
 * have NO Shape property — external links pointing at them failed with
 * "source shape not loadable" before the fallback existed).
 *
 * @param obj - the FCStd object to inspect.
 * @returns the .brp member file name, or undefined when neither Shape nor SubShape carries one.
 */
export function shapeBrpFile(obj: FcstdObject): string | undefined {
  return obj.properties.get('Shape')?.children[0]?.attributes['file']
    ?? obj.properties.get('SubShape')?.children[0]?.attributes['file'];
}

/**
 * Resolve every external link of a sketch to sketch-local 2D polylines.
 *
 * @param externalGeoProp - the sketch's ExternalGeometry property.
 * @param doc - the parsed FCStd document, used to locate source objects and their shapes.
 * @param archive - the FCStd container, used to read the source `.brp` shape files.
 * @param sketchPlacement - the sketch's Placement property, whose inverse maps
 *   source geometry into sketch-local coordinates.
 * @returns the resolved sketch-local polylines per link, plus a failure entry
 *   (with reason) for every link that could not be resolved.
 */
export async function resolveExternalGeometry(
  externalGeoProp: FcstdProperty | undefined,
  doc: FcstdDocument,
  archive: FcstdArchive,
  sketchPlacement: FcstdProperty | undefined,
): Promise<ExternalGeoResult> {
  const links: ExternalLink[] = [];
  const failures: ExternalGeoResult['failures'] = [];
  const listEl = externalGeoProp?.children[0];
  if (!listEl) return { links, failures };

  const skPl = placementOf({ name: '', type: '', properties: new Map([['Placement', sketchPlacement ?? { name: 'Placement', type: '', tagName: 'Property', children: [], valueXml: '', valueText: '', attributes: {} } as FcstdProperty]]) as never });
  const toLocal = makeInverseTransformer(skPl.q, skPl.p);

  const kernel: {
    fromBREP: (s: string) => unknown;
    wireframe: (s: unknown, deflection: number) => { points: Float32Array; edgeGroups: number[] };
  } = (await initOcctWasm()) as never;

  const brpCache = new Map<string, { points: Float32Array; edgeGroups: number[] } | undefined>();
  const wireframeOf = (objName: string) => {
    if (brpCache.has(objName)) return brpCache.get(objName);
    const src = doc.objects.find((o) => o.name === objName);
    const brpFile = src ? shapeBrpFile(src) : undefined;
    if (!brpFile) {
      brpCache.set(objName, undefined);
      return undefined;
    }
    const brp = memberText(archive, brpFile);
    if (!brp) {
      brpCache.set(objName, undefined);
      return undefined;
    }
    try {
      const shape = kernel.fromBREP(brp);
      const wf = kernel.wireframe(shape, 0.01);
      brpCache.set(objName, wf);
      return wf;
    } catch {
      brpCache.set(objName, undefined);
      return undefined;
    }
  };

  for (const link of listEl.children) {
    const obj = link.attributes['obj'] ?? '';
    const sub = link.attributes['sub'] ?? '';
    const ord = Number(sub.replace('Edge', ''));
    if (!obj || !sub.startsWith('Edge') || !Number.isInteger(ord) || ord < 1) {
      failures.push({ obj, sub, reason: `unsupported sub-element: ${sub}` });
      continue;
    }
    const wf = wireframeOf(obj);
    if (!wf) {
      failures.push({ obj, sub, reason: 'source shape not loadable' });
      continue;
    }
    const idx = ord - 1; // Edge13 → edgeGroups[12]
    const g0 = wf.edgeGroups[idx * 3];
    const g1 = wf.edgeGroups[idx * 3 + 1];
    if (g0 === undefined || g1 === undefined) {
      failures.push({ obj, sub, reason: `edge ordinal out of range (${wf.edgeGroups.length / 3} edges)` });
      continue;
    }
    const n = Math.floor(g1 / 3);
    const polyline: [number, number][] = [];
    for (let p = 0; p < n; p++) {
      const w: [number, number, number] = [
        wf.points[g0 + p * 3]!, wf.points[g0 + p * 3 + 1]!, wf.points[g0 + p * 3 + 2]!,
      ];
      const l = toLocal(w);
      polyline.push([l[0], l[1]]);
    }
    // drop consecutive duplicates
    const deduped = polyline.filter(
      (pt, i) => i === 0 || Math.hypot(pt[0] - polyline[i - 1]![0], pt[1] - polyline[i - 1]![1]) > 1e-9,
    );
    if (deduped.length >= 2) links.push({ obj, sub, polyline: deduped });
    else failures.push({ obj, sub, reason: 'degenerate polyline' });
  }
  return { links, failures };
}
