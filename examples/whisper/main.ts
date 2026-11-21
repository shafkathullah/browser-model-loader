/**
 * Main-thread side of the Whisper example: pick the device, load with retries,
 * draw one progress bar, record the model in the registry, and show a plain
 * error line when it all fails.
 */

import {
  type ProgressEvent,
  createDownloadProgress,
  detectDevice,
  friendlyModelError,
  recordLoad,
  measureModel,
  withDownloadRetry,
} from "browser-model-loader";

const MODEL_ID = "onnx-community/whisper-base_timestamped";

export async function loadWhisper(
  onBar: (loaded: number, total: number, file?: string) => void,
  onNotice: (text: string) => void,
): Promise<Worker> {
  const device = await detectDevice();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let nextId = 0;

  try {
    await withDownloadRetry(
      ({ markProgress }) =>
        new Promise<void>((resolve, reject) => {
          const id = ++nextId;
          const toBar = createDownloadProgress();
          worker.onmessage = (e: MessageEvent) => {
            const msg = e.data as {
              type: string;
              id: number;
              info?: ProgressEvent;
              error?: string;
              name?: string;
              downloadKind?: string | null;
            };
            if (msg.id !== id) return;
            if (msg.type === "net") markProgress();
            if (msg.type === "resume") onNotice("Connection dropped. Resuming the download…");
            if (msg.type === "progress" && msg.info) {
              const bar = toBar(msg.info);
              if (bar) onBar(bar.loaded, bar.total, bar.file);
            }
            if (msg.type === "loaded") resolve();
            if (msg.type === "error") {
              const err = Object.assign(new Error(msg.error), { name: msg.name ?? "Error" });
              if (msg.downloadKind) Object.assign(err, { downloadKind: msg.downloadKind });
              reject(err);
            }
          };
          worker.postMessage({ type: "load", id, device });
        }),
      {
        onRetry: ({ attempt, max }) => onNotice(`Download failed. Retrying (${attempt} of ${max})…`),
      },
    );
  } catch (err) {
    worker.terminate();
    throw new Error(friendlyModelError(err), { cause: err });
  }

  recordLoad({ id: MODEL_ID, label: "Whisper Base", library: "transformers-js", task: "automatic-speech-recognition" });
  void measureModel(MODEL_ID);
  return worker;
}
