// T14 Step4: real lifecycle-boundary evidence for the QQ image worker host (spec §11).
//
// What this file actually proves, no more:
//   * the production host (`runQqImagePreparation`) really spawns a native worker thread,
//     really calls `terminate()` after completion and on abort, and the thread really exits;
//   * a sustained legal input (bounded 16 MiB repeated-frame GIF on a 64x64 canvas) runs to
//     completion through the same host — the wall clock it takes is recorded as evidence for
//     the batch report's deadline status, it is not an assertion here;
//   * an abort while a sustained job is still unsettled settles as `cancelled` with the
//     caller's reason, the thread is terminated and exits, and NO worker message is ever
//     published afterwards — the closed gate holds under a real thread.
//
// What this file does NOT claim:
//   * that the abort interrupts the CPU decode loop instruction-by-instruction — the native
//     and synchronous calls inside the worker cannot be observed from outside, and terminate
//     is the only real stop (the host module says so itself);
//   * that the 30 s deadline fired or that it cannot fire — this experiment only measures
//     one input's unsettled window and proves nothing about the deadline branch either way;
//     see the batch report for the measured numbers and the unproved table.
//
// The mid-window abort test infers "still unsettled" from the full-run duration measured in
// the SAME process on the SAME input (abort at measured/3): it does not use a fixed sleep as
// proof of the CPU loop. The abort settlement itself is what is asserted.
//
// Observation mechanism: a local `Worker.prototype` spy captures the worker the production
// host spawns and restores the prototype in `finally` — no module mock, no global patch
// leak, no production or test hooks.
//
// The full-run duration is measured by `measureFullRun` — the same real production worker
// and the same assertions the completion test uses, extracted into one shared function. The
// completion test caches the result; the mid-window abort test reuses the cache when the
// completion test has already run in this process, and otherwise measures once itself, so
// the abort position is always grounded in a real same-process run and never in a fixed
// sleep. The spy is installed only AFTER the (possible) measuring run, so the spy observes
// exactly the lifecycle under test.
//
// Input construction is bounded: one 64x64 frame block is encoded twice with the omggif
// writer and the block is repeated into a fixed 16 MiB buffer (block concat, never a
// width*height*frames*4 allocation). The 16 MiB encoded cap is this experiment's own
// resource bound, NOT a product limit; the production 64 MiB safety boundary is untouched.

import { describe, expect, it } from "bun:test";
import { Worker } from "node:worker_threads";
import upstream from "omggif";
import { QqImagePrepareError } from "../../src/server/services/qq-image-error";
import { runQqImagePreparation } from "../../src/server/services/qq-image-worker";

const CANVAS = 64;
/** This experiment's own encoded self-limit, not a product cap. */
const TARGET_BYTES = 16 * 1024 * 1024;
/** Abort position for the mid-window test, as a fraction of the measured full run. */
const ABORT_FRACTION = 3;

interface WorkerObservation {
  spawned: boolean;
  messages: string[];
  exits: number[];
  terminateCalls: number;
  terminateDone: Promise<unknown> | null;
  restore(): void;
}

function installWorkerSpy(): WorkerObservation {
  const originalOn = Worker.prototype.on;
  const originalTerminate = Worker.prototype.terminate;
  const observation: WorkerObservation = {
    spawned: false,
    messages: [],
    exits: [],
    terminateCalls: 0,
    terminateDone: null,
    restore() {
      Worker.prototype.on = originalOn;
      Worker.prototype.terminate = originalTerminate;
    },
  };
  const spyOn = function (this: Worker, event: string, listener: never) {
    if (!observation.spawned) {
      observation.spawned = true;
      originalOn.call(this, "message", (message: { kind?: string }) => {
        observation.messages.push(String(message?.kind ?? "unknown"));
      });
      originalOn.call(this, "exit", (code: number) => {
        observation.exits.push(code);
      });
    }
    return originalOn.call(this, event, listener);
  };
  const spyTerminate = function (this: Worker) {
    observation.terminateCalls += 1;
    const done = originalTerminate.call(this);
    observation.terminateDone = done;
    return done;
  };
  Worker.prototype.on = spyOn as unknown as typeof Worker.prototype.on;
  Worker.prototype.terminate = spyTerminate as unknown as typeof Worker.prototype.terminate;
  return observation;
}

