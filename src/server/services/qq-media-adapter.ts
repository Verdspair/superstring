// The real media adapter (ADR0018 P5j): fetch the bytes, then ask the picture model.
//
// P4b left this as an injected seam on purpose — the reader must not open a network connection or
// treat a text model as vision. This module is what fills the seam, and it is still assembled from
// injected parts, because the two transports it needs were decided separately:
//
//   * the SOURCE fetch — `qq-media-source.ts` plus the connection's `resolveMediaSource`;
//   * the MODEL call — the vision client from P5i, whose request shape the user approved
//     (data URLs, one entry per sampled frame, PNG).
//
// What it deliberately does not do: transcribe voice (the transcription protocol is still
// undecided, so that purpose is configurable but not callable), and read video (§7.1 promises no
// full video understanding and there is no video decoder). Both refuse loudly — the reader records
// the attempt and stays silent in the conversation, which is §7.1's failure path.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { LeafAgentRuntime } from "../agent/agent-runtime";
import { sampleQqAnimationFrames } from "./qq-animation-frames";
import { QQ_STICKER_CONTENT_TYPES, readQqImageHeader } from "./qq-image-header";
import type { QqMediaReadAdapter } from "./qq-media-reader";

/**
 * The defaults for §7.1's sampling. They are the constants this used to hard-code; since 0029 the
 * scheme carries the two numbers (媒体与表达), so an installation that changes nothing behaves
 * exactly as before and a conversation that wants more frames can say so.
 */
export const QQ_MEDIA_READ_FRAMES = 3;
export const QQ_MEDIA_READ_MAX_DIMENSION = 512;

/** A reference resolved to bytes. No mime type: the adapter sniffs the container itself. */
export interface QqMediaFetchedSource {
  readonly bytes: Uint8Array;
}

/** Resolves the bot side's reference into bytes. Injected so tests own the bytes. */
export type QqMediaSourceFetcher = (input: {
  readonly kind: "image" | "record" | "video";
  readonly sourceRef: string;
}) => Promise<QqMediaFetchedSource>;

export interface QqMediaAdapterOptions {
  readonly fetchSource: QqMediaSourceFetcher;
  readonly agentRuntime: LeafAgentRuntime;
  /** The instruction that travels with the picture — the scheme's media slot, assembled upstream. */
  readonly prompt: string;
  /** §7.1's 可改 sampling, from the conversation's scheme; omitted means the defaults above. */
  readonly frames?: number;
  readonly maxDimension?: number;
}

/** The frames to show for an animation, or the picture itself for a still. */
function imagesFor(
  bytes: Uint8Array,
  frames: number,
  maxDimension: number,
): { mimeType: string; bytes: Uint8Array }[] {
  const header = readQqImageHeader(bytes);
  if (header.kind !== "read") throw new Error("QQ media adapter could not read the image header");
  if (header.format !== "gif") {
    return [{ mimeType: QQ_STICKER_CONTENT_TYPES[header.format], bytes }];
  }
  // §7.1's 有限抽帧: a GIF is shown as sampled, composited frames rather than as the file.
  const sample = sampleQqAnimationFrames(bytes, {
    frames,
    maxDimension,
    budgetTokens: 1,
  });
  if (sample.kind !== "sampled" || sample.frames.length === 0) {
    throw new Error("QQ media adapter could not sample the animation");
  }
  return sample.frames.map((frame) => ({ mimeType: "image/png", bytes: frame.png }));
}

export function createQqMediaAdapter(options: QqMediaAdapterOptions): QqMediaReadAdapter {
  const prompt = z.string().trim().min(1).parse(options.prompt);
  // The scheme's numbers are validated where they are stored; what matters here is that a caller
  // cannot ask for zero frames and get a silent empty picture.
  const frames = z
    .number()
    .int()
    .min(1)
    .max(10)
    .parse(options.frames ?? QQ_MEDIA_READ_FRAMES);
  const maxDimension = z
    .number()
    .int()
    .min(64)
    .max(2048)
    .parse(options.maxDimension ?? QQ_MEDIA_READ_MAX_DIMENSION);
  return {
    async read({ kind, sourceRef, model, source: reference, owner, signal }): Promise<string> {
      if (kind === "record") {
        throw new Error("QQ media adapter cannot transcribe voice: the protocol is undecided");
      }
      if (kind === "video") {
        throw new Error("QQ media adapter does not read video");
      }
      signal?.throwIfAborted();
      const source = await options.fetchSource({ kind, sourceRef });
      signal?.throwIfAborted();
      // The transport reference can contain a signed URL or a data URL. Only the source
      // identity and the runtime's image hashes are persisted in a ContextHandle.
      const sourceId = reference?.id ?? createHash("sha256").update(sourceRef).digest("hex");
      return options.agentRuntime.completeVisionLeaf(
        { id: "media.describe", version: "1" },
        {
          model,
          prompt,
          images: imagesFor(source.bytes, frames, maxDimension),
          signal,
          owner: owner ?? { kind: "qq_media", id: sourceId },
          sources: reference ? [reference] : [],
        },
      );
    },
  };
}
