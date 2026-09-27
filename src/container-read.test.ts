/**
 * P2 — unified .fai.zip read API tests (docs/fai-zip-format.md §4–§9).
 *
 * Coverage (design §5 Phase 2.2):
 * - manifest validation, one error per defect (format/models/id/entry/active);
 * - out-of-range readModule keys;
 * - moduleKey after `model/` prefix stripping;
 * - multi-model listModels + activeModel resolution (default = models[0]);
 * - containers with vs without assets//freecad//mapping.json behave the same
 *   outside the payloads;
 * - members outside the table are ignored, never an error;
 * - unknown fields in manifest.json and data/*.json are ignored and never
 *   change the meaning of defined fields;
 * - duplicate asset keys across files//assets/ are an error;
 * - openContainer overrides the active model and rejects unknown model ids.
 */
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  readManifest,
  listModels,
  listModules,
  readModule,
  readAssetEntries,
  openContainer,
} from './container-read.js';

/** Build a minimal conforming container (manifest + model scripts). */
function buildContainer(overrides?: {
  manifest?: Record<string, unknown>;
  models?: unknown[];
  extraMembers?: Record<string, string>;
  /** false = do not emit the default model/plate.fai.js member */
  baseModule?: boolean;
}): Uint8Array {
  const manifest = {
    format: 3,
    units: 'mm',
    models: overrides?.models ?? [{ id: 'plate', entry: 'model/plate.fai.js' }],
    ...(overrides?.manifest ?? {}),
  };
  const members: Record<string, string> = {
    'manifest.json': JSON.stringify(manifest),
    ...(overrides?.baseModule === false ? {} : { 'model/plate.fai.js': 'const part0 = cad.box(20, 20, 20, { centered: true })' }),
    ...(overrides?.extraMembers ?? {}),
  };
  return zipSync(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, strToU8(v)])));
}

const CONFORMING = buildContainer();

describe('readManifest / listModels — validation', () => {
  it('accepts a conforming container', () => {
    const m = readManifest(CONFORMING);
    expect(m.format).toBe(3);
    expect(m.units).toBe('mm');
    expect(m.models).toEqual([{ id: 'plate', entry: 'model/plate.fai.js' }]);
    expect(m.active).toBeUndefined();
  });

  it('rejects a non-ZIP input', () => {
    expect(() => readManifest(new Uint8Array([1, 2, 3]))).toThrow(/cannot open container as ZIP/);
  });

  it('rejects a missing manifest', () => {
    const zip = zipSync({ 'model/plate.fai.js': strToU8('x') });
    expect(() => readManifest(zip)).toThrow(/missing manifest\.json/);
  });

  it('rejects a malformed manifest (not an object / bad JSON)', () => {
    const zip = zipSync({ 'manifest.json': strToU8('[{]') });
    expect(() => readManifest(zip)).toThrow(/not valid JSON/);
    const zip2 = zipSync({ 'manifest.json': strToU8('"just a string"') });
    expect(() => readManifest(zip2)).toThrow(/must be a JSON object/);
  });

  it('rejects format 1, 2 and 4, naming the observed value', () => {
    for (const format of [1, 2, 4]) {
      expect(() => readManifest(buildContainer({ manifest: { format } }))).toThrow(/format must be the integer 3/);
    }
  });

  it('rejects units other than mm', () => {
    expect(() => readManifest(buildContainer({ manifest: { units: 'inch' } }))).toThrow(/units must be "mm"/);
  });

  it('rejects missing / empty models', () => {
    expect(() => readManifest(buildContainer({ manifest: { models: undefined } }))).toThrow(/models must be a non-empty array/);
    expect(() => readManifest(buildContainer({ models: [] }))).toThrow(/models must be a non-empty array/);
  });

  it('rejects a model with an empty or missing id', () => {
    expect(() => readManifest(buildContainer({ models: [{ entry: 'model/a.fai.js' }] }))).toThrow(/\.id must be a non-empty string/);
  });

  it('rejects duplicate model ids', () => {
    expect(() => readManifest(buildContainer({
      models: [
        { id: 'a', entry: 'model/a.fai.js' },
        { id: 'a', entry: 'model/b.fai.js' },
      ],
      extraMembers: { 'model/a.fai.js': 'x', 'model/b.fai.js': 'y' },
    }))).toThrow(/models\[\]\.id must be unique/);
  });

  it('rejects an entry outside model/', () => {
    expect(() => readManifest(buildContainer({ models: [{ id: 'a', entry: 'scripts/a.fai.js' }] }))).toThrow(/entry must be under model\/ and end with \.fai\.js/);
  });

  it('rejects an entry that does not end with .fai.js', () => {
    expect(() => readManifest(buildContainer({ models: [{ id: 'a', entry: 'model/a.js' }] }))).toThrow(/entry must be under model\/ and end with \.fai\.js/);
  });

  it('rejects a duplicate entry', () => {
    expect(() => readManifest(buildContainer({
      models: [
        { id: 'a', entry: 'model/a.fai.js' },
        { id: 'b', entry: 'model/a.fai.js' },
      ],
      extraMembers: { 'model/a.fai.js': 'x' },
    }))).toThrow(/models\[\]\.entry must be unique/);
  });

  it('rejects an entry that does not exist in the container', () => {
    expect(() => readManifest(buildContainer({ models: [{ id: 'a', entry: 'model/missing.fai.js' }] }))).toThrow(/entry does not exist in the container/);
  });

  it('rejects a named data member that does not exist', () => {
    expect(() => readManifest(buildContainer({
      models: [{ id: 'a', entry: 'model/a.fai.js', data: 'data/a.json' }],
      extraMembers: { 'model/a.fai.js': 'x' },
    }))).toThrow(/data names a member that does not exist/);
  });

  it('accepts a named data member that exists', () => {
    const zip = buildContainer({
      models: [{ id: 'a', entry: 'model/a.fai.js', data: 'data/a.json' }],
      extraMembers: { 'model/a.fai.js': 'x', 'data/a.json': '{"loadedFiles":[]}' },
    });
    const m = readManifest(zip);
    expect(m.models[0].data).toBe('data/a.json');
  });

  it('rejects active outside models[].id', () => {
    expect(() => readManifest(buildContainer({ manifest: { active: 'nope' } }))).toThrow(/active must equal some models\[\]\.id/);
  });

  it('strips nested subdirectories safely: model/parts/a.fai.js is a valid entry', () => {
    const zip = buildContainer({
      models: [{ id: 'a', entry: 'model/parts/a.fai.js' }],
      extraMembers: { 'model/parts/a.fai.js': 'const x = cad.box(1, 1, 1)' },
    });
    expect(readManifest(zip).models[0].entry).toBe('model/parts/a.fai.js');
  });
});

