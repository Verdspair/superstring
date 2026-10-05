// T14 Z2 (prime-t14-deadline): one real-wall-clock attempt at the production 30 s deadline
// in `runQqImagePreparation` (spec §11 open experiment, checkpoint step ④, plan §4 of
// briefs/prime-t14-remaining-plan.md). Evidence for this attempt lives in
// artifacts/validation/qq-message-multimodal-20261002/prime-t14-deadline/.
//
// What this test claims, exactly:
//   * a sustained LEGAL GIF (fixed 512x256 canvas, constant-size frame blocks spliced by
//     block concat — never a width*height*frames*4 allocation) drives the real production
//     worker host with a compute-dominated run measured at ~0.82 ms per frame in the SAME
//     process (see prime-t14-deadline/calibrate-50k.log: 4 disposal modes, 50 000 frames,
//     ~41 s each, RSS <= 237 MiB);
//   * if the run does NOT settle before the production 30 s timer, the failure must be the
//     deadline branch itself: reason "decode_failed", detail "QQ image decode deadline
//     exceeded", after which the worker is terminated and exits and NO message is ever
//     published afterwards (closed gate under a real thread).
//
// What this test does NOT claim:
//   * that "compute is running" was signalled by the worker — the worker protocol has no
//     such message (calibration shows 0 mid-run messages); "compute-dominated" is a
//     calibration-extrapolated wall-clock share, not a protocol signal;
//   * anything about the decoded-pixel numeric cap — that remains an open user decision and
//     no numeric assertion is introduced here.
//
// Three-way exit rules (plan §4): if the input completes before 30 s, the test records the
// wall clock, does NOT assert the deadline branch, and the batch report marks this attempt
// not-proved for the deadline branch — the attempt is NOT retried with a larger input inside
// this test (changing the resource bound is a new approved dispatch). Any other failure is a
// real failure with the full log preserved.
//
// Resource bounds for THIS test (experiment self-limits, not product caps):
//   encoded <= 32 MiB (product 64 MiB cap untouched, never asserted);
//   canvas 512*256*4 = 512 KiB, disposal-2 frames only (no disposal-3 snapshot doubling);
//   test timeout 90 s bounds the whole run; no service, no port, no real data.

import { describe, expect, it } from "bun:test";
import { Worker } from "node:worker_threads";
import upstream from "omggif";
import { QqImagePrepareError } from "../../src/server/services/qq-image-codec";
import { runQqImagePreparation } from "../../src/server/services/qq-image-worker";

const CANVAS_W = 512;
const CANVAS_H = 256;
/** Per-frame decode cost measured in this process by calibrate.ts before this run. */
const MEASURED_PER_FRAME_US = 821;
/** This experiment's encoded self-limit; the production 64 MiB cap is a different, larger bound. */
const TARGET_BYTES = 32 * 1024 * 1024;
/** Deadline target with margin: (30 s deadline + 7.5 s margin) / measured per-frame cost. */
const DEADLINE_TARGET_MS = 30_000;
const MARGIN_MS = 7_500;

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

let longGif: { bytes: Uint8Array; frames: number } | null = null;

/**
 * One solid 512x256 frame block, repeated by concat up to the frame count derived from the
 * calibration. Two tiny writer passes only (one frame, two frames); the frame block is
 * spliced out and repeated, so generation cost is O(bytes) and no width*height*frames*4
 * buffer is ever allocated.
 */
