import { afterAll, beforeEach, describe, expect, it } from "vitest";


import {
  deviceLossMessage,
  resetGpuDeviceLossForTests,
  watchGpuDeviceLoss,
} from "./gpu-device-loss.js";

/** A stand-in for a GPUDevice whose `lost` promise the test resolves. */
function fakeDevice() {
  let lose!: (info: { reason: string; message: string }) => void;
  const lost = new Promise<{ reason: string; message: string }>((r) => (lose = r));
  return { device: { lost }, lose };
}

const queue: ReturnType<typeof fakeDevice>[] = [];

class FakeAdapter {
  requestDevice() {
    return Promise.resolve(queue.shift()!.device);
  }
}

const g = globalThis as { GPUAdapter?: unknown };
g.GPUAdapter = FakeAdapter;
afterAll(() => {
  delete g.GPUAdapter;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("watchGpuDeviceLoss", () => {
  beforeEach(() => resetGpuDeviceLossForTests());

  it("reports nothing while the device is alive, then the loss", async () => {
    const lostInfo = watchGpuDeviceLoss();
    const a = fakeDevice();
    queue.push(a);
    await new FakeAdapter().requestDevice();
    expect(await lostInfo(5)).toBeNull();
    a.lose({ reason: "unknown", message: "GPU process crashed" });
    await tick();
    expect(await lostInfo(0)).toEqual({ reason: "unknown", message: "GPU process crashed" });
  });

  it("forgets an old device's loss once a new device is created", async () => {
    const lostInfo = watchGpuDeviceLoss();
    const a = fakeDevice();
    queue.push(a);
    await new FakeAdapter().requestDevice();
    a.lose({ reason: "destroyed", message: "" });
    await tick();
    expect((await lostInfo(0))?.reason).toBe("destroyed");
    queue.push(fakeDevice());
    await new FakeAdapter().requestDevice();
    expect(await lostInfo(5)).toBeNull();
  });

  it("waits for a loss that is reported just after the library's error", async () => {
    const lostInfo = watchGpuDeviceLoss();
    const a = fakeDevice();
    queue.push(a);
    await new FakeAdapter().requestDevice();
    // The error reached the catch first; the device's `lost` resolves 20 ms later.
    setTimeout(() => a.lose({ reason: "unknown", message: "" }), 20);
    expect(await lostInfo(500)).toEqual({ reason: "unknown", message: "" });
  });

  it("wraps requestDevice only once however often it is called", async () => {
    watchGpuDeviceLoss();
    const wrapped = FakeAdapter.prototype.requestDevice;
    watchGpuDeviceLoss();
    expect(FakeAdapter.prototype.requestDevice).toBe(wrapped);
  });

  it("builds a message that names the WebGPU loss and keeps the original", () => {
    const msg = deviceLossMessage(
      { reason: "unknown", message: "" },
      "Object has already been disposed",
    );
    expect(msg).toBe("WebGPU device lost (unknown): Object has already been disposed");
    expect(/webgpu/i.test(msg)).toBe(true);
  });
});
