/**
 * Unified .fai.zip read API (docs/fai-zip-format.md §4–§9).
 *
 * Environment-independent by constraint: reading uses only `unzip` + JSON
 * parsing — no `node:*`, no DOM, no fs. Web workers and node share this code.
 *
 * Contract highlights (spec §9 Reader obligations):
 * - a missing/malformed manifest, `format !== 3`, a malformed `models` array,
 *   a missing entry, a missing named data member, a duplicate asset key and a
 *   referenced-but-absent asset key are all errors carrying the offending value;
 * - entry selection is `active` or `models[0]` — never a file-name heuristic;
 * - members outside the table (§3), unknown manifest fields and unknown
 *   data-member keys are ignored, never errors, never decision inputs.
 */
import { unzipSync, strFromU8 } from 'fflate';
import type { ProjectLoader } from '@faicad/faijs/cad-runtime/ports';
import type { ContainerManifest, ContainerModel } from './container.js';

/** Asset payloads of a container: bytes keyed by asset key (spec §7). */
export interface ContainerAssetEntries {
  /** `files/**` members — key = fileId (member path relative to files/, final extension removed) */
  files: Record<string, Uint8Array>;
  /** `assets/**` members — key = base name with the final extension removed */
  assets: Record<string, Uint8Array>;
}

/** openContainer result: manifest, active model, loader and payloads. */
export interface OpenContainerResult {
  manifest: ContainerManifest;
  activeModel: ContainerModel;
  /** project loader over the container's module graph (listModules/readSource) */
  loader: ProjectLoader;
  files: Record<string, Uint8Array>;
  assets: Record<string, Uint8Array>;
}

/** Path prefix of every model script member. */
const MODEL_PREFIX = 'model/';
/** Path prefix of the imported-file payloads. */
const FILES_PREFIX = 'files/';
/** Path prefix of the script-consumed payloads. */
const ASSETS_PREFIX = 'assets/';

