/**
 * TEMPORARY WORKAROUND. Frees the Whisper KV cache that transformers.js leaks
 * with word timestamps. Remove it once upstream fixes the leak: see
 * huggingface/transformers.js issue #1739 and PR #1755.
 *
 * transformers.js 4.2 / 4.3: `return_timestamps: "word"` sets
 * `return_dict_in_generate`, so `PreTrainedModel.generate` skips
 * `past_key_values.dispose()` (`keepCacheAlive`, models/modeling_utils.js) and
 * returns the cache. `WhisperForConditionalGeneration._generate_with_seek`
 * calls `super.generate` once per seek pass and never reads or frees it. On
 * WebGPU the cache tensors are `gpu-buffer` outputs that ONNX Runtime Web only
 * frees on an explicit dispose (garbage collection never does), so every pass
 * leaks its whole cache.
 *
 * Measured 2026-10-01 in headless Chrome (M1 Pro, Whisper Base timestamped,
 * fp32 encoder + q4 decoder): +52 MB of GPU memory per pass, 6 passes per
 * minute of audio, ~18.7 GB per hour, linear. With this fix GPU memory stays
 * flat (~0.8 GB over 120 passes) and the transcript is identical. Segment
 * timestamps (`return_timestamps: true`) are not affected.
 *
 * The fix defines an own `generate` on the Whisper model's PARENT prototype
 * (WhisperPreTrainedModel), which is where the seek loop's `super.generate`
 * lands; an instance-level patch would never be hit. It disposes the returned
 * cache unless the caller passed its own `past_key_values` in. Guarded: if the
 * library's shape changes it does nothing and says so.
 */

const MARK = Symbol.for("browser-model-loader.whisperKvFix");

type Generate = (this: unknown, ...args: unknown[]) => Promise<unknown>;

export function installWhisperKvCacheFix(model: object): boolean {
  const cls = Object.getPrototypeOf(model) as object | null;
  if (!cls || !Object.hasOwn(cls, "_generate_with_seek")) {
    console.warn("Whisper KV cache fix not applied: no _generate_with_seek on this model.");
    return false;
  }
  const parent = Object.getPrototypeOf(cls) as (Record<PropertyKey, unknown> & object) | null;
  if (!parent || typeof parent.generate !== "function") {
    console.warn("Whisper KV cache fix not applied: no parent generate.");
    return false;
  }
  if (parent[MARK]) return true;

  const inherited = parent.generate as Generate;
  const generate: Generate = async function (this: unknown, ...args) {
    const out = await inherited.apply(this, args);
    const passed = (args[0] as { past_key_values?: unknown } | undefined)?.past_key_values;
    const cache = (out as { past_key_values?: { dispose?: unknown } } | null)?.past_key_values;
    if (cache && cache !== passed && typeof cache.dispose === "function") {
      await (cache.dispose as () => Promise<void> | void).call(cache);
    }
    return out;
  };
  Object.defineProperty(parent, "generate", {
    value: generate,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(parent, MARK, { value: true });
  return true;
}
