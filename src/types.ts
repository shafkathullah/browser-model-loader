/**
 * Shared types. Every in-browser model your app records (see `registry.ts`)
 * uses this shape, so a model manager UI can list, size and delete them
 * uniformly.
 */

/**
 * `wasm`: a model compiled together with its runtime into one WebAssembly
 * file you build and serve yourself.
 */
export type ModelLibrary = "transformers-js" | "webllm" | "onnxruntime-web" | "wasm";

export interface ModelMeta {
  /** Canonical Hugging Face id, e.g. "Xenova/modnet" or "briaai/RMBG-1.4". */
  id: string;
  /** Human-readable label for a model manager UI. */
  label: string;
  library: ModelLibrary;
  /** transformers.js task tag — useful for displaying intent ("image-segmentation"). */
  task: string;
  /**
   * Bytes occupied on disk. Filled by the registry's reconcile pass which
   * inspects the Cache API; library callers can leave it 0 and the registry
   * will populate it. May be 0 if the cache hasn't been hit yet.
   */
  sizeBytes: number;
  /** Epoch ms of first record. Set on initial `recordLoad`, never overwritten. */
  downloadedAt: number;
  /** Epoch ms of most recent use. Updated on every `touch`. */
  lastUsedAt: number;
  /** Where in your app the model was loaded (e.g. a route), to link back to it. Optional. */
  source?: string;
  /**
   * Other Hugging Face repos whose cached files belong to this model and are
   * sized and deleted with it, e.g. a TTS model's separate voices repo.
   */
  companionIds?: string[];
}

export interface StorageEstimate {
  /** Bytes used by *all* origin storage (not just models). */
  usage: number;
  /** Bytes the browser is willing to grant. */
  quota: number;
}

export type DeviceType = "webgpu" | "wasm";