describe('listModules / readModule — module keys', () => {
  it('lists module keys with model/ prefix stripped, sorted', () => {
    const zip = buildContainer({
      extraMembers: {
        'model/b.fai.js': 'const b = cad.sphere(1)',
        'model/parts/c.fai.js': 'const c = cad.box(1, 1, 1)',
        'not-a-module/x.txt': 'ignored',
        'assets/logo.svg': '<svg/>',
      },
    });
    expect(listModules(zip)).toEqual(['b.fai.js', 'parts/c.fai.js', 'plate.fai.js']);
  });

  it('readModule returns text for an existing key', () => {
    expect(readModule(CONFORMING, 'plate.fai.js')).toContain('cad.box(20, 20, 20');
  });

  it('readModule throws for a missing key', () => {
    expect(() => readModule(CONFORMING, 'missing.fai.js')).toThrow(/does not exist under model\//);
  });

  it('readModule throws for a non-module key', () => {
    expect(() => readModule(CONFORMING, 'parts/')).toThrow(/key must name a module under model\/ \(ends with \.fai\.js\)/);
  });

  it('readModule throws for an empty key', () => {
    expect(() => readModule(CONFORMING, '')).toThrow(/key must be a non-empty string/);
  });
});

describe('readAssetEntries — payload keys', () => {
  it('collects files/ by stripped fileId key and assets/ by extensionless name', () => {
    const zip = buildContainer({
      extraMembers: {
        'files/9f1c2a.bin': 'stl-bytes',
        'assets/bracket.brp': 'brep-bytes',
        'assets/logo.svg': '<svg/>',
        'model/deep/other.fai.js': 'module',
      },
    });
    const { files, assets } = readAssetEntries(zip);
    expect(files).toEqual({ '9f1c2a': strToU8('stl-bytes') });
    expect(assets).toEqual({
      bracket: strToU8('brep-bytes'),
      logo: strToU8('<svg/>'),
    });
  });

  it('throws on a duplicate key across files//assets/', () => {
    const zip = buildContainer({
      extraMembers: {
        'files/dup.bin': 'a',
        'assets/dup.brp': 'b',
      },
    });
    expect(() => readAssetEntries(zip)).toThrow(/duplicate asset key/);
  });

  it('ignores table-foreign members without error', () => {
    const zip = buildContainer({
      extraMembers: {
        'preview/thumbnail.png': 'img',
        'export/plate.step': 'step',
        'cache/plate/geo.bin': 'faked-cache',
        'custom-stuff/whatever.txt': 'x',
      },
    });
    expect(readManifest(zip).models).toHaveLength(1);
    expect(listModules(zip)).toEqual(['plate.fai.js']);
    expect(readAssetEntries(zip)).toEqual({ files: {}, assets: {} });
  });
});

describe('openContainer — active model & loader', () => {
  const multi = buildContainer({
    baseModule: false,
    models: [
      { id: 'main', entry: 'model/main.fai.js' },
      { id: 'Body', entry: 'model/Body.fai.js', label: 'Body' },
      { id: 'Body001', entry: 'model/Body001.fai.js' },
    ],
    extraMembers: {
      'model/main.fai.js': 'import { Body_out } from "./Body.fai.js"',
      'model/Body.fai.js': 'const Body_out = cad.box(1, 1, 1)',
      'model/Body001.fai.js': 'const Body001_out = cad.cylinder(1, 2)',
    },
  });

  it('defaults activeModel to models[0] when active is absent', () => {
    const { activeModel, manifest } = openContainer(multi);
    expect(activeModel).toEqual({ id: 'main', entry: 'model/main.fai.js' });
    expect(manifest.active).toBeUndefined();
  });

  it('honors manifest.active', () => {
    const zip = buildContainer({
      baseModule: false,
      models: [
        { id: 'a', entry: 'model/a.fai.js' },
        { id: 'b', entry: 'model/b.fai.js' },
      ],
      manifest: { active: 'b' },
      extraMembers: {
        'model/a.fai.js': 'const a = cad.box(1, 1, 1)',
        'model/b.fai.js': 'const b = cad.box(1, 1, 1)',
      },
    });
    expect(openContainer(zip).activeModel.id).toBe('b');
  });

  it('honors the modelId parameter', () => {
    const { activeModel } = openContainer(multi, 'Body001');
    expect(activeModel.id).toBe('Body001');
  });

  it('rejects an unknown modelId parameter', () => {
    expect(() => openContainer(multi, 'nope')).toThrow(/model "nope" is not in models\[\]/);
  });

  it('loader lists all modules and reads any of them', async () => {
    const { loader } = openContainer(multi);
    expect(loader.listModules()).toEqual(['Body.fai.js', 'Body001.fai.js', 'main.fai.js']);
    const src = await loader.readSource('Body001.fai.js');
    expect(src).toContain('cad.cylinder(1, 2)');
    await expect(loader.readSource('missing.fai.js')).rejects.toThrow(/does not exist under model/);
  });

  it('containers with and without optional namespaces behave identically outside payloads', () => {
    const plain = buildContainer();
    const adorned = buildContainer({
      extraMembers: {
        'assets/bracket.brp': 'brep',
        'mapping.json': '{"objects":[]}',
        'freecad/Document.xml': '<Document/>',
        'preview/thumbnail.png': 'img',
      },
    });
    expect(readManifest(adorned)).toEqual(readManifest(plain));
    expect(listModules(adorned)).toEqual(listModules(plain));
    const l1 = openContainer(plain).loader;
    const l2 = openContainer(adorned).loader;
    expect(l1.listModules()).toEqual(l2.listModules());
  });

  it('unknown manifest fields are ignored and never change defined fields', () => {
    const base = readManifest(buildContainer());
    const withUnknown = readManifest(buildContainer({ manifest: { customField: { anything: 1 }, another: 'x' } }));
    expect(withUnknown).toEqual(base);
  });

  it('unknown data-member keys are ignored (reader does not interpret data)', () => {
    const zip = buildContainer({
      models: [{ id: 'plate', entry: 'model/plate.fai.js', data: 'data/plate.json' }],
      extraMembers: { 'data/plate.json': '{"sceneTree":[],"customUserKey":42}' },
    });
    const { loader } = openContainer(zip);
    // data members are payloads to the reader: keys are owned by the writer
    expect(loader.listModules()).toEqual(['plate.fai.js']);
  });

  it('duplicate model list shape is preserved (main + Bodies)', () => {
    const { manifest } = openContainer(multi);
    expect(manifest.models.map((m) => m.id)).toEqual(['main', 'Body', 'Body001']);
    expect(manifest.models[1].label).toBe('Body');
  });
});
