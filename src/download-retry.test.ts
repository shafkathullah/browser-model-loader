import { describe, expect, it, vi } from "vitest";

import {
  DOWNLOAD_DROPPED_MESSAGE,
  DOWNLOAD_UNREACHABLE_MESSAGE,
  ModelDownloadError,
  type RetryInfo,
  withDownloadRetry,
} from "./download-retry.js";
import {
  GENERIC_ERROR_MESSAGE,
  MODEL_DOWNLOAD_FAILED,
  OUT_OF_MEMORY_MESSAGE,
  friendlyModelError,
  friendlyToolError,
  friendlyToolErrorDetail,
  isModelDownloadError,
} from "./friendly-error.js";

const netErr = () => new TypeError("Failed to fetch");

function setup() {
  const sleeps: number[] = [];
  const retries: RetryInfo[] = [];
  return {
    sleeps,
    retries,
    opts: {
      sleep: async (ms: number) => void sleeps.push(ms),
      waitOnline: async () => {},
      onRetry: (i: RetryInfo) => void retries.push(i),
    },
  };
}

describe("withDownloadRetry", () => {
  it("returns the first successful attempt", async () => {
    const { opts, retries } = setup();
    const load = vi.fn(async () => "ok");
    await expect(withDownloadRetry(load, opts)).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
  });

  it("retries a download that made progress, then succeeds", async () => {
    const { opts, retries, sleeps } = setup();
    let n = 0;
    const result = await withDownloadRetry(async ({ attempt, markProgress }) => {
      n++;
      markProgress();
      if (attempt < 3) throw netErr();
      return attempt;
    }, opts);
    expect(result).toBe(3);
    expect(n).toBe(3);
    expect(retries).toEqual([
      { attempt: 2, max: 4, kind: "dropped" },
      { attempt: 3, max: 4, kind: "dropped" },
    ]);
    expect(sleeps).toEqual([2000, 5000]);
  });

  it("gives up after 4 attempts that made progress, as dropped", async () => {
    const { opts } = setup();
    const load = vi.fn(async ({ markProgress }: { markProgress: () => void }) => {
      markProgress();
      throw netErr();
    });
    const err = await withDownloadRetry(load, opts).catch((e: unknown) => e);
    expect(load).toHaveBeenCalledTimes(4);
    expect(err).toBeInstanceOf(ModelDownloadError);
    expect((err as ModelDownloadError).kind).toBe("dropped");
    expect((err as ModelDownloadError).attempts).toBe(4);
    expect((err as Error).message).toBe(DOWNLOAD_DROPPED_MESSAGE);
    // Keeps the cause's name, so telemetry grouped by error name still matches.
    expect((err as Error).name).toBe("TypeError");
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("stops after 2 attempts without progress, as unreachable", async () => {
    const { opts, retries } = setup();
    const load = vi.fn(async () => {
      throw netErr();
    });
    const err = await withDownloadRetry(load, opts).catch((e: unknown) => e);
    expect(load).toHaveBeenCalledTimes(2);
    expect((err as ModelDownloadError).kind).toBe("unreachable");
    expect((err as Error).message).toBe(DOWNLOAD_UNREACHABLE_MESSAGE);
    expect(retries).toEqual([{ attempt: 2, max: 2, kind: "unreachable" }]);
  });

  it("resets the no-progress streak when an attempt makes progress", async () => {
    const { opts } = setup();
    // no progress, progress, no progress, progress → 4 attempts, all used
    const pattern = [false, true, false, true];
    const load = vi.fn(async ({ attempt, markProgress }) => {
      if (pattern[attempt - 1]) markProgress();
      throw netErr();
    });
    const err = await withDownloadRetry(load, opts).catch((e: unknown) => e);
    expect(load).toHaveBeenCalledTimes(4);
    expect((err as ModelDownloadError).kind).toBe("dropped");
  });

  it("counts a body that was tagged dropped as progress", async () => {
    const { opts } = setup();
    const load = vi.fn(async () => {
      const e = netErr();
      Object.defineProperty(e, "downloadKind", { value: "dropped" });
      throw e;
    });
    const err = await withDownloadRetry(load, opts).catch((e: unknown) => e);
    expect(load).toHaveBeenCalledTimes(4);
    expect((err as ModelDownloadError).kind).toBe("dropped");
  });

  it("does not retry errors that are not downloads", async () => {
    const { opts } = setup();
    for (const e of [
      new Error("This tool needs WebGPU"),
      Object.assign(new Error("Failed to fetch"), { name: "AbortError" }),
      Object.assign(new Error("cache quota"), { name: "QuotaExceededError" }),
    ]) {
      const load = vi.fn(async () => {
        throw e;
      });
      await expect(withDownloadRetry(load, opts)).rejects.toBe(e);
      expect(load).toHaveBeenCalledTimes(1);
    }
  });

  it("lets the caller veto a retry", async () => {
    const { opts } = setup();
    const e = netErr();
    const load = vi.fn(async () => {
      throw e;
    });
    await expect(withDownloadRetry(load, { ...opts, shouldRetry: () => false })).rejects.toBe(e);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops without another attempt once the run is cancelled", async () => {
    const { opts } = setup();
    let cancelled = false;
    const e = netErr();
    const load = vi.fn(async ({ markProgress }: { markProgress: () => void }) => {
      markProgress();
      throw e;
    });
    const promise = withDownloadRetry(load, {
      ...opts,
      isCancelled: () => cancelled,
      sleep: async () => {
        cancelled = true;
      },
    });
    await expect(promise).rejects.toBe(e);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("waits for the browser to come online before retrying", async () => {
    const { opts } = setup();
    const order: string[] = [];
    await withDownloadRetry(
      async ({ attempt, markProgress }) => {
        order.push(`attempt ${attempt}`);
        markProgress();
        if (attempt === 1) throw netErr();
      },
      {
        ...opts,
        waitOnline: async () => void order.push("online"),
        sleep: async () => void order.push("sleep"),
      },
    );
    expect(order).toEqual(["attempt 1", "online", "sleep", "attempt 2"]);
  });
});

describe("the final messages", () => {
  it("pass through friendlyModelError instead of the generic line", () => {
    for (const kind of ["dropped", "unreachable"] as const) {
      const err = new ModelDownloadError(kind, 2, netErr());
      expect(isModelDownloadError(err)).toBe(false);
      expect(friendlyModelError(err)).toBe(err.message);
      expect(friendlyModelError(err.message)).toBe(err.message);
      expect(err.message).not.toMatch(/—/);
    }
  });

  it("keep their own line in friendlyToolError, as error or as string", () => {
    for (const kind of ["dropped", "unreachable"] as const) {
      const err = new ModelDownloadError(kind, 2, netErr());
      expect(friendlyToolError(err)).toBe(err.message);
      expect(friendlyToolError(err.message)).toBe(err.message);
    }
  });
});

describe("friendlyToolError", () => {
  it("names a failed download and an out-of-memory tab", () => {
    expect(friendlyToolError(netErr())).toBe(MODEL_DOWNLOAD_FAILED);
    expect(friendlyToolError("Failed to fetch")).toBe(MODEL_DOWNLOAD_FAILED);
    expect(friendlyToolError(new RangeError("Array buffer allocation failed"))).toBe(
      OUT_OF_MEMORY_MESSAGE,
    );
    expect(friendlyToolError("Aborted(). Out of memory")).toBe(OUT_OF_MEMORY_MESSAGE);
    expect(friendlyToolError(OUT_OF_MEMORY_MESSAGE)).toBe(OUT_OF_MEMORY_MESSAGE);
    expect(friendlyToolError(MODEL_DOWNLOAD_FAILED)).toBe(MODEL_DOWNLOAD_FAILED);
  });

  it("swaps model, runtime and canvas text for one plain line", () => {
    for (const raw of [
      "BiRefNet did not return an output_image tensor",
      "Canvas 2D context unavailable",
      "Upscaler was stopped",
      "Model config has no labels",
      new Error("failed to call OrtRun(). ERROR_CODE: 1"),
      undefined,
    ]) {
      expect(friendlyToolError(raw)).toBe(GENERIC_ERROR_MESSAGE);
      expect(friendlyToolErrorDetail(raw)).toBeUndefined();
    }
  });
});
