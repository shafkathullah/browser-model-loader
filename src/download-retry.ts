import { isModelDownloadError } from "./friendly-error.js";
import { downloadKindOf } from "./resumable-fetch.js";

/**
 * Retry a whole model load when its download fails.
 *
 * Both model libraries cache per file and only once a file is complete
 * (transformers.js `cache.put` after the full body, WebLLM `Cache.add` per
 * shard), so a new attempt re-downloads only the file that was in flight.
 *
 * Two budgets, because two different failures look alike from the browser:
 *
 *   dropped      the download made progress, then died. Up to `maxAttempts`.
 *   unreachable  an attempt ended without a single `markProgress()`. After
 *                `maxNoProgressAttempts` of those in a row we stop: the host
 *                is blocked on this network (each attempt can take ~22 s to
 *                fail, the Windows TCP connect timeout) and more tries only
 *                make the user wait longer.
 *
 * Only download failures are retried (`isModelDownloadError`, or an error a
 * resumable fetch tagged); a quota error or an abort is final. When the
 * budget runs out, the caller gets a `ModelDownloadError` whose message tells
 * the user what to do and whose `name` is the cause's, so telemetry grouped
 * by error name keeps matching the original failure.
 */

export type DownloadFailureKind = "unreachable" | "dropped";

export interface RetryInfo {
  /** The attempt about to start (2 = first retry), counted within its budget. */
  attempt: number;
  /** That budget's size. */
  max: number;
  kind: DownloadFailureKind;
}

export const DOWNLOAD_DROPPED_MESSAGE =
  "The model download kept dropping. Check your connection and press Try again. Files that finished downloading are kept.";
/**
 * Host-neutral on purpose: a load can depend on more than Hugging Face (WebLLM
 * also fetches its model library from raw.githubusercontent.com, and your own
 * site may serve runtime files), and any of them can be the blocked one.
 */
export const DOWNLOAD_UNREACHABLE_MESSAGE =
  "Couldn't reach the model download servers. They may be blocked on this network. Try a different network, then press Try again.";

export class ModelDownloadError extends Error {
  readonly kind: DownloadFailureKind;
  readonly attempts: number;

  constructor(kind: DownloadFailureKind, attempts: number, cause: unknown) {
    super(kind === "unreachable" ? DOWNLOAD_UNREACHABLE_MESSAGE : DOWNLOAD_DROPPED_MESSAGE, {
      cause,
    });
    this.kind = kind;
    this.attempts = attempts;
    // The cause's name (usually TypeError), not "ModelDownloadError": keeps error-name grouping stable.
    this.name =
      cause && typeof cause === "object" && typeof (cause as Error).name === "string"
        ? (cause as Error).name
        : "Error";
  }
}

export interface DownloadRetryOptions {
  /** Total attempts when downloads make progress. Default 4. */
  maxAttempts?: number;
  /** Attempts in a row without progress before giving up as unreachable. Default 2. */
  maxNoProgressAttempts?: number;
  /** Wait before retry n (the last value repeats). Default 2 s, 5 s, 10 s. */
  delaysMs?: number[];
  onRetry?: (info: RetryInfo) => void;
  /** Extra veto, checked after the built-in rules (e.g. the model loaded and the failure came later). */
  shouldRetry?: (err: unknown) => boolean;
  /** The run was superseded: stop without another attempt (the original error is rethrown). */
  isCancelled?: () => boolean;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests: resolves once the browser is online (capped). */
  waitOnline?: () => Promise<void>;
}

const NON_RETRYABLE_NAMES = new Set(["QuotaExceededError", "AbortError"]);

export function isRetryableDownloadError(err: unknown): boolean {
  if (err instanceof ModelDownloadError) return false;
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  if (typeof name === "string" && NON_RETRYABLE_NAMES.has(name)) return false;
  return downloadKindOf(err) !== null || isModelDownloadError(err);
}

export async function withDownloadRetry<T>(
  load: (ctx: { attempt: number; markProgress: () => void }) => Promise<T>,
  opts: DownloadRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const maxNoProgress = Math.max(1, opts.maxNoProgressAttempts ?? 2);
  const delays = opts.delaysMs?.length ? opts.delaysMs : [2000, 5000, 10000];
  const sleep = opts.sleep ?? defaultSleep;
  const waitOnline = opts.waitOnline ?? defaultWaitOnline;
  const cancelled = () => opts.isCancelled?.() === true;

  let noProgressStreak = 0;
  for (let attempt = 1; ; attempt++) {
    let progressed = false;
    try {
      return await load({ attempt, markProgress: () => (progressed = true) });
    } catch (err) {
      if (!isRetryableDownloadError(err) || opts.shouldRetry?.(err) === false || cancelled()) {
        throw err;
      }
      // A body that failed partway means the host answered: not unreachable.
      if (downloadKindOf(err) === "dropped") progressed = true;
      noProgressStreak = progressed ? 0 : noProgressStreak + 1;

      if (noProgressStreak >= maxNoProgress)
        throw new ModelDownloadError("unreachable", attempt, err);
      if (attempt >= maxAttempts) throw new ModelDownloadError("dropped", attempt, err);

      opts.onRetry?.(
        noProgressStreak > 0
          ? { attempt: noProgressStreak + 1, max: maxNoProgress, kind: "unreachable" }
          : { attempt: attempt + 1, max: maxAttempts, kind: "dropped" },
      );
      await waitOnline();
      if (cancelled()) throw err;
      await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
      if (cancelled()) throw err;
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the `online` event when the browser says it is offline, at most 60 s. */
function defaultWaitOnline(): Promise<void> {
  if (typeof navigator === "undefined" || typeof window === "undefined") return Promise.resolve();
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, 60_000);
    window.addEventListener("online", done);
  });
}