function makeLongGif(): { bytes: Uint8Array; frames: number } {
  if (longGif) return longGif;
  const solid = new Array<number>(CANVAS_W * CANVAS_H).fill(0);
  const oneBuffer = new Uint8Array(2048);
  const twoBuffer = new Uint8Array(4096);
  const writer1 = new upstream.GifWriter(oneBuffer, CANVAS_W, CANVAS_H, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer1.addFrame(0, 0, CANVAS_W, CANVAS_H, solid, { delay: 10, disposal: 2 });
  const oneLength = writer1.end();
  const writer2 = new upstream.GifWriter(twoBuffer, CANVAS_W, CANVAS_H, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer2.addFrame(0, 0, CANVAS_W, CANVAS_H, solid, { delay: 10, disposal: 2 });
  writer2.addFrame(0, 0, CANVAS_W, CANVAS_H, solid, { delay: 10, disposal: 2 });
  const twoLength = writer2.end();
  const oneGif = oneBuffer.slice(0, oneLength);
  const twoGif = twoBuffer.slice(0, twoLength);
  // oneGif = header + first frame block + trailer; twoGif = header + two blocks + trailer.
  const prefix = oneGif.slice(0, oneGif.length - 1);
  const block = twoGif.slice(oneGif.length - 1, twoGif.length - 1);
  // Total frames wanted from the calibration; `prefix` already carries the FIRST frame
  // block, so every appended block adds one more frame (322's exact-count construction).
  const framesFromCost = Math.ceil(
    (DEADLINE_TARGET_MS + MARGIN_MS) / (MEASURED_PER_FRAME_US / 1000),
  );
  const repeatsFromBytes = Math.floor((TARGET_BYTES - prefix.length - 1) / block.length);
  const frames = Math.min(framesFromCost, repeatsFromBytes + 1);
  const repeats = frames - 1;
  const bytes = new Uint8Array(prefix.length + block.length * repeats + 1);
  bytes.set(prefix, 0);
  for (let at = prefix.length, index = 0; index < repeats; index += 1, at += block.length) {
    bytes.set(block, at);
  }
  bytes[bytes.length - 1] = 0x3b; // trailer
  // The concat method's frame count is exact by construction (322 count-check2), but the
  // reader's count is the ground truth: verify and use it, never a guessed number.
  const reader = new (
    upstream as { GifReader: new (b: Uint8Array) => { numFrames(): number } }
  ).GifReader(bytes);
  if (reader.numFrames() !== frames) throw new Error("deadline GIF frame count mismatch");
  if (bytes.byteLength > TARGET_BYTES)
    throw new Error("deadline GIF exceeds the encoded self-limit");
  longGif = { bytes, frames: reader.numFrames() };
  return longGif;
}

describe("qq image worker 30s deadline (real wall clock, one bounded attempt)", () => {
  it("deadline attempt: sustained legal sample either settles early (not-proved) or fails through the real deadline branch", async () => {
    const { bytes, frames } = makeLongGif();
    const estimatedMs = (frames * MEASURED_PER_FRAME_US) / 1000;
    console.log(
      `[t14-deadline] input ${frames} frames, ${(bytes.byteLength / 1048576).toFixed(2)} MiB, ` +
        `calibration-extrapolated wall clock ~${(estimatedMs / 1000).toFixed(1)}s ` +
        `(compute-dominated by calibration, NOT a protocol signal), rss ` +
        `${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`,
    );
    expect(frames).toBeGreaterThan(30_000);
    expect(bytes.byteLength).toBeLessThanOrEqual(TARGET_BYTES);

    const spy = installWorkerSpy();
    try {
      const startedAt = performance.now();
      const outcome = await runQqImagePreparation({
        kind: "sample",
        bytes,
        frames: 3,
        maxDimension: CANVAS_H,
        signal: new AbortController().signal,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const elapsedMs = performance.now() - startedAt;
      console.log(
        `[t14-deadline] settled at ${(elapsedMs / 1000).toFixed(2)}s ok=${outcome.ok} ` +
          `kind=${outcome.ok ? outcome.value.kind : "rejected"} reason=` +
          `${outcome.ok ? undefined : (outcome.error as QqImagePrepareError)?.reason} ` +
          `detail=${outcome.ok ? undefined : (outcome.error as Error)?.message}`,
      );

      // Sanity on the run shape regardless of which way it went.
      expect(spy.spawned).toBe(true);
      expect(spy.terminateCalls).toBe(1);
      await spy.terminateDone;
      expect(spy.exits.length).toBeGreaterThanOrEqual(1);

      if (!outcome.ok) {
        const error = outcome.error as QqImagePrepareError;
        expect(error).toBeInstanceOf(QqImagePrepareError);
        // The ONLY accepted failure is the real 30 s deadline branch of the production host.
        expect(error.reason).toBe("decode_failed");
        expect(error.message).toBe("QQ image decode deadline exceeded");
        expect(elapsedMs).toBeGreaterThanOrEqual(29_000);
        // No late publish: the thread is dead (terminate resolved, exit observed), so no
        // further worker message can exist; the deadline path must not have published one.
        expect(spy.messages).toEqual([]);
        console.log("[t14-deadline] DEADLINE BRANCH PROVEN by real wall clock");
      } else {
        // Three-way rule 2: the input finished before the deadline. Record it honestly; the
        // batch report marks this attempt not-proved. No retry with a bigger input here.
        const result = outcome.value;
        if (result.kind !== "sampled") throw new Error(`unexpected result kind: ${result.kind}`);
        expect(result.frames).toHaveLength(3);
        expect(result.sourceFrameCount).toBe(frames);
        expect(result.truncated).toBe(true);
        expect(elapsedMs).toBeLessThan(29_000);
        console.log(
          `[t14-deadline] NOT-PROVED: input completed before the deadline at ` +
            `${(elapsedMs / 1000).toFixed(2)}s; deadline branch remains untested this run`,
        );
      }
    } finally {
      spy.restore();
    }
  }, 90_000);
});
