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
// full video understanding and there is no video decoder). 0.4.0 P5 declares that in
// `capabilities` — the reader refuses those kinds **before** spending an attempt, so "not readable
// here" stays distinct from "a read we tried and failed". The `read` method still refuses loudly
// if a caller bypasses the declaration.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { LeafAgentRuntime } from "../agent/agent-runtime";
import { prepareQqImage } from "./qq-image-codec";
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
  /** The run's cancellation signal: a fetch must not outlive the run that asked for it. */
  readonly signal?: AbortSignal;
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

/** The frames to show for an animation, or the picture itself for a still (§7.4). */
async function imagesFor(
  bytes: Uint8Array,
  frames: number,
  maxDimension: number,
  signal: AbortSignal,
): Promise<
  {
    mimeType: string;
    bytes: Uint8Array;
    frameIndex: number | null;
    sourceFrameCount: number;
    truncated: boolean;
  }[]
> {
  const prepared = await prepareQqImage(bytes, {
    category: "ordinary",
    detail: false,
    stillMaxDimension: null,
    frameCount: frames,
    frameMaxDimension: maxDimension,
    signal,
  });
  return prepared.map((frame) => ({
    mimeType: frame.mimeType,
    bytes: frame.bytes,
    frameIndex: frame.frameIndex,
    sourceFrameCount: frame.sourceFrameCount,
    truncated: frame.truncated,
  }));
}

function samplingSuffix(
  sourceId: string,
  images: readonly { frameIndex: number | null; sourceFrameCount: number; truncated: boolean }[],
): string {
  const sampled = images.filter((image) => image.frameIndex !== null);
  if (sampled.length === 0) return "";
  return `\n${JSON.stringify({
    sampled_frames: {
      source: sourceId,
      suppliedCount: sampled.length,
      truncated: sampled.some((image) => image.truncated),
      frames: sampled.map((image) => ({
        index: image.frameIndex,
        sourceTotal: image.sourceFrameCount,
      })),
    },
  })}\n以上仅是对动画的有限采样，不是完整动画；未列出的帧你没有看到。`;
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
    // 语音与视频没有实现：能力声明是这一版的产品事实，不是临时限制。
    capabilities: ["image"] as const,
    // 身份派生的受控字节：复用同一个 fetchSource 链（不建第二下载路径）；
    // reader 已 fetch 的 bytes 由 read() 的 bytes 参数复用，不重复下载。
    async fetchBytes(input: {
      kind: "image" | "record" | "video";
      sourceRef: string;
      signal?: AbortSignal;
    }) {
      const fetched = await options.fetchSource({
        kind: input.kind,
        sourceRef: input.sourceRef,
        signal: input.signal,
      });
      return { bytes: fetched.bytes };
    },
    async read({
      kind,
      sourceRef,
      model,
      source: reference,
      owner,
      signal,
      bytes,
    }): Promise<string> {
      if (kind === "record") {
        throw new Error("QQ media adapter cannot transcribe voice: the protocol is undecided");
      }
      if (kind === "video") {
        throw new Error("QQ media adapter does not read video");
      }
      signal?.throwIfAborted();
      // 一次下载两用：reader 为身份派生取过的字节直接复用（同一受控链，不二次下载）。
      const source = bytes ? { bytes } : await options.fetchSource({ kind, sourceRef, signal });
      signal?.throwIfAborted();
      // The transport reference can contain a signed URL or a data URL. Only the source
      // identity and the runtime's image hashes are persisted in a ContextHandle.
      const sourceId = reference?.id ?? createHash("sha256").update(sourceRef).digest("hex");
      const signalForPrepare = signal ?? new AbortController().signal;
      // The worker path cannot clone an optional signal into its job; it requires a real
      // AbortSignal, and this request's own signal (already carried through fetchSource) is
      // the cancellation the caller gave us — never a fresh one that would fake no-cancellation.
      const images = await imagesFor(source.bytes, frames, maxDimension, signalForPrepare);
      // §11: cancellation is re-checked after the await — a read cancelled while the codec
      // worker was running must not continue into a vision call, and the worker's own
      // `cancelled` error (carrying the caller's reason) is rethrown, not swallowed.
      signalForPrepare.throwIfAborted();
      const sampledPrompt = `${prompt}${samplingSuffix(sourceId, images)}`;
      return options.agentRuntime.completeVisionLeaf(
        { id: "media.describe", version: "1" },
        {
          model,
          prompt: sampledPrompt,
          images,
          signal,
          owner: owner ?? { kind: "qq_media", id: sourceId },
          sources: reference ? [reference] : [],
        },
      );
    },
  };
}
