import { describe, expect, it, vi } from "vitest";

import { installWhisperKvCacheFix } from "./whisper-kv-cache-fix.js";

/** The transformers.js shape: PreTrainedModel → WhisperPreTrainedModel → WhisperForConditionalGeneration. */
function makeClasses() {
  const dispose = vi.fn(async () => {});
  class Base {
    async generate(options: { past_key_values?: unknown } = {}) {
      return {
        sequences: [1, 2, 3],
        past_key_values: options.past_key_values ?? { dispose },
      };
    }
  }
  class Mid extends Base {}
  class Whisper extends Mid {
    async _generate_with_seek() {
      // Two seek passes, like a 30 s chunk that needed a re-run.
      const a = await super.generate();
      const b = await super.generate();
      return [a, b];
    }
  }
  return { dispose, Base, Mid, Whisper };
}

describe("installWhisperKvCacheFix", () => {
  it("disposes the cache every inner generate returns", async () => {
    const { dispose, Whisper } = makeClasses();
    const model = new Whisper();
    expect(installWhisperKvCacheFix(model)).toBe(true);
    const [a] = await model._generate_with_seek();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(a.sequences).toEqual([1, 2, 3]);
  });

  it("does not wrap twice", async () => {
    const { dispose, Whisper } = makeClasses();
    const model = new Whisper();
    installWhisperKvCacheFix(model);
    expect(installWhisperKvCacheFix(new Whisper())).toBe(true);
    await model._generate_with_seek();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("leaves a cache the caller passed in alone", async () => {
    const { Whisper, Mid } = makeClasses();
    const model = new Whisper();
    installWhisperKvCacheFix(model);
    const own = { dispose: vi.fn() };
    await Mid.prototype.generate.call(model, { past_key_values: own });
    expect(own.dispose).not.toHaveBeenCalled();
  });

  it("does nothing to a model without the seek loop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dispose, Mid } = makeClasses();
    const model = new Mid();
    expect(installWhisperKvCacheFix(model)).toBe(false);
    expect(Object.hasOwn(Mid.prototype, "generate")).toBe(false);
    await model.generate();
    expect(dispose).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
