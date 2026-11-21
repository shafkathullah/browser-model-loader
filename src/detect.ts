import type { DeviceType } from "./types.js";

/**
 * Probe `navigator.gpu` for an actual adapter — feature-detect alone isn't
 * enough on iOS Safari (the property exists but `requestAdapter()` returns
 * null on most devices). The result is cached per realm, so every caller
 * shares one adapter check.
 */

let cached: Promise<DeviceType> | null = null;

export function detectDevice(): Promise<DeviceType> {
  if (cached) return cached;
  cached = (async () => {
    if (typeof navigator === "undefined") return "wasm";
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return "wasm";
    try {
      const adapter = await gpu.requestAdapter();
      return adapter ? "webgpu" : "wasm";
    } catch {
      return "wasm";
    }
  })();
  return cached;
}

let cachedF16: Promise<boolean> | null = null;

/**
 * Whether the WebGPU adapter can run fp16 shaders (`shader-f16`). An fp16 ONNX
 * export on an adapter without it fails at session creation, so request fp16
 * weights on WebGPU only when this is true and fall back to fp32 otherwise.
 */
export function supportsShaderF16(): Promise<boolean> {
  if (cachedF16) return cachedF16;
  cachedF16 = (async () => {
    if (typeof navigator === "undefined") return false;
    const gpu = (
      navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<{ features: { has(f: string): boolean } } | null> };
      }
    ).gpu;
    if (!gpu) return false;
    try {
      const adapter = await gpu.requestAdapter();
      return adapter ? adapter.features.has("shader-f16") : false;
    } catch {
      return false;
    }
  })();
  return cachedF16;
}

export function resetDeviceCache(): void {
  cached = null;
  cachedF16 = null;
}
