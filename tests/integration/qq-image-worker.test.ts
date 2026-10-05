// T14: the real worker lifecycle for QQ image preparation (spec §11, plan T14 Step4).
//
// Everything here is synthetic and small: fixtures are bytes produced by this module's own
// encoder or the GIF writer. No real image, no network, no model, no giant allocation.
//
// What is pinned down beyond the codec tests:
//   * the worker resolves with a result that names the PNG's real decoded size — the main
//     side re-reads the header, holds the real dims inside the request box, and never echoes
//     the request numbers as the result;
//   * an abort in the worker-startup window settles the original promise with the caller's
//     own reason, terminates the worker, and nothing late is published afterwards;
//   * the 30 s deadline exists as a guard, but no test waits 30 s of wall clock — that
//     would be faking evidence, so only the cancellation path is exercised for timing;
//   * a truncated hostile GIF header is refused as unreadable before any decode attempt.

import { describe, expect, it } from "bun:test";
import upstream from "omggif";
import { prepareQqImage, QqImagePrepareError } from "../../src/server/services/qq-image-codec";

const RED = 0;
const PALETTE = [0xff0000, 0x00ff00];

function makeGif(width: number, height: number, frames: number): Uint8Array {
  const buffer = new Uint8Array(width * height * frames * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, { palette: PALETTE, loop: 0 });
  for (let i = 0; i < frames; i += 1) {
    writer.addFrame(0, 0, width, height, new Array(width * height).fill(RED), {
      delay: 10,
      disposal: 2,
    });
  }
  const length = writer.end();
  return buffer.slice(0, length);
}

const input = (overrides: Partial<Parameters<typeof prepareQqImage>[1]> = {}) => ({
  category: "expression" as const,
  detail: false,
  stillMaxDimension: 512 as number | null,
  frameCount: 3,
  frameMaxDimension: 512,
  signal: new AbortController().signal,
  ...overrides,
});

describe("qq image worker lifecycle", () => {
  it("reports the PNG's real dimensions on the worker result, verified in main", async () => {
    // The request names a target box; the main side must verify what actually came back
    // through the header instead of echoing the request.
    const gif = makeGif(640, 320, 2);
    const result = await prepareQqImage(gif, input({ frameCount: 2, frameMaxDimension: 512 }));
    expect(result).toHaveLength(2);
    for (const frame of result) {
      expect([frame.width, frame.height]).toEqual([512, 256]);
      expect(frame.mimeType).toBe("image/png");
      expect(frame.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("settles an abort in the worker-startup window with the caller's reason, never late", async () => {
    // Aborting right after the call only proves the startup window responds; it does not
    // claim the CPU composition loop itself is interrupted mid-run.
    const controller = new AbortController();
    const gif = makeGif(256, 256, 8);
    const pending = prepareQqImage(gif, input({ frameCount: 4, signal: controller.signal }));
    controller.abort(new Error("stop now"));
    const failure = await pending.then(
      (value) => {
        throw new Error(`cancelled job resolved with ${value.length} frames`);
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(QqImagePrepareError);
    expect((failure as QqImagePrepareError).reason).toBe("cancelled");
    expect((failure as Error).message).toBe("stop now");
  });

  it("reports a truncated GIF as unreadable instead of attempting a decode", async () => {
    // A 10-byte hostile header cannot be decoded: the reader reports it unreadable long
    // before any allocation. No pixel-cap product limit is asserted here — that stays an
    // open user decision (§11).
    const hostile = new Uint8Array([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61,
      0xff,
      0xff,
      0xff,
      0xff, // 65535×65535 canvas
    ]);
    const failure = await prepareQqImage(hostile, input()).then(
      (value) => {
        throw new Error(`hostile canvas resolved with ${value.length} frames`);
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(QqImagePrepareError);
    expect((failure as QqImagePrepareError).reason).toBe("unreadable_image");
  });
});
