/**
 * Notice when a WebGPU device dies under a model library, so the error that
 * follows can say so.
 *
 * Why: when the GPU process crashes or the OS reclaims memory (Android, mostly),
 * the library running on that device throws whatever its next call trips over.
 * ONNX Runtime says `failed to call OrtRun() ... webgpu/buffer_manager.cc`, which
 * happens to contain "webgpu"; WebLLM's TVM runtime disposes itself and the next
 * completion throws "Object has already been disposed", which does not. Error
 * telemetry that groups by message files the two differently, and neither
 * tells the user what happened.
 *
 * `watchGpuDeviceLoss()` wraps `GPUAdapter.prototype.requestDevice` once per
 * realm (a worker is its own realm) and remembers the `lost` info of the most
 * recently created device. Every new device resets it, so a retry on a fresh
 * device never inherits an old loss. The check it returns is what an error
 * handler awaits; `deviceLossMessage` prefixes the original message with
 * "WebGPU device lost", so a classifier matching /webgpu/i files it as a
 * WebGPU failure.
 */

export interface GpuDeviceLoss {
  /** `GPUDeviceLostReason`: "destroyed" (someone called `destroy()`) or "unknown" (the real crashes). */
  reason: string;
  message: string;
}

const TAG = Symbol.for("browser-model-loader.gpuDeviceLossWatch");

let lastLoss: GpuDeviceLoss | null = null;
/** The newest device's `lost`, mapped; null before any device exists. */
let latestLoss: Promise<GpuDeviceLoss> | null = null;
let generation = 0;

type RequestDevice = (this: unknown, ...args: unknown[]) => Promise<unknown>;

/**
 * Install the watch (idempotent) and return a check for the latest device's
 * loss. The check waits up to `graceMs` for a loss that has not been reported
 * yet: a library error and the `lost` promise race each other (after
 * `device.destroy()`, ONNX Runtime's `OrtRun()` error can reach the catch
 * before `lost` resolves).
 */
export function watchGpuDeviceLoss(): (graceMs?: number) => Promise<GpuDeviceLoss | null> {
  const proto = (
    globalThis as unknown as { GPUAdapter?: { prototype: Record<PropertyKey, unknown> } }
  ).GPUAdapter?.prototype;
  if (proto && !proto[TAG] && typeof proto.requestDevice === "function") {
    const original = proto.requestDevice as RequestDevice;
    proto.requestDevice = async function requestDevice(this: unknown, ...args: unknown[]) {
      const device = (await original.apply(this, args)) as {
        lost?: Promise<{ reason?: string; message?: string }>;
      };
      const gen = ++generation;
      lastLoss = null;
      latestLoss =
        device?.lost?.then((info) => {
          const loss = { reason: info?.reason ?? "unknown", message: info?.message ?? "" };
          // Only if no newer device replaced this one meanwhile.
          if (gen === generation) lastLoss = loss;
          return loss;
        }) ?? null;
      return device;
    };
    proto[TAG] = true;
  }
  return async (graceMs = 250) => {
    if (lastLoss || !latestLoss) return lastLoss;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([
      latestLoss,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), graceMs))),
    ]);
    clearTimeout(timer);
    return late && lastLoss ? lastLoss : null;
  };
}

/** "WebGPU device lost (unknown): <original>": names the cause, keeps the original text. */
export function deviceLossMessage(loss: GpuDeviceLoss, original: string): string {
  return `WebGPU device lost (${loss.reason}): ${original}`;
}

/** Test hook: forget the recorded loss. */
export function resetGpuDeviceLossForTests(): void {
  lastLoss = null;
  latestLoss = null;
}