/** Unpack the archive; a non-ZIP input is a hard error. */
function unzipMembers(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch (e) {
    throw new Error(`[fai-zip] cannot open container as ZIP: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Normalize a manifest field error into one message naming the offending value. */
function manifestError(reason: string, value?: unknown): Error {
  const shown = value === undefined ? '' : ` (observed: ${JSON.stringify(value)})`;
  return new Error(`[fai-zip] invalid manifest: ${reason}${shown}`);
}

/** Validate a member path against the spec §2 rules (relative, `/`, no `..`). */
function assertSafeMemberPath(path: string, what: string): void {
  if (path.startsWith('/') || path.includes('\\') || path.includes('..') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`[fai-zip] unsafe member path in ${what}: "${path}"`);
  }
}

/**
 * Read and validate the container manifest (spec §4).
 * @param bytes the .fai.zip archive bytes
 * @returns the validated manifest
 * @throws when the archive is not a ZIP, the manifest is missing/malformed,
 *   `format !== 3`, `units !== "mm"`, `models` is empty/malformed, ids/entries
 *   are duplicated, an entry is not under `model/` or does not exist, `active`
 *   is not in `models[].id`, or a named `data` member does not exist.
 */
export function readManifest(bytes: Uint8Array): ContainerManifest {
  const members = unzipMembers(bytes);
  const raw = members['manifest.json'];
  if (raw === undefined) throw new Error('[fai-zip] invalid manifest: missing manifest.json — not a .fai.zip container');
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(raw));
  } catch (e) {
    throw new Error(`[fai-zip] invalid manifest: manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw manifestError('manifest.json must be a JSON object');
  }
  const manifest = parsed as Record<string, unknown>;

  if (manifest.format !== 3) {
    throw manifestError('format must be the integer 3 (this revision); no other value is interpretable', manifest.format);
  }
  if (manifest.units !== 'mm') {
    throw manifestError('units must be "mm"', manifest.units);
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw manifestError('models must be a non-empty array', manifest.models);
  }

  const models = manifest.models as unknown[];
  const seenIds = new Set<string>();
  const seenEntries = new Set<string>();
  const normalized: ContainerModel[] = [];
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      throw manifestError(`models[${i}] must be an object`, m);
    }
    const rec = m as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : '';
    if (id === '') throw manifestError(`models[${i}].id must be a non-empty string`, rec.id);
    if (id.includes('/') || id.includes('\\')) throw manifestError(`models[${i}].id must not contain "/" or "\\"`, id);
    if (seenIds.has(id)) throw manifestError(`models[].id must be unique`, id);
    seenIds.add(id);

    const entry = typeof rec.entry === 'string' ? rec.entry : '';
    if (entry === '') throw manifestError(`models[${i}].entry must be a non-empty string`, rec.entry);
    assertSafeMemberPath(entry, `models[${i}].entry`);
    if (!entry.startsWith(MODEL_PREFIX) || !entry.endsWith('.fai.js')) {
      throw manifestError(`models[${i}].entry must be under model/ and end with .fai.js`, entry);
    }
    if (seenEntries.has(entry)) throw manifestError('models[].entry must be unique', entry);
    seenEntries.add(entry);
    if (members[entry] === undefined) {
      throw manifestError(`models[${i}].entry does not exist in the container`, entry);
    }

    const data = typeof rec.data === 'string' ? rec.data : undefined;
    if (data !== undefined) {
      assertSafeMemberPath(data, `models[${i}].data`);
      if (members[data] === undefined) {
        throw manifestError(`models[${i}].data names a member that does not exist`, data);
      }
    }

    normalized.push({
      id,
      entry,
      ...(typeof rec.label === 'string' ? { label: rec.label } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }

  let active: string | undefined;
  if (manifest.active !== undefined) {
    if (typeof manifest.active !== 'string' || !seenIds.has(manifest.active)) {
      throw manifestError('active must equal some models[].id', manifest.active);
    }
    active = manifest.active;
  }

  return {
    format: 3,
    units: 'mm',
    models: normalized,
    ...(active !== undefined ? { active } : {}),
    ...(typeof manifest.createdAt === 'string' ? { createdAt: manifest.createdAt } : {}),
    ...(typeof manifest.appVersion === 'string' ? { appVersion: manifest.appVersion } : {}),
    ...(typeof manifest.label === 'string' ? { label: manifest.label } : {}),
    ...(typeof manifest.source === 'object' && manifest.source !== null ? { source: manifest.source as ContainerManifest['source'] } : {}),
    ...(typeof manifest.requiresBrep === 'boolean' ? { requiresBrep: manifest.requiresBrep } : {}),
  };
}

/**
 * List the container models (validated). Same validation as readManifest.
 * @param bytes the .fai.zip archive bytes
 * @returns the validated model list
 */
export function listModels(bytes: Uint8Array): ContainerModel[] {
  return readManifest(bytes).models;
}

/**
 * List every module under `model/` (keys relative to `model/`, sorted).
 * Members outside the table are ignored (§3), never an error.
 * @param bytes the .fai.zip archive bytes
 * @returns module keys relative to `model/`, sorted
 */
export function listModules(bytes: Uint8Array): string[] {
  const members = unzipMembers(bytes);
  const keys: string[] = [];
  for (const path of Object.keys(members)) {
    if (path.startsWith(MODEL_PREFIX) && path.endsWith('.fai.js') && path.length > MODEL_PREFIX.length) {
      keys.push(path.slice(MODEL_PREFIX.length));
    }
  }
  return keys.sort();
}

/**
 * Read one module's source text by module key (relative to `model/`).
 * @param bytes the .fai.zip archive bytes
 * @param key the module key relative to `model/` (e.g. `main.fai.js`)
 * @returns the module source text
 * @throws for a key outside `model/` or that does not exist
 */
export function readModule(bytes: Uint8Array, key: string): string {
  if (typeof key !== 'string' || key === '') {
    throw new Error('[fai-zip] readModule: key must be a non-empty string');
  }
  assertSafeMemberPath(key, 'readModule key');
  if (!key.endsWith('.fai.js')) {
    throw new Error(`[fai-zip] readModule: key must name a module under model/ (ends with .fai.js): "${key}"`);
  }
  const member = unzipMembers(bytes)[MODEL_PREFIX + key];
  if (member === undefined) {
    throw new Error(`[fai-zip] readModule: module "${key}" does not exist under model/`);
  }
  return strFromU8(member);
}

/** Asset key of a member: base name with the final extension removed (spec §7). */
function assetKeyOf(path: string, prefix: string): string {
  const rel = path.slice(prefix.length);
  const slash = rel.lastIndexOf('/');
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Collect the payload bytes of a container.
 * Keys are unique across `files/**` and `assets/**` together (spec §7.1);
 * a duplicate key is an error rather than a pick.
 * @param bytes the .fai.zip archive bytes
 * @returns the payload entries keyed by asset key
 */
export function readAssetEntries(bytes: Uint8Array): ContainerAssetEntries {
  const members = unzipMembers(bytes);
  const files: Record<string, Uint8Array> = {};
  const assets: Record<string, Uint8Array> = {};
  const claimed = new Set<string>();
  for (const path of Object.keys(members)) {
    if (path.startsWith(FILES_PREFIX)) {
      const key = assetKeyOf(path, FILES_PREFIX);
      if (claimed.has(key)) throw new Error(`[fai-zip] duplicate asset key across files//assets/: "${key}"`);
      claimed.add(key);
      files[key] = members[path];
    } else if (path.startsWith(ASSETS_PREFIX)) {
      const key = assetKeyOf(path, ASSETS_PREFIX);
      if (claimed.has(key)) throw new Error(`[fai-zip] duplicate asset key across files//assets/: "${key}"`);
      claimed.add(key);
      assets[key] = members[path];
    }
  }
  return { files, assets };
}

/**
 * Host entry point: open a container and return the manifest, the active
 * model and a ProjectLoader over its module graph, plus the payloads.
 * @param bytes the .fai.zip archive bytes
 * @param modelId optional override of the model to activate (else manifest.active, else models[0])
 * @returns manifest, active model, project loader and payload entries
 */
export function openContainer(bytes: Uint8Array, modelId?: string): OpenContainerResult {
  const manifest = readManifest(bytes);
  const members = unzipMembers(bytes);

  const activeModel: ContainerModel = (() => {
    if (modelId === undefined) {
      const byActive = manifest.models.find((m) => m.id === manifest.active);
      return byActive ?? manifest.models[0];
    }
    const byParam = manifest.models.find((m) => m.id === modelId);
    if (byParam === undefined) {
      throw new Error(`[fai-zip] openContainer: model "${modelId}" is not in models[]`);
    }
    return byParam;
  })();

  const keys = Object.keys(members)
    .filter((p) => p.startsWith(MODEL_PREFIX) && p.endsWith('.fai.js'))
    .map((p) => p.slice(MODEL_PREFIX.length))
    .sort();

  const loader: ProjectLoader = {
    listModules: () => [...keys],
    readSource: async (moduleKey) => {
      const member = members[MODEL_PREFIX + moduleKey];
      if (member === undefined) {
        throw new Error(`[fai-zip] loader: module "${moduleKey}" does not exist under model/`);
      }
      return strFromU8(member);
    },
  };

  const { files, assets } = readAssetEntries(bytes);
  return { manifest, activeModel, loader, files, assets };
}
