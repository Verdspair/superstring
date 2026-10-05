// T07/T14: the worker host for QQ image preparation (spec §11, plan T07 Step7, T14 Step4).
//
// Why a worker: native decode and GIF composition are CPU-bound native/JS loops the event
// loop cannot slice. Running them off-thread keeps a slow or hostile image from stalling
// every other conversation, and gives the caller a hard stop — `terminate()` — that a CPU
// deadline inside one thread could never guarantee. The pattern is the one `quickjs-runner.ts`
// already uses: main thread owns lifecycle and cancellation, worker owns the compute.
//
// Two job kinds share this one lifecycle (`scale` for stills, `sample` for GIF frames):
//   * input bytes are size-checked before the worker is ever started, so an absurd payload
//     is never decoded at all;
//   * the PNG a worker returns is re-read through `readQqImageHeader` on the main side —
//     the real decoded dimensions, never the numbers the request happened to name;
//   * the worker holds exactly one image at a time and is terminated after each request.
//
// The AbortSignal is honoured before starting and via abort→terminate; the native decoder
// calls inside the worker are synchronous and cannot take a signal, so terminate is the only
// real stop. Decoded pixel memory has no numeric cap yet — that limit is an open user
// decision (§11), not something this file may invent.

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { QqImagePrepareError } from "./qq-image-codec";
import { readQqImageHeader } from "./qq-image-header";

declare const SUPERSTRING_COMPILED: boolean;
const workerUrl =
  typeof SUPERSTRING_COMPILED !== "undefined" && SUPERSTRING_COMPILED
    ? fileURLToPath(new URL("./src/server/services/qq-image-worker-entry.js", import.meta.url))
    : fileURLToPath(new URL("./qq-image-worker-entry.ts", import.meta.url));

export type QqImagePreparationRequest =
  | {
      readonly kind: "scale";
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
      readonly signal: AbortSignal;
    }
  | {
      readonly kind: "sample";
      readonly bytes: Uint8Array;
      readonly frames: number;
      readonly maxDimension: number;
      readonly signal: AbortSignal;
    };

