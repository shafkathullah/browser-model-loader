/**
 * A `fetch` wrapper that resumes a model file download from the byte where it
 * dropped, instead of throwing away everything received so far.
 *
 * Why: transformers.js streams each model file whole into memory and only
 * caches it once complete (`hub.js` `loadResourceFile` → `readResponse` →
 * `cache.put`), so a connection that drops 80 MB into the 124 MB Whisper
 * decoder loses all 80 MB. Hugging Face (and its `*.hf.co` CDN) answers
 * `Range` requests with 206 + `content-range` + a stable content-hash `etag`
 * (checked with live curl 2026-09-30), so the missing tail can be fetched and
 * stitched onto the same stream. The caller never sees the drop.
 *
 * Only acts on a failure: everything that is not a plain 200 GET to a Hugging
 * Face host passes straight through (non-GET, requests that already carry a
 * `Range` header such as transformers' `bytes=0-0` metadata probe, other
 * hosts, non-200 responses, bodiless responses).
 *
 * A resume is accepted only when the server proves it is the same bytes: 206,
 * `content-range` starting exactly at the bytes received with the same total,
 * the same `etag` when both carry one, and an identity-encoded first response
 * (a gzip'd body's byte offsets are not the file's). Anything else errors the
 * stream with the original failure, and the whole-load retry
 * (`download-retry.ts`) takes over.
 *
 * Errors are tagged with `downloadKind` (see `downloadKindOf`): "unreachable"
 * when the first request never got headers, "dropped" when the body failed.
 */

export type DownloadKind = "unreachable" | "dropped";

export interface ResumableFetchOptions {
  /** Resume attempts per file before giving up. Default 5. */
  maxResumes?: number;
  /** No bytes for this long counts as a drop (the request is aborted). 0 disables. Default 30 s. */
  stallMs?: number;
  /** Called after a resume succeeded, with the original URL and the bytes kept. */
  onResume?: (url: string, received: number) => void;
  /**
   * Called for every body chunk the network delivered, with its size. A file
   * served from the library's cache never passes through here, so this is the
   * "the host is delivering" signal a retry budget needs (cached files replay
   * their progress events on every attempt).
   */
  onBytes?: (url: string, bytes: number) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

type Fetch = typeof fetch;

const TAG = Symbol.for("browser-model-loader.resumableFetch");
const KIND = "downloadKind";

/** The failure kind a resumable fetch attached to an error, if any. */
export function downloadKindOf(err: unknown): DownloadKind | null {
  if (err && typeof err === "object" && KIND in err) {
    const kind = (err as Record<string, unknown>)[KIND];
    if (kind === "unreachable" || kind === "dropped") return kind;
  }
  return null;
}

function tag<E>(err: E, kind: DownloadKind): E {
  if (err && typeof err === "object" && downloadKindOf(err) === null) {
    try {
      Object.defineProperty(err, KIND, { value: kind, configurable: true });
    } catch {
      // frozen error: the retry helper falls back to its no-progress rule
    }
  }
  return err;
}

function isHfHost(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return (
      hostname === "huggingface.co" ||
      hostname.endsWith(".huggingface.co") ||
      hostname.endsWith(".hf.co")
    );
  } catch {
    return false;
  }
}

function describe(input: RequestInfo | URL, init?: RequestInit) {
  const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : (req?.url ?? "");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? req?.headers);
  const signal = init?.signal ?? req?.signal ?? null;
  return { url, method, headers, signal, isRequest: req !== null };
}

