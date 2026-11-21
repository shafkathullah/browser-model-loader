import type { ModelLibrary, ModelMeta, StorageEstimate } from "./types.js";

/**
 * Source of truth for "which in-browser models are on disk and who put them
 * there". The actual model bytes live in each library's own Cache API store
 * (transformers.js writes to `transformers-cache`); this sidecar tracks the
 * metadata a model manager UI needs (labels, last-used times, where the model
 * was loaded) and offers one delete and size accounting across stores.
 *
 * Storage strategy: localStorage for the sidecar JSON (sub-kilobyte payload,
 * never blocking), Cache API enumerated on demand for actual byte counts.
 *
 * Updates fan out via:
 *   - the `storage` event (cross-tab: localStorage triggers it natively)
 *   - a custom change event on `window` (same-tab: `storage` events don't
 *     fire in the originating document). Its name is `getModelRegistryConfig().changeEvent`.
 *
 * Call `configureModelRegistry()` once at startup if you need your own key
 * names or more Cache API stores (another library's cache, your own).
 */

export interface ModelRegistryConfig {
  /** localStorage key for the sidecar JSON. */
  storageKey: string;
  /** Name of the same-tab change event dispatched on `window`. */
  changeEvent: string;
  /** Every Cache API store a model library writes; sizes, deletes and reconcile walk them all. */
  cacheNames: string[];
}

const DEFAULT_CONFIG: ModelRegistryConfig = {
  storageKey: "browser-model-loader:models:v1",
  changeEvent: "browser-model-loader:models-changed",
  cacheNames: ["transformers-cache"],
};

let config: ModelRegistryConfig = { ...DEFAULT_CONFIG, cacheNames: [...DEFAULT_CONFIG.cacheNames] };

/** Override any of the key names or cache stores. Unset fields keep their defaults. */
export function configureModelRegistry(next: Partial<ModelRegistryConfig>): void {
  config = {
    storageKey: next.storageKey ?? DEFAULT_CONFIG.storageKey,
    changeEvent: next.changeEvent ?? DEFAULT_CONFIG.changeEvent,
    cacheNames: [...(next.cacheNames ?? DEFAULT_CONFIG.cacheNames)],
  };
}

export function getModelRegistryConfig(): Readonly<ModelRegistryConfig> {
  return config;
}