export interface QqImageScaleResult {
  readonly kind: "scale";
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface QqImageSampledFrame {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
}

export interface QqImageSampleResult {
  readonly kind: "sampled";
  readonly frames: readonly QqImageSampledFrame[];
  readonly sourceFrameCount: number;
  readonly truncated: boolean;
}

export type QqImagePreparationResult = QqImageScaleResult | QqImageSampleResult;

/** The one message shape the worker accepts; anything else is a caller bug. */
export type QqImageWorkerInput =
  | {
      readonly kind: "scale";
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "sample";
      readonly bytes: Uint8Array;
      readonly frames: number;
      readonly maxDimension: number;
    };

type QqImageWorkerFrame = {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly png: ArrayBuffer;
};

/** The shapes the worker may post back; anything else is a worker bug. */
export type QqImageWorkerOutput =
  | {
      readonly kind: "scale";
      readonly png: ArrayBuffer;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "sampled";
      readonly frames: readonly QqImageWorkerFrame[];
      readonly sourceFrameCount: number;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "sample-unreadable";
      readonly reason: "invalid_animation" | "empty_animation";
    };

/**
 * Structural cap on the encoded input we will hand to a native decoder. This is a safety
 * boundary for decode work (§11), not a product limit: QQ's own image caps live in the
 * storage/validation layers, and this only stops an absurd payload from being decoded at all.
 */
const MAX_ENCODED_BYTES = 64 * 1024 * 1024;

const isPositiveInt = (value: number) => Number.isSafeInteger(value) && value >= 1;

/** The PNG's own header decides its size; a claimed size is never accepted on faith. */
function pngDimensions(png: ArrayBuffer): { width: number; height: number } | null {
  const header = readQqImageHeader(new Uint8Array(png));
  return header.kind === "read" && header.format === "png"
    ? { width: header.width, height: header.height }
    : null;
}

function invalidResult(detail: string): QqImagePrepareError {
  return new QqImagePrepareError(
    "decode_failed",
    `QQ image worker returned a mismatched result: ${detail}`,
  );
}

export async function runQqImagePreparation(
  request: QqImagePreparationRequest,
): Promise<QqImagePreparationResult> {
  request.signal.throwIfAborted();
  if (request.bytes.byteLength > MAX_ENCODED_BYTES) {
    throw new QqImagePrepareError("decode_failed", "QQ image exceeds the decode safety boundary");
  }
  if (request.kind === "scale") {
    if (!isPositiveInt(request.width) || !isPositiveInt(request.height)) {
      throw new TypeError("Invalid QQ image scale request");
    }
  } else if (!isPositiveInt(request.frames) || !isPositiveInt(request.maxDimension)) {
    throw new TypeError("Invalid QQ image sample request");
  }
  // Only the plain data job goes into workerData: the AbortSignal is not cloneable and the
  // worker never needs it (the parent's terminate() is the stop).
  const workerData: QqImageWorkerInput =
    request.kind === "scale"
      ? { kind: "scale", bytes: request.bytes, width: request.width, height: request.height }
      : {
          kind: "sample",
          bytes: request.bytes,
          frames: request.frames,
          maxDimension: request.maxDimension,
        };
  const worker = new Worker(workerUrl, { env: {}, workerData });
  const outcome = Promise.withResolvers<QqImagePreparationResult>();
  let closed = false;
  const finish = (error?: unknown, result?: QqImagePreparationResult) => {
    if (closed) return;
    closed = true;
    if (result) outcome.resolve(result);
    else outcome.reject(error ?? new QqImagePrepareError("decode_failed"));
  };
  const timer = setTimeout(
    () => finish(new QqImagePrepareError("decode_failed", "QQ image decode deadline exceeded")),
    30_000,
  );
  const abort = () => {
    const reason = request.signal.reason;
    finish(
      reason instanceof Error
        ? new QqImagePrepareError("cancelled", reason.message)
        : new QqImagePrepareError("cancelled", "QQ image preparation was cancelled"),
    );
  };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  worker.on("message", (message: QqImageWorkerOutput) => {
    try {
      request.signal.throwIfAborted();
      if (message.kind === "scale") {
        if (!(message.png instanceof ArrayBuffer)) throw invalidResult("png is not a buffer");
        const real = pngDimensions(message.png);
        if (!real) throw invalidResult("png header unreadable");
        if (request.kind !== "scale") throw invalidResult("unexpected scale result");
        // Inside may round one edge down.
        if (real.width > request.width || real.height > request.height) {
          throw invalidResult(
            `png is ${real.width}x${real.height}, outside ${request.width}x${request.height}`,
          );
        }
        finish(undefined, {
          kind: "scale",
          png: new Uint8Array(message.png),
          width: real.width,
          height: real.height,
        });
      } else if (message.kind === "sampled") {
        if (request.kind !== "sample") throw invalidResult("unexpected sampled result");
        if (
          !Array.isArray(message.frames) ||
          message.frames.length === 0 ||
          !isPositiveInt(message.sourceFrameCount) ||
          typeof message.truncated !== "boolean"
        ) {
          throw invalidResult("sample shape");
        }
        const seen = new Set<number>();
        const frames = message.frames.map((frame) => {
          if (!Number.isSafeInteger(frame.index) || frame.index < 0 || seen.has(frame.index)) {
            throw invalidResult("frame index");
          }
          seen.add(frame.index);
          if (!(frame.png instanceof ArrayBuffer)) throw invalidResult("frame png is not a buffer");
          const real = pngDimensions(frame.png);
          if (!real || real.width !== frame.width || real.height !== frame.height) {
            throw invalidResult(
              `frame png is ${real ? `${real.width}x${real.height}` : "unreadable"}`,
            );
          }
          return {
            index: frame.index,
            width: real.width,
            height: real.height,
            png: new Uint8Array(frame.png),
          };
        });
        if (frames.length > request.frames) throw invalidResult("more frames than requested");
        finish(undefined, {
          kind: "sampled",
          frames,
          sourceFrameCount: message.sourceFrameCount,
          truncated: message.truncated,
        });
      } else {
        finish(
          new QqImagePrepareError("unreadable_image", `QQ animation unreadable: ${message.reason}`),
        );
      }
    } catch (error) {
      finish(error);
    }
  });
  worker.on("error", (error) =>
    finish(
      error instanceof Error && /unsupported|format|decode/i.test(error.message)
        ? new QqImagePrepareError("unreadable_image", error.message)
        : new QqImagePrepareError(
            "decode_failed",
            error instanceof Error ? error.message : undefined,
          ),
    ),
  );
  worker.on("exit", () => {
    if (!closed) finish(new QqImagePrepareError("decode_failed", "QQ image worker exited early"));
  });
  try {
    return await outcome.promise;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    closed = true;
    await worker.terminate();
  }
}