/** `bytes <start>-<end>/<total>` → numbers, or null. */
export function parseContentRange(value: string | null): { start: number; total: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value?.trim() ?? "");
  if (!m) return null;
  return { start: Number(m[1]), total: Number(m[3]) };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createResumableFetch(base: Fetch, opts: ResumableFetchOptions = {}): Fetch {
  const maxResumes = opts.maxResumes ?? 5;
  const stallMs = opts.stallMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = describe(input, init);
    if (req.isRequest || req.method !== "GET" || req.headers.has("range") || !isHfHost(req.url)) {
      return base(input, init);
    }

    const callerSignal = req.signal;
    let inner = new AbortController();
    const forwardAbort = () => inner.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });

    let first: Response;
    try {
      first = await withTimeout(base(input, { ...init, signal: inner.signal }), stallMs, () =>
        inner.abort(stallError()),
      );
    } catch (err) {
      callerSignal?.removeEventListener("abort", forwardAbort);
      throw callerSignal?.aborted ? err : tag(err, "unreachable");
    }
    if (first.status !== 200 || !first.body) {
      callerSignal?.removeEventListener("abort", forwardAbort);
      return first;
    }

    const lengthHeader = first.headers.get("content-length");
    const total = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    const etag = first.headers.get("etag");
    const encoding = first.headers.get("content-encoding");
    const canResume = total !== null && (!encoding || encoding.toLowerCase() === "identity");

    let reader: ReadableStreamDefaultReader<Uint8Array> = first.body.getReader();
    let received = 0;
    let resumes = 0;

    const read = () => withTimeout(reader.read(), stallMs, () => inner.abort(stallError()));

    /** Re-request the tail; a reader for it, or null when the server can't prove it's the same file. */
    const resume = async (): Promise<ReadableStreamDefaultReader<Uint8Array> | null> => {
      inner = new AbortController();
      const headers = new Headers(req.headers);
      headers.set("range", `bytes=${received}-`);
      // Always the original huggingface.co URL: the signed CDN link it redirected to expires.
      const res = await withTimeout(
        base(req.url, { ...init, headers, cache: "no-store", signal: inner.signal }),
        stallMs,
        () => inner.abort(stallError()),
      );
      const range = parseContentRange(res.headers.get("content-range"));
      const resEtag = res.headers.get("etag");
      const ok =
        res.status === 206 &&
        !!res.body &&
        range !== null &&
        range.start === received &&
        range.total === total &&
        !(etag && resEtag && normalizeEtag(etag) !== normalizeEtag(resEtag));
      if (!ok) {
        void res.body?.cancel().catch(() => {});
        return null;
      }
      return res.body.getReader();
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          let failure: unknown;
          try {
            const { done, value } = await read();
            if (done) {
              if (canResume && total !== null && received < total) {
                // Chrome errors a short body itself; this guards a clean-but-short end.
                // Only on identity bodies: a decoded gzip body never matches its content-length.
                throw new TypeError(`network error: body ended at ${received} of ${total} bytes`);
              }
              callerSignal?.removeEventListener("abort", forwardAbort);
              controller.close();
              return;
            }
            received += value.byteLength;
            opts.onBytes?.(req.url, value.byteLength);
            controller.enqueue(value);
            return;
          } catch (err) {
            failure = err;
          }

          // The body failed partway.
          if (callerSignal?.aborted) {
            controller.error(callerSignal.reason ?? failure);
            return;
          }
          void reader.cancel().catch(() => {});
          let next: ReadableStreamDefaultReader<Uint8Array> | null = null;
          while (next === null && resumes < (canResume ? maxResumes : 0)) {
            resumes++;
            if (resumes > 1) await sleep(Math.min(1000 * 2 ** (resumes - 2), 8000));
            if (callerSignal?.aborted) break;
            try {
              next = await resume();
            } catch {
              // still down: try again until the budget runs out
              continue;
            }
            if (next === null) break; // the server can't prove it's the same file
          }
          if (next === null) {
            callerSignal?.removeEventListener("abort", forwardAbort);
            controller.error(tag(failure, "dropped"));
            return;
          }
          reader = next;
          opts.onResume?.(req.url, received);
        }
      },
      cancel(reason) {
        callerSignal?.removeEventListener("abort", forwardAbort);
        void reader.cancel(reason).catch(() => {});
        inner.abort(reason);
      },
    });

    return new Response(stream, {
      status: first.status,
      statusText: first.statusText,
      headers: first.headers,
    });
  };

  Object.defineProperty(wrapped, TAG, { value: true });
  return wrapped as Fetch;
}

/**
 * Point a transformers.js `env` at a resumable fetch. Idempotent: a second
 * call (a re-run, another feature on the same page) leaves the first wrapper.
 * `env` is module-global per JS realm, so on the main thread this also covers
 * every other transformers.js load in the same tab. A worker is its own realm:
 * call it there too.
 */
export function installResumableFetch(
  // transformers.js types its `env.fetch` loosely ((string | URL, any) => Promise<any>).
  env: { fetch: (input: never, init?: never) => Promise<unknown> },
  opts?: ResumableFetchOptions,
): void {
  const current = env.fetch as unknown as Fetch & { [TAG]?: boolean };
  if (typeof current !== "function" || current[TAG]) return;
  env.fetch = createResumableFetch(current, opts);
}

function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/"/g, "");
}

function stallError(): Error {
  return new TypeError("network error: download stalled");
}

/** Race `promise` against `ms` of silence; on timeout call `onTimeout` and reject. */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  if (!(ms > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = stallError();
      onTimeout();
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