let sustainedGif: { bytes: Uint8Array; frames: number } | null = null;

/**
 * One solid 64x64 frame block, repeated by concat up to the 16 MiB self-limit. Encoding runs
 * twice on tiny buffers (one frame, two frames); the frame block is then spliced out and
 * repeated, so generation cost is O(bytes), independent of the frame count's pixel volume.
 */
function makeSustainedGif(): { bytes: Uint8Array; frames: number } {
  if (sustainedGif) return sustainedGif;
  const single = new Array<number>(CANVAS * CANVAS).fill(0);
  const oneBuffer = new Uint8Array(4096);
  const twoBuffer = new Uint8Array(8192);
  const writer1 = new upstream.GifWriter(oneBuffer, CANVAS, CANVAS, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer1.addFrame(0, 0, CANVAS, CANVAS, single, { delay: 10, disposal: 2 });
  const oneLength = writer1.end();
  const writer2 = new upstream.GifWriter(twoBuffer, CANVAS, CANVAS, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer2.addFrame(0, 0, CANVAS, CANVAS, single, { delay: 10, disposal: 2 });
  writer2.addFrame(0, 0, CANVAS, CANVAS, single, { delay: 10, disposal: 2 });
  const twoLength = writer2.end();
  const oneGif = oneBuffer.slice(0, oneLength);
  const twoGif = twoBuffer.slice(0, twoLength);
  // oneGif = header + first frame block + trailer; twoGif = header + two blocks + trailer.
  // `prefix` therefore already carries the header and the FIRST frame block; every repeat of
  // `block` adds one more frame, so the frame count is repeats + 1.
  const prefix = oneGif.slice(0, oneGif.length - 1);
  const block = twoGif.slice(oneGif.length - 1, twoGif.length - 1);
  const repeats = Math.floor((TARGET_BYTES - prefix.length - 1) / block.length);
  const frames = repeats + 1;
  const bytes = new Uint8Array(prefix.length + block.length * repeats + 1);
  bytes.set(prefix, 0);
  for (let at = prefix.length, index = 0; index < repeats; index += 1, at += block.length) {
    bytes.set(block, at);
  }
  bytes[bytes.length - 1] = 0x3b; // trailer
  const reader = new (
    upstream as { GifReader: new (b: Uint8Array) => { numFrames(): number } }
  ).GifReader(bytes);
  if (reader.numFrames() !== frames) throw new Error("sustained GIF frame count mismatch");
  sustainedGif = { bytes, frames };
  return sustainedGif;
}

const sampleRequest = (bytes: Uint8Array, signal: AbortSignal) => ({
  kind: "sample" as const,
  bytes,
  frames: 3,
  maxDimension: CANVAS,
  signal,
});

/** Full-run duration cached in this process; the completion test fills it, the abort test reuses it. */
const measured: { fullRunMs?: number } = {};

/**
 * One full real production run over the sustained input through `runQqImagePreparation`,
 * with the completion test's full assertion set. Shared by the completion test and — when
 * no duration is cached yet — by the mid-window abort test, so a standalone abort run still
 * grounds its abort position in a real measured full run instead of a fixed sleep.
 */
async function measureFullRun(): Promise<number> {
  const { bytes, frames } = makeSustainedGif();
  expect(bytes.byteLength).toBeLessThanOrEqual(TARGET_BYTES);
  expect(frames).toBeGreaterThan(100_000);
  const spy = installWorkerSpy();
  try {
    const startedAt = performance.now();
    const result = await runQqImagePreparation(sampleRequest(bytes, new AbortController().signal));
    const elapsedMs = performance.now() - startedAt;
    if (result.kind !== "sampled") {
      throw new Error(`unexpected result kind: ${result.kind}`);
    }
    expect(result.frames).toHaveLength(3);
    expect(result.sourceFrameCount).toBe(frames);
    expect(result.truncated).toBe(true);
    expect(spy.spawned).toBe(true);
    expect(spy.messages).toEqual(["sampled"]);
    expect(spy.terminateCalls).toBe(1);
    await spy.terminateDone;
    expect(spy.exits.length).toBeGreaterThanOrEqual(1);
    console.log(
      `[t14-lifecycle] full run ${(elapsedMs / 1000).toFixed(2)}s, ${frames} frames, ` +
        `encoded ${(bytes.byteLength / 1048576).toFixed(2)} MiB, rss ` +
        `${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`,
    );
    return elapsedMs;
  } finally {
    spy.restore();
  }
}

describe("qq image worker lifecycle boundaries (real threads, real input)", () => {
  it("completes a sustained legal sample through the real worker and reaps the thread", async () => {
    measured.fullRunMs = await measureFullRun();
  }, 120_000);

  it("aborts while the sustained job is still unsettled: cancelled, terminated, exited, nothing late", async () => {
    const { bytes } = makeSustainedGif();
    // The mid-window judgement needs the same-process full-run duration. Reuse the cached
    // measurement when the completion test already ran here; otherwise measure once now —
    // never guess the abort position with a fixed sleep.
    const fullRunMs = measured.fullRunMs ?? (await measureFullRun());
    const abortDelayMs = fullRunMs / ABORT_FRACTION;
    const controller = new AbortController();
    const spy = installWorkerSpy();
    let abortHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = runQqImagePreparation(sampleRequest(bytes, controller.signal));
      abortHandle = setTimeout(() => controller.abort(new Error("stop-mid-window")), abortDelayMs);
      const failure = await pending.then(
        (value) => {
          throw new Error(`mid-window abort resolved with ${value.kind}`);
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(QqImagePrepareError);
      expect((failure as QqImagePrepareError).reason).toBe("cancelled");
      expect((failure as Error).message).toBe("stop-mid-window");
      expect(spy.spawned).toBe(true);
      expect(spy.terminateCalls).toBe(1);
      await spy.terminateDone;
      expect(spy.exits.length).toBeGreaterThanOrEqual(1);
      // No late publish: once the thread is dead (terminate resolved, exit observed) no
      // further worker message can exist; the collected messages stay empty.
      expect(spy.messages).toEqual([]);
    } finally {
      if (abortHandle !== undefined) clearTimeout(abortHandle);
      spy.restore();
    }
  }, 120_000);

  it("abort immediately after dispatch: cancelled with the caller's reason and no late callback", async () => {
    const { bytes } = makeSustainedGif();
    const controller = new AbortController();
    const spy = installWorkerSpy();
    try {
      const pending = runQqImagePreparation(sampleRequest(bytes, controller.signal));
      controller.abort(new Error("stop now"));
      const failure = await pending.then(
        (value) => {
          throw new Error(`abort resolved with ${value.kind}`);
        },
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(QqImagePrepareError);
      expect((failure as QqImagePrepareError).reason).toBe("cancelled");
      expect((failure as Error).message).toBe("stop now");
      expect(spy.spawned).toBe(true);
      expect(spy.terminateCalls).toBe(1);
      await spy.terminateDone;
      expect(spy.exits.length).toBeGreaterThanOrEqual(1);
      // No late publish: once the thread is dead (terminate resolved, exit observed) no
      // further worker message can exist; the collected messages stay empty.
      expect(spy.messages).toEqual([]);
    } finally {
      spy.restore();
    }
  }, 60_000);
});
