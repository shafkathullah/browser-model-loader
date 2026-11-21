import { describe, expect, it } from "vitest";

import { createDownloadProgress, createFileProgressTotal } from "./download-progress.js";

describe("createDownloadProgress", () => {
  it("ignores per-file events, which jump between files", () => {
    const toBar = createDownloadProgress();
    expect(toBar({ status: "progress", loaded: 5, total: 10 })).toBeNull();
    expect(toBar({ status: "initiate" })).toBeNull();
  });

  it("uses the summed total and names the biggest unfinished file", () => {
    const toBar = createDownloadProgress();
    expect(
      toBar({
        status: "progress_total",
        loaded: 60,
        total: 200,
        files: {
          "config.json": { loaded: 10, total: 10 },
          "onnx/decoder.onnx": { loaded: 20, total: 40 },
          "onnx/encoder.onnx": { loaded: 30, total: 150 },
        },
      }),
    ).toEqual({ file: "onnx/encoder.onnx", loaded: 60, total: 200 });
  });

  it("never steps back when a late file grows the total", () => {
    const toBar = createDownloadProgress();
    toBar({ status: "progress_total", loaded: 50, total: 100 });
    const next = toBar({ status: "progress_total", loaded: 55, total: 200 });
    expect(next?.loaded).toBe(100); // held at 50%, not 27.5%
    expect(next?.total).toBe(200);
  });

  it("skips events with no usable total", () => {
    const toBar = createDownloadProgress();
    expect(toBar({ status: "progress_total", loaded: 5, total: 0 })).toBeNull();
    expect(toBar({ status: "progress_total", loaded: 5 })).toBeNull();
  });
});

describe("createFileProgressTotal", () => {
  it("sums every file against the expected total, so the bar's total is the promised size", () => {
    const sum = createFileProgressTotal(1000);
    expect(sum({ status: "initiate", file: "config.json" })).toBeNull();
    expect(
      sum({ status: "progress", file: "tokenizer.json", loaded: 50, total: 100 }),
    ).toMatchObject({ status: "progress_total", loaded: 50, total: 1000 });
    expect(
      sum({ status: "progress", file: "/model.quant.onnx", loaded: 400, total: 880 }),
    ).toMatchObject({ loaded: 450, total: 1000 });
    // A file's later event replaces its earlier one instead of adding to it.
    expect(
      sum({ status: "progress", file: "tokenizer.json", loaded: 100, total: 100 }),
    ).toMatchObject({ loaded: 500, total: 1000 });
  });

  it("grows the total only when the files turn out bigger than expected", () => {
    const sum = createFileProgressTotal(100);
    expect(sum({ status: "progress", file: "a", loaded: 10, total: 150 })).toMatchObject({
      loaded: 10,
      total: 150,
    });
  });

  it("feeds createDownloadProgress", () => {
    const sum = createFileProgressTotal(200);
    const toBar = createDownloadProgress();
    expect(toBar(sum({ status: "progress", file: "m.onnx", loaded: 100, total: 180 })!)).toEqual({
      file: "m.onnx",
      loaded: 100,
      total: 200,
    });
  });
});
