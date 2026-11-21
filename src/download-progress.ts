/**
 * One progress bar for a transformers.js model download.
 *
 * transformers.js fetches a model's files in parallel and reports each file's
 * bytes in its own `progress` event, so drawing those on one bar makes it jump
 * back and forth between files. Its `progress_total` event (v4) sums every
 * file of the load instead; this turns that into bar state. The bar never
 * steps back (a file whose size was unknown up front can still grow the
 * total), and the label names the biggest file still downloading, so it does
 * not flicker between small ones.
 *
 * Create one per load and feed it every progress event; it returns null for
 * events that should not move the bar.
 */

export interface DownloadProgress {
  file?: string;
  loaded: number;
  total: number;
}

export interface ProgressEvent {
  status: string;
  loaded?: number;
  total?: number;
  files?: Record<string, { loaded: number; total: number }>;
}

export function createDownloadProgress(): (info: ProgressEvent) => DownloadProgress | null {
  let shown = 0;
  return (info) => {
    if (info.status !== "progress_total") return null;
    const total = finite(info.total);
    if (total <= 0) return null;
    shown = Math.max(shown, Math.min(1, finite(info.loaded) / total));

    let file: string | undefined;
    let biggest = 0;
    for (const [name, bytes] of Object.entries(info.files ?? {})) {
      if (bytes.loaded < bytes.total && bytes.total > biggest) {
        biggest = bytes.total;
        file = name;
      }
    }
    return { file, loaded: Math.round(shown * total), total };
  };
}

function finite(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export interface FileProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/**
 * Builds the `progress_total` event from per-file `progress` events against a
 * total known up front, for a load whose files transformers.js cannot size in
 * advance: its own `progress_total` covers only the files its metadata probe
 * finds (that probe always looks in `onnx/`, so a repo-root model is missed),
 * and a tokenizer loaded alongside is never counted. With the total fixed,
 * the bar's "of 28.1 MB" matches the size the button promised.
 *
 * The total grows past `expectedBytes` only if the files turn out bigger.
 * Returns null for events that carry no bytes.
 */
export function createFileProgressTotal(
  expectedBytes: number,
): (info: FileProgressEvent) => ProgressEvent | null {
  const files: Record<string, { loaded: number; total: number }> = {};
  return (info) => {
    if (info.status !== "progress" || !info.file) return null;
    const total = finite(info.total);
    files[info.file] = { loaded: Math.min(finite(info.loaded), total || Infinity), total };
    let loaded = 0;
    let sum = 0;
    for (const f of Object.values(files)) {
      loaded += f.loaded;
      sum += f.total;
    }
    return {
      status: "progress_total",
      loaded,
      total: Math.max(expectedBytes, sum),
      files: { ...files },
    };
  };
}
