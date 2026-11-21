import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureModelRegistry,
  getModelRegistryConfig,
  listModels,
  recordLoad,
  touch,
} from "./registry.js";

function fakeWindow() {
  const store = new Map<string, string>();
  const events: string[] = [];
  return {
    events,
    store,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent: (e: { type: string }) => {
      events.push(e.type);
      return true;
    },
  };
}

describe("model registry", () => {
  let win: ReturnType<typeof fakeWindow>;
  beforeEach(() => {
    win = fakeWindow();
    vi.stubGlobal("window", win);
    vi.stubGlobal(
      "CustomEvent",
      class {
        constructor(public type: string) {}
      },
    );
    configureModelRegistry({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("records a load under the default key and fires the change event", () => {
    recordLoad({ id: "org/model", label: "Model", library: "transformers-js", task: "asr" });
    expect(win.store.has("browser-model-loader:models:v1")).toBe(true);
    expect(win.events).toContain("browser-model-loader:models-changed");
    const [meta] = listModels();
    expect(meta).toMatchObject({ id: "org/model", label: "Model", sizeBytes: 0 });
    expect(meta).not.toHaveProperty("source");
  });

  it("uses the configured key, event and cache names", () => {
    configureModelRegistry({ storageKey: "app:models", changeEvent: "app:changed", cacheNames: ["a", "b"] });
    recordLoad({ id: "org/m", label: "M", library: "webllm", task: "text-generation", source: "/chat" });
    expect(win.store.has("app:models")).toBe(true);
    expect(win.events).toContain("app:changed");
    expect(getModelRegistryConfig().cacheNames).toEqual(["a", "b"]);
    expect(listModels()[0]).toMatchObject({ source: "/chat" });
  });

  it("keeps downloadedAt and bumps lastUsedAt on touch", async () => {
    recordLoad({ id: "org/m", label: "M", library: "transformers-js", task: "asr" });
    const first = listModels()[0]!;
    await new Promise((r) => setTimeout(r, 5));
    touch("org/m");
    const second = listModels()[0]!;
    expect(second.downloadedAt).toBe(first.downloadedAt);
    expect(second.lastUsedAt).toBeGreaterThan(first.lastUsedAt);
  });
});
