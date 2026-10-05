// The worker side of QQ image preparation: either scale a still into the requested box, or
// composite GIF frames through the same disposal-aware sampler the media path uses
// (`sampleQqAnimationFrames` — reused verbatim, no second decoder). Exactly one job per
// worker instance; the parent terminates it afterwards.
//
// `@napi-rs/image` is the single approved still decoder (plan T07, spec §1): its
// `Transformer` decodes stills and `resize` with `fit: Inside` shrinks preserving aspect
// ratio without enlarging. All of these calls are synchronous native work — an AbortSignal
// cannot interrupt them, so cancellation is the parent's `terminate()`.

import { parentPort, workerData } from "node:worker_threads";
import { ResizeFilterType, ResizeFit, Transformer } from "@napi-rs/image";
import { sampleQqAnimationFrames } from "./qq-animation-frames";
import type { QqImageWorkerInput } from "./qq-image-worker";

const port = parentPort;
if (!port) throw new Error("QQ image worker requires a parent port");
const input = workerData as QqImageWorkerInput;

if (input.kind === "scale") {
  const transformer = new Transformer(input.bytes);
  // Inside = largest aspect-preserving size within the box; the parent re-reads the PNG
  // header and only requires the real size to stay within the box, not to equal it.
  transformer.resize({
    width: input.width,
    height: input.height,
    fit: ResizeFit.Inside,
    filter: ResizeFilterType.Lanczos3,
  });
  const png = transformer.pngSync();
  const transfer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  port.postMessage({ kind: "scale", png: transfer, width: input.width, height: input.height }, [
    transfer,
  ]);
} else if (input.kind === "sample") {
  const sample = sampleQqAnimationFrames(input.bytes, {
    frames: input.frames,
    maxDimension: input.maxDimension,
    budgetTokens: 1,
  });
  if (sample.kind !== "sampled") {
    port.postMessage({ kind: "sample-unreadable", reason: sample.reason });
  } else {
    const transfers: ArrayBuffer[] = [];
    const frames = sample.frames.map((frame) => {
      const buffer = frame.png.buffer.slice(
        frame.png.byteOffset,
        frame.png.byteOffset + frame.png.byteLength,
      ) as ArrayBuffer;
      transfers.push(buffer);
      return { index: frame.index, width: frame.width, height: frame.height, png: buffer };
    });
    port.postMessage(
      {
        kind: "sampled",
        frames,
        sourceFrameCount: sample.frameCount,
        truncated: sample.truncated,
      },
      transfers,
    );
  }
} else {
  throw new Error(`Unknown QQ image job: ${String((input as { kind?: unknown }).kind)}`);
}
