import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createResumableFetch,
  downloadKindOf,
  installResumableFetch,
  parseContentRange,
} from "./resumable-fetch.js";

const URL_HF =
  "https://huggingface.co/onnx-community/whisper-base_timestamped/resolve/main/onnx/decoder_model_merged_q4.onnx";
const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

interface Call {
  url: string;
  range: string | null;
  cache?: RequestCache;
}

/** A stream of `bytes` in 100-byte chunks that errors after `failAfter` bytes. */
function body(bytes: Uint8Array, failAfter = Infinity): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream({
    pull(c) {
      if (pos >= failAfter) {
        c.error(new TypeError("network error"));
        return;
      }
      if (pos >= bytes.length) {
        c.close();
        return;
      }
      const end = Math.min(bytes.length, pos + 100, failAfter);
      c.enqueue(bytes.slice(pos, end));
      pos = end;
    },
  });
}

/**
 * A fake Hugging Face: 200 for a plain GET, 206 for `Range: bytes=N-`.
 * `failAfter[i]` makes response i error after that many bytes.
 */
function fakeHf(
  opts: {
    failAfter?: number[];
    headers?: Record<string, string>;
    resumeStatus?: number;
    resumeHeaders?: Record<string, string>;
    rejectCalls?: number[];
  } = {},
) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    const i = calls.length;
    calls.push({ url, range: headers.get("range"), cache: init?.cache });
    if (opts.rejectCalls?.includes(i)) throw new TypeError("Failed to fetch");
    const range = headers.get("range");
    const fail = opts.failAfter?.[i] ?? Infinity;
    if (!range) {
      return new Response(body(FILE, fail), {
        status: 200,
        headers: { "content-length": String(FILE.length), etag: '"abc"', ...opts.headers },
      });
    }
    const start = Number(/bytes=(\d+)-/.exec(range)![1]);
    const tail = FILE.slice(start);
    return new Response(body(tail, fail), {
      status: opts.resumeStatus ?? 206,
      headers: {
        "content-range": `bytes ${start}-${FILE.length - 1}/${FILE.length}`,
        etag: '"abc"',
        ...opts.resumeHeaders,
      },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const noSleep = async () => {};

async function readAll(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createResumableFetch", () => {
  it("resumes a dropped body with a Range request and stitches the bytes in order", async () => {
    const hf = fakeHf({ failAfter: [300, 400] });
    const onResume = vi.fn();
    const f = createResumableFetch(hf.fetch, { onResume, sleep: noSleep, stallMs: 0 });
    const res = await f(URL_HF, { headers: new Headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(await readAll(res)).toEqual(FILE);
    expect(hf.calls.map((c) => c.range)).toEqual([null, "bytes=300-", "bytes=700-"]);
    expect(hf.calls[1]).toMatchObject({ url: URL_HF, range: "bytes=300-", cache: "no-store" });
    expect(onResume).toHaveBeenCalledWith(URL_HF, 300);
    expect(onResume).toHaveBeenCalledWith(URL_HF, 700);
  });

  it("reports every byte the network delivered, across resumes", async () => {
    const hf = fakeHf({ failAfter: [300] });
    const seen: number[] = [];
    const f = createResumableFetch(hf.fetch, {
      onBytes: (url, n) => {
        expect(url).toBe(URL_HF);
        seen.push(n);
      },
      sleep: noSleep,
      stallMs: 0,
    });
    await readAll(await f(URL_HF));
    expect(seen.reduce((a, b) => a + b, 0)).toBe(FILE.length);
  });

  it("resumes more than once", async () => {
    const hf = fakeHf({ failAfter: [200, 300, Infinity] });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    const res = await f(URL_HF);
    expect(await readAll(res)).toEqual(FILE);
    expect(hf.calls.map((c) => c.range)).toEqual([null, "bytes=200-", "bytes=500-"]);
  });

  it("errors with the original failure, tagged dropped, when the resume answers 200", async () => {
    const hf = fakeHf({ failAfter: [300], resumeStatus: 200 });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    const res = await f(URL_HF);
    const err = await readAll(res).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe("network error");
    expect(downloadKindOf(err)).toBe("dropped");
    expect(hf.calls).toHaveLength(2);
  });

  it("refuses a resume whose etag differs", async () => {
    const hf = fakeHf({ failAfter: [300], resumeHeaders: { etag: '"other"' } });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    await expect(readAll(await f(URL_HF))).rejects.toThrow("network error");
  });

  it("refuses a resume whose total differs", async () => {
    const hf = fakeHf({
      failAfter: [300],
      resumeHeaders: { "content-range": "bytes 300-1999/2000" },
    });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    await expect(readAll(await f(URL_HF))).rejects.toThrow("network error");
  });

  it("refuses a resume that starts at the wrong byte", async () => {
    const hf = fakeHf({ failAfter: [300], resumeHeaders: { "content-range": "bytes 0-999/1000" } });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    await expect(readAll(await f(URL_HF))).rejects.toThrow("network error");
  });

  it("never resumes a content-encoded body", async () => {
    const hf = fakeHf({ failAfter: [300], headers: { "content-encoding": "gzip" } });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    await expect(readAll(await f(URL_HF))).rejects.toThrow("network error");
    expect(hf.calls).toHaveLength(1);
  });

  it("keeps trying the resume while it cannot connect, up to the budget", async () => {
    const hf = fakeHf({ failAfter: [300], rejectCalls: [1, 2] });
    const sleeps: number[] = [];
    const f = createResumableFetch(hf.fetch, {
      sleep: async (ms) => void sleeps.push(ms),
      stallMs: 0,
    });
    expect(await readAll(await f(URL_HF))).toEqual(FILE);
    expect(hf.calls.map((c) => c.range)).toEqual([null, "bytes=300-", "bytes=300-", "bytes=300-"]);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after maxResumes", async () => {
    const hf = fakeHf({ failAfter: [300], rejectCalls: [1, 2, 3] });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0, maxResumes: 2 });
    const err = await readAll(await f(URL_HF)).catch((e: unknown) => e);
    expect(downloadKindOf(err)).toBe("dropped");
    expect(hf.calls).toHaveLength(3);
  });

  it("tags a request that never got headers as unreachable", async () => {
    const hf = fakeHf({ rejectCalls: [0] });
    const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
    const err = await f(URL_HF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(downloadKindOf(err)).toBe("unreachable");
  });

  it("treats a stalled body as a drop and resumes", async () => {
    vi.useFakeTimers();
    let first = true;
    const calls: (string | null)[] = [];
    const base = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      calls.push(range);
      if (first) {
        first = false;
        let sent = false;
        // 300 bytes, then silence until aborted.
        const stream = new ReadableStream<Uint8Array>({
          pull(c) {
            if (!sent) {
              sent = true;
              c.enqueue(FILE.slice(0, 300));
              return;
            }
            return new Promise<void>((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new TypeError("aborted")));
            });
          },
        });
        return new Response(stream, { status: 200, headers: { "content-length": "1000" } });
      }
      return new Response(body(FILE.slice(300)), {
        status: 206,
        headers: { "content-range": "bytes 300-999/1000" },
      });
    }) as typeof fetch;
    const f = createResumableFetch(base, { stallMs: 30_000, sleep: noSleep });
    const res = await f(URL_HF);
    const done = readAll(res);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await done).toEqual(FILE);
    expect(calls).toEqual([null, "bytes=300-"]);
  });

  it("errors a body that ends short and cannot be resumed", async () => {
    const base = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get("range")) return new Response("nope", { status: 416 });
      return new Response(FILE.slice(0, 400), {
        status: 200,
        headers: { "content-length": "1000" },
      });
    }) as typeof fetch;
    const f = createResumableFetch(base, { sleep: noSleep, stallMs: 0 });
    const err = await readAll(await f(URL_HF)).catch((e: unknown) => e);
    expect(downloadKindOf(err)).toBe("dropped");
  });

  describe("passes through untouched", () => {
    const cases: [string, string, RequestInit | undefined][] = [
      ["another host", "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/x.wasm", undefined],
      ["a non-GET request", URL_HF, { method: "HEAD" }],
      ["a request with its own Range", URL_HF, { headers: { Range: "bytes=0-0" } }],
    ];
    for (const [name, url, init] of cases) {
      it(name, async () => {
        const res = new Response("x");
        const base = vi.fn(async () => res) as unknown as typeof fetch;
        const f = createResumableFetch(base, { stallMs: 0 });
        expect(await f(url, init)).toBe(res);
        expect(base).toHaveBeenCalledWith(url, init);
      });
    }

    it("a non-200 response", async () => {
      const res = new Response("missing", { status: 404 });
      const f = createResumableFetch((async () => res) as unknown as typeof fetch, { stallMs: 0 });
      expect(await f(URL_HF)).toBe(res);
    });

    it("the CDN host too (resumes there)", async () => {
      const hf = fakeHf({ failAfter: [300] });
      const cdn = "https://us.aws.cdn.hf.co/xet-bridge-us/abc";
      const f = createResumableFetch(hf.fetch, { sleep: noSleep, stallMs: 0 });
      expect(await readAll(await f(cdn))).toEqual(FILE);
      expect(hf.calls[1].url).toBe(cdn);
    });
  });
});

describe("installResumableFetch", () => {
  it("wraps env.fetch once", () => {
    const original = vi.fn() as unknown as typeof fetch;
    const env = { fetch: original };
    installResumableFetch(env);
    const first = env.fetch;
    expect(first).not.toBe(original);
    installResumableFetch(env);
    expect(env.fetch).toBe(first);
  });
});

describe("parseContentRange", () => {
  it("reads start and total", () => {
    expect(parseContentRange("bytes 1000-1999/82451730")).toEqual({ start: 1000, total: 82451730 });
    expect(parseContentRange("bytes */1000")).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });
});