async function openModelCaches(): Promise<Cache[]> {
  const opened = await Promise.all(
    config.cacheNames.map((name) => caches.open(name).catch(() => null)),
  );
  return opened.filter((cache): cache is Cache => cache !== null);
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function readSidecar(): Record<string, ModelMeta> {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(config.storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeSidecar(records: Record<string, ModelMeta>): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(config.storageKey, JSON.stringify(records));
  window.dispatchEvent(new CustomEvent(config.changeEvent));
}

export function listModels(): ModelMeta[] {
  return Object.values(readSidecar()).toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export interface RecordLoadInput {
  id: string;
  label: string;
  library: ModelLibrary;
  task: string;
  /** Where in your app the model was loaded (e.g. a route). */
  source?: string;
  companionIds?: string[];
}

/**
 * Record that a model has been (or is being) loaded. Call it from your model
 * loader the first time it fetches a model in a given session. Idempotent
 * — repeated calls only bump `lastUsedAt`.
 */
export function recordLoad(input: RecordLoadInput): void {
  const records = readSidecar();
  const now = Date.now();
  const existing = records[input.id];
  records[input.id] = {
    id: input.id,
    label: input.label,
    library: input.library,
    task: input.task,
    ...(input.source ? { source: input.source } : {}),
    ...(input.companionIds ? { companionIds: input.companionIds } : {}),
    sizeBytes: existing?.sizeBytes ?? 0,
    downloadedAt: existing?.downloadedAt ?? now,
    lastUsedAt: now,
  };
  writeSidecar(records);
}

/** Bump `lastUsedAt` without touching anything else. Cheap; safe to call hot. */
export function touch(id: string): void {
  const records = readSidecar();
  const existing = records[id];
  if (!existing) return;
  records[id] = { ...existing, lastUsedAt: Date.now() };
  writeSidecar(records);
}

/** Update the sidecar size — typically the Cache API reconcile pass. */
export function setSize(id: string, sizeBytes: number): void {
  const records = readSidecar();
  const existing = records[id];
  if (!existing) return;
  records[id] = { ...existing, sizeBytes };
  writeSidecar(records);
}

/**
 * Measure one model's cached bytes and record them. Call it right after a
 * model load resolves, so a model manager shows the real size at once instead
 * of waiting for the next full `reconcile()`. Unlike `reconcile()` it never
 * deletes a record: 0 bytes found (cache disabled, files still streaming) just
 * leaves the size unknown. `fallbackBytes` (e.g. the sum of the download
 * progress totals) is used when the Cache API has nothing to count.
 */
export async function measureModel(id: string, fallbackBytes = 0): Promise<number> {
  let bytes = 0;
  if (isBrowser() && "caches" in window) {
    try {
      const record = readSidecar()[id];
      for (const cache of await openModelCaches()) {
        for (const req of await cache.keys()) {
          if (!urlMatchesRecord(req.url, id, record)) continue;
          bytes += await entryBytes(cache, req);
        }
      }
    } catch {
      // Cache API unavailable; fall through to the fallback.
    }
  }
  if (bytes <= 0) bytes = fallbackBytes;
  if (bytes > 0 && readSidecar()[id]?.sizeBytes !== bytes) setSize(id, bytes);
  return bytes;
}

async function entryBytes(cache: Cache, req: Request): Promise<number> {
  try {
    const res = await cache.match(req);
    if (!res) return 0;
    const lenHeader = res.headers.get("Content-Length");
    const len = lenHeader ? Number.parseInt(lenHeader, 10) : NaN;
    if (Number.isFinite(len) && len > 0) return len;
    return (await res.blob()).size;
  } catch {
    return 0;
  }
}

/**
 * transformers.js model URLs are of the shape
 * `https://huggingface.co/<id>/resolve/main/...`. Match on `/<id>/` (with
 * delimiters) rather than a bare substring — one model id can be a prefix of
 * another (`whisper-base` vs `whisper-base_timestamped`), and a bare
 * `includes(id)` would delete or double-count the longer one's entries.
 */
function urlMatchesModel(url: string, id: string): boolean {
  return url.includes(`/${id}/`);
}

/** A model's own files plus its companion repos' (see `ModelMeta.companionIds`). */
function urlMatchesRecord(url: string, id: string, record: ModelMeta | undefined): boolean {
  return [id, ...(record?.companionIds ?? [])].some((repo) => urlMatchesModel(url, repo));
}

/**
 * Remove a model: delete every Cache API entry belonging to the model id,
 * then drop the sidecar record.
 */
export async function removeModel(id: string): Promise<void> {
  if (isBrowser() && "caches" in window) {
    try {
      const record = readSidecar()[id];
      for (const cache of await openModelCaches()) {
        const keys = await cache.keys();
        await Promise.all(
          keys
            .filter((req) => urlMatchesRecord(req.url, id, record))
            .map((req) => cache.delete(req)),
        );
      }
    } catch {
      // Cache API errors shouldn't block sidecar cleanup; the user can clear
      // site data manually if the underlying cache really did fail.
    }
  }
  const records = readSidecar();
  delete records[id];
  writeSidecar(records);
}

/** Wipe every tracked model + every model cache bucket. */
export async function clearAll(): Promise<void> {
  if (isBrowser() && "caches" in window) {
    await Promise.all(config.cacheNames.map((name) => caches.delete(name).catch(() => false)));
  }
  if (isBrowser()) {
    window.localStorage.removeItem(config.storageKey);
    window.dispatchEvent(new CustomEvent(config.changeEvent));
  }
}

/**
 * Walk the model caches, sum bytes per model id, and write the totals
 * back to the sidecar. Models that no longer have any cache entries are
 * dropped from the sidecar (the user wiped site data outside of us).
 */
export async function reconcile(): Promise<void> {
  if (!isBrowser() || !("caches" in window)) return;
  let entries: { cache: Cache; req: Request }[];
  try {
    const opened = await openModelCaches();
    if (opened.length === 0) return;
    entries = (
      await Promise.all(
        opened.map(async (cache) => (await cache.keys()).map((req) => ({ cache, req }))),
      )
    ).flat();
  } catch {
    return;
  }
  if (entries.length === 0) {
    // No cache entries — clear the sidecar so we don't show ghost rows.
    const records = readSidecar();
    if (Object.keys(records).length > 0) {
      window.localStorage.removeItem(config.storageKey);
      window.dispatchEvent(new CustomEvent(config.changeEvent));
    }
    return;
  }
  const records = readSidecar();
  const sizes = new Map<string, number>();
  for (const id of Object.keys(records)) sizes.set(id, 0);

  await Promise.all(
    entries.map(async ({ cache, req }) => {
      const matchedId = Object.keys(records).find((id) =>
        urlMatchesRecord(req.url, id, records[id]),
      );
      if (!matchedId) return;
      const len = await entryBytes(cache, req);
      if (len > 0) sizes.set(matchedId, (sizes.get(matchedId) ?? 0) + len);
    }),
  );

  let changed = false;
  const next = { ...records };
  for (const [id, bytes] of sizes) {
    if (bytes === 0) {
      // No cache entries match → user cleared this model outside of us.
      delete next[id];
      changed = true;
    } else if (next[id]?.sizeBytes !== bytes) {
      next[id] = { ...next[id]!, sizeBytes: bytes };
      changed = true;
    }
  }
  if (changed) writeSidecar(next);
}

export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (!isBrowser() || !navigator.storage?.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
