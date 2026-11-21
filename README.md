# browser-model-loader

Small helpers that make in-browser AI model loads survive real networks and real devices.

I pulled these out of [PocketWebTools](https://pocketweb.tools), a set of free AI tools (voice cloning, transcription, background removal and more) that run entirely in the browser with transformers.js, ONNX Runtime Web and WebLLM. Several came straight from production failures, like a phone's GPU disappearing mid-run and a download host that was blocked on a user's network.

It does not replace transformers.js or WebLLM. It wraps the parts around them.

## What's in it

| Helper | What it does |
|---|---|
| `installResumableFetch(env)` | When a Hugging Face model file drops partway, it asks for the rest with an HTTP `Range` request and stitches it onto the same stream, so the bytes already received aren't thrown away. It only accepts the tail when the server proves it's the same file (`206`, matching `content-range` and total, matching `etag`). Anything else fails the normal way. |
| `withDownloadRetry(load)` | Retries a whole model load on network failures, with two budgets: "dropped" (it was downloading, then died) and "unreachable" (nothing ever arrived, so the host is probably blocked on this network and more tries won't help). Ends with a plain error message a user can act on. |
| `createDownloadProgress()` | Turns transformers.js's `progress_total` events into one progress bar that never jumps backwards and names the biggest file still downloading. |
| `detectDevice()`, `supportsShaderF16()` | Checks for a real WebGPU adapter (not just `navigator.gpu`, which can exist with no usable adapter behind it) and whether fp16 shaders are supported. |
| `watchGpuDeviceLoss()` | Notices when the WebGPU device is lost under a library (common on Android), so the error you show says so instead of "Object has already been disposed". |
| `friendlyModelError(err)`, `friendlyToolError(err)` | Turn "Failed to fetch" and Cache API errors into one plain sentence. `friendlyToolError` also catches out-of-memory errors and hides raw runtime text. |
| `recordLoad()`, `listModels()`, `removeModel()`, `reconcile()`... | A small registry of which models are cached, how big they are and when they were last used, for a "manage downloaded models" screen. |
| `installWhisperKvCacheFix(model)` | **Temporary.** Works around a transformers.js GPU memory leak with Whisper word timestamps. Remove it once upstream fixes the leak ([issue #1739](https://github.com/huggingface/transformers.js/issues/1739), [PR #1755](https://github.com/huggingface/transformers.js/pull/1755)). |

## Why resumable downloads

transformers.js keeps each model file in memory until the whole file arrives, and only then caches it. If the connection drops at 80 MB of a 124 MB file, the next try starts from zero. On a phone on mobile data that can mean the model never loads.

Resuming is still an open request upstream ([#1220](https://github.com/huggingface/transformers.js/issues/1220)), and the open PR that adds it ([#1715](https://github.com/huggingface/transformers.js/pull/1715)) covers Node's file cache, not the browser.

## Install

```sh
npm install browser-model-loader
```

## Use

On the thread that loads the model:

```ts
import {
  createDownloadProgress,
  friendlyModelError,
  installResumableFetch,
  withDownloadRetry,
} from "browser-model-loader";

const t = await import("@huggingface/transformers");

// Count only bytes that came off the network. Cached files replay their progress
// events on every attempt, so progress events can't tell "downloading" from "blocked".
let markNetwork = () => {};
installResumableFetch(t.env, {
  onBytes: () => markNetwork(),
  onResume: (url, bytesKept) => console.log(`Resumed ${url} at ${bytesKept} bytes`),
});

const toBar = createDownloadProgress();
try {
  const asr = await withDownloadRetry(({ markProgress }) => {
    markNetwork = markProgress;
    return t.pipeline("automatic-speech-recognition", "onnx-community/whisper-base_timestamped", {
      progress_callback: (event) => {
        const bar = toBar(event);
        if (bar) drawBar(bar.loaded, bar.total, bar.file);
      },
    });
  });
} catch (err) {
  showError(friendlyModelError(err));
}
```

A worker has its own transformers.js `env`, so call `installResumableFetch` inside the worker. [`examples/whisper`](examples/whisper) shows that split, the way PocketWebTools runs Whisper: the worker loads the model (WebGPU with an fp32 encoder and q4 decoder when an adapter is found, q8 on WASM otherwise), installs the resumable fetch and device-loss watch, and forwards network bytes; the main thread runs the retries and the progress bar. The example typechecks against the library but hasn't been run as a standalone demo yet.

## Registry

The registry stores its metadata in `localStorage` and reads sizes from the Cache API. Defaults: key `browser-model-loader:models:v1`, change event `browser-model-loader:models-changed`, cache store `transformers-cache`. Change them once at startup if you need to:

```ts
import { configureModelRegistry } from "browser-model-loader";

configureModelRegistry({ cacheNames: ["transformers-cache", "my-app-models"] });
```

## Notes

- Browser-first. The registry needs `window` (it uses `localStorage`); the other helpers also work inside workers. Without browser APIs they do nothing harmful.
- The resumable fetch only touches plain `GET` requests to `huggingface.co`, `*.huggingface.co` and `*.hf.co`. Everything else passes straight through.
- Built against transformers.js 4.3. The resume path was checked in Chrome 157 on 21 Nov 2026: from another origin, Hugging Face's `206` response exposes `content-range` and `etag` to the page, which the resume check needs.

## License

MIT
