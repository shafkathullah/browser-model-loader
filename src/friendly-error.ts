/**
 * Model loads that die surface as the browser's bare exception text ("Failed to fetch",
 * "NetworkError when attempting to fetch resource", a Cache API or chunk-load error).
 * Users get one plain sentence with a next step instead; the raw message stays
 * available to the caller for logging.
 */

export const MODEL_DOWNLOAD_FAILED =
  "Couldn't download the model. Check your connection and try again.";

/**
 * The tab itself is out of memory (on iOS a fresh worker can fail again within
 * milliseconds, over and over), so only a reload helps.
 */
export const OUT_OF_MEMORY_MESSAGE =
  "Your device ran out of memory. Close other tabs, then reload the page.";

const NETWORK_RE =
  /failed to fetch|network ?error|load failed|networkerror|err_(internet|network|connection)|fetch.*(abort|fail)|cache|chunk|dynamically imported module|importing a module script/i;

export function isModelDownloadError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  return NETWORK_RE.test(message);
}

/** The line to show a user for a failed model load. Non-network errors pass through. */
export function friendlyModelError(err: unknown): string {
  if (isModelDownloadError(err)) return MODEL_DOWNLOAD_FAILED;
  if (err instanceof Error && err.message) return err.message;
  return typeof err === "string" && err ? err : GENERIC_ERROR_MESSAGE;
}

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

const OUT_OF_MEMORY_RE =
  /out of memory|\boom\b|alloc(ation)? failed|failed to allocate|array buffer|memory\.grow|bad_alloc/i;

/** The final `ModelDownloadError` lines (`download-retry.ts`), already written for users. */
const OWN_DOWNLOAD_LINE_RE = /couldn't reach the model|download kept dropping/i;

/**
 * The line to show a user for any failed run (image, OCR, audio...): a failed
 * download or an out-of-memory tab gets its own line, and anything else (model,
 * ONNX Runtime or canvas text) gets one plain line. The raw text stays with the
 * caller to log.
 */
export function friendlyToolError(err: unknown): string {
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  const raw = err instanceof Error ? err.message : message;
  if (raw === MODEL_DOWNLOAD_FAILED || raw === OUT_OF_MEMORY_MESSAGE) return raw;
  if (OWN_DOWNLOAD_LINE_RE.test(raw)) return raw;
  if (OUT_OF_MEMORY_RE.test(message)) return OUT_OF_MEMORY_MESSAGE;
  if (isModelDownloadError(err)) return MODEL_DOWNLOAD_FAILED;
  return GENERIC_ERROR_MESSAGE;
}

/**
 * `friendlyToolError` for a card whose headline already says "Something went wrong" and
 * which has its own Try again button: the generic line would only repeat both, so none.
 */
export function friendlyToolErrorDetail(err: unknown): string | undefined {
  const line = friendlyToolError(err);
  return line === GENERIC_ERROR_MESSAGE ? undefined : line;
}
