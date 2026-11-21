/// <reference lib="webworker" />

/**
 * A Whisper worker wired the way PocketWebTools runs it in production:
 *
 * - WebGPU with an fp32 encoder + q4 decoder when the main thread found an
 *   adapter, q8 on WASM otherwise. (PocketWebTools also sends phones to WASM,
 *   where the WebGPU weights can crash the tab; that check isn't shown here.)
 * - The resumable fetch installed in THIS realm (a worker has its own
 *   transformers.js `env`), reporting resumes and real network bytes back.
 * - The GPU device-loss watch installed before any library asks for a device,
 *   so a crash mid-run reports "WebGPU device lost" instead of a cryptic error.
 * - The temporary Whisper KV-cache fix for word timestamps.
 *
 * Messages in:  { type: "load", id, device } | { type: "transcribe", id, audio }
 * Messages out: { type: "progress" | "resume" | "net" | "loaded" | "result" | "error", id, ... }
 */

import {
  deviceLossMessage,
  installResumableFetch,
  installWhisperKvCacheFix,
  watchGpuDeviceLoss,
} from "browser-model-loader";

const MODEL_ID = "onnx-community/whisper-base_timestamped";

type Device = "webgpu" | "wasm";
type Asr = (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>;

// Before any library asks for a GPU device.
const lostInfo = watchGpuDeviceLoss();

let asrPromise: Promise<Asr> | null = null;
let currentLoad = 0;
const netSent = new Set<number>();

async function load(id: number, device: Device) {
  currentLoad = id;
  try {
    const t = await import("@huggingface/transformers");
    installResumableFetch(t.env, {
      onResume: () => postMessage({ type: "resume", id: currentLoad }),
      // Bytes off the wire (not cache replays): what the main thread's retry counts as progress.
      onBytes: () => {
        if (netSent.has(currentLoad)) return;
        netSent.add(currentLoad);
        postMessage({ type: "net", id: currentLoad });
      },
    });
    const progress_callback = (info: unknown) => postMessage({ type: "progress", id, info });
    asrPromise ??= t.pipeline(
      "automatic-speech-recognition",
      MODEL_ID,
      device === "webgpu"
        ? {
            dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
            device: "webgpu",
            progress_callback,
          }
        : { dtype: "q8", device: "wasm", progress_callback },
    ) as unknown as Promise<Asr>;
    const asr = await asrPromise;
    installWhisperKvCacheFix((asr as unknown as { model: object }).model);
    postMessage({ type: "loaded", id });
  } catch (err) {
    asrPromise = null;
    await postError(id, err);
  }
}

async function transcribe(id: number, audio: Float32Array) {
  try {
    if (!asrPromise) throw new Error("Whisper is not loaded.");
    const asr = await asrPromise;
    const result = await asr(audio, { return_timestamps: "word", chunk_length_s: 30 });
    postMessage({ type: "result", id, result });
  } catch (err) {
    await postError(id, err);
  }
}

async function postError(id: number, err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  const loss = await lostInfo();
  postMessage({
    type: "error",
    id,
    name: err instanceof Error ? err.name : "Error",
    // Keep the tag the resumable fetch put on the error, so the main thread's retry can read it.
    downloadKind: (err as { downloadKind?: string } | null)?.downloadKind ?? null,
    error: loss ? deviceLossMessage(loss, raw) : raw,
  });
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | { type: "load"; id: number; device: Device }
    | { type: "transcribe"; id: number; audio: Float32Array };
  if (msg.type === "load") void load(msg.id, msg.device);
  else void transcribe(msg.id, msg.audio);
};
