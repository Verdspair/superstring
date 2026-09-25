// §9.2's 生成说明和标签 (ADR0018 P5i).
//
// The model only produces DRAFTS: the description lands in `description_draft`, the tag
// suggestions in `tags_draft`, and no code path promotes either into what the user saved. That is
// the point of the feature — it helps, and the user still decides.
//
// Two seams are injected rather than decided here:
//
//   * the MULTIMODAL TRANSPORT (`annotate` receives the model, the prompt and the images). The
//     gateway's `complete()` carries text only, so an image call needs a protocol decision that
//     §7.1 still lists as pending (image encoding, multi-image handling) — the same pending piece
//     the media reader's adapter marks. Without an injected annotator the route says so.
//   * nothing about the model NAME: it comes from the shared settings row, because "which model
//     looks at pictures" has one answer for the whole QQ side. An unset name means "cannot
//     annotate" — never a fallback to the conversation model, which would describe a picture it
//     cannot see (P4b's rule).
//
// The sampling request below is fixed for now: §7.1 calls the frame count and size 可改, but no
// surface or stored value exists for them yet, and inventing a user-facing parameter here would
// decide something the plan leaves open. ADR0018 records it as pending.

import { z } from "zod";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { LeafAgentRuntime } from "../agent/agent-runtime";
import {
  type QqStickerAssetView,
  readQqStickerAsset,
  saveQqStickerDraft,
  saveQqStickerTagsDraft,
} from "../db/qq-sticker-repository";
import { DEFAULT_USER_ID, type Orm } from "../db/repositories";
import type { ModelGateway } from "../llm/model-gateway";
import { sampleQqAnimationFrames } from "./qq-animation-frames";
import { checkQqModelCapacity } from "./qq-capacity-preflight";
import { QQ_STICKER_CONTENT_TYPES, readQqImageHeader } from "./qq-image-header";
import type { QqStickerStore } from "./qq-sticker-store";

export const QQ_STICKER_ANNOTATION_FRAMES = 3;
export const QQ_STICKER_ANNOTATION_MAX_DIMENSION = 512;
/** Fixed until the plan's 可改 surface exists; the text part of one annotation is short. */
export const QQ_STICKER_ANNOTATION_OUTPUT_RESERVED = 1024;

export const QQ_STICKER_ANNOTATION_PROMPT = [
  "你只做一件事：为这张表情素材写一段说明和几个标签，供之后选图时判断它是否贴合语境。",
  "只写你确实看到的内容：画面里有什么、什么情绪或动作。不推测用途，不评价，不写「适合发在……」。",
  "看不清就如实说看不清，不要编。",
  "只返回 JSON 对象：description 是 1—2 句说明，tags 是 3—6 个短标签（每个不超过 12 个字）。不要添加其他字段。",
].join("\n");

/** The shape the wiring asks the model service to produce; this module parses it again anyway. */
export const QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["description", "tags"],
  properties: {
    description: { type: "string", maxLength: 2000 },
    tags: { type: "array", items: { type: "string", maxLength: 40 }, minItems: 1, maxItems: 6 },
  },
});

export interface QqStickerAnnotatorInput {
  readonly assetId?: string;
  readonly sources?: SourceRef[];
  readonly signal?: AbortSignal;
  readonly model: string;
  readonly prompt: string;
  readonly images: readonly { readonly mimeType: string; readonly bytes: Uint8Array }[];
}

/** The injected multimodal call. It may constrain the output; this module still parses strictly. */
export type QqStickerAnnotator = (input: QqStickerAnnotatorInput) => Promise<string>;

class InvalidStickerAnnotation extends Error {}

/** Production annotation uses the same persisted runtime as text and maintenance tasks. */
export function createQqStickerAnnotator(agentRuntime: LeafAgentRuntime): QqStickerAnnotator {
  return (input) =>
    agentRuntime.completeVisionLeaf(
      {
        id: "sticker.annotate",
        version: "1",
        responseSchema: QQ_STICKER_ANNOTATION_RESPONSE_SCHEMA,
      },
      {
        model: input.model,
        prompt: input.prompt,
        images: input.images,
        signal: input.signal,
        sources: input.sources,
        validate: (text) => {
          if (readAnswer(text) === null)
            throw new InvalidStickerAnnotation("Invalid sticker annotation result");
        },
        owner: { kind: "qq_sticker", id: input.assetId ?? "unbound", userId: DEFAULT_USER_ID },
      },
    );
}

export type QqStickerAnnotationRejection =
  | "model_not_configured"
  | "file_unreadable"
  | "animation_unreadable"
  | "unreadable_answer"
  | "model_error"
  | "capacity_unavailable"
  | "capacity_exceeded";

export type QqStickerAnnotationResult =
  | { readonly kind: "annotated"; readonly asset: QqStickerAssetView }
  | { readonly kind: "rejected"; readonly reason: QqStickerAnnotationRejection };

const AnswerSchema = z.strictObject({
  description: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(50),
});

/** The answer, or null when it is not exactly the shape the prompt asked for. */
function readAnswer(raw: unknown): { description: string; tags: string[] } | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = AnswerSchema.safeParse(parsed);
  if (!result.success) return null;
  return { description: result.data.description, tags: [...new Set(result.data.tags)] };
}

/** The images one annotation carries: the copy itself, or the sampled frames of an animation. */
function readImages(
  bytes: Uint8Array,
  mediaType: string,
):
  | { readonly mimeType: string; readonly bytes: Uint8Array }[]
  | "file_unreadable"
  | "animation_unreadable" {
  if (mediaType === "animation") {
    const sample = sampleQqAnimationFrames(bytes, {
      frames: QQ_STICKER_ANNOTATION_FRAMES,
      maxDimension: QQ_STICKER_ANNOTATION_MAX_DIMENSION,
      budgetTokens: 1,
    });
    if (sample.kind !== "sampled" || sample.frames.length === 0) return "animation_unreadable";
    return sample.frames.map((frame) => ({ mimeType: "image/png", bytes: frame.png }));
  }
  const header = readQqImageHeader(bytes);
  if (header.kind !== "read") return "file_unreadable";
  return [{ mimeType: QQ_STICKER_CONTENT_TYPES[header.format], bytes }];
}

/**
 * Ask the picture model for a description and tags, and store both as drafts.
 *
 * Nothing else changes: the asset's enablement, its reviewed description and its saved tags are
 * exactly what they were before the call.
 */
export async function annotateQqSticker(
  orm: Orm,
  gateway: Pick<ModelGateway, "loadedContextCapacity">,
  annotate: QqStickerAnnotator,
  store: QqStickerStore,
  input: unknown,
  signal?: AbortSignal,
): Promise<QqStickerAnnotationResult> {
  const request = z
    .strictObject({
      assetId: z.string().min(1),
      visionModel: z.string().trim().max(200).nullable(),
    })
    .safeParse(input);
  if (!request.success) throw new TypeError("Invalid QQ sticker annotation input");
  const asset = readQqStickerAsset(orm, request.data.assetId);
  if (asset === null) return { kind: "rejected", reason: "file_unreadable" };
  const model = (request.data.visionModel ?? "").trim();
  if (model === "") return { kind: "rejected", reason: "model_not_configured" };
  let bytes: Uint8Array;
  try {
    bytes = store.readCopy(asset.fileName);
  } catch {
    return { kind: "rejected", reason: "file_unreadable" };
  }
  const images = readImages(bytes, asset.mediaType);
  if (images === "file_unreadable" || images === "animation_unreadable") {
    return { kind: "rejected", reason: images };
  }
  // The prompt's text is what this check can estimate; the images' cost has no unit here (§7.1's
  // budgetTokens note), and the reserve above covers the answer.
  const capacity = await checkQqModelCapacity(gateway, {
    model,
    messages: [{ role: "user", content: QQ_STICKER_ANNOTATION_PROMPT }],
    outputReserved: QQ_STICKER_ANNOTATION_OUTPUT_RESERVED,
  });
  if (capacity.kind !== "allowed") {
    return {
      kind: "rejected",
      reason: capacity.kind === "unavailable" ? "capacity_unavailable" : "capacity_exceeded",
    };
  }
  let raw: string;
  try {
    raw = await annotate({
      model,
      prompt: QQ_STICKER_ANNOTATION_PROMPT,
      images,
      signal,
      assetId: asset.id,
      sources: [{ kind: "qq_sticker", id: asset.id, revision: asset.updatedAt }],
    });
  } catch (error) {
    return {
      kind: "rejected",
      reason: error instanceof InvalidStickerAnnotation ? "unreadable_answer" : "model_error",
    };
  }
  const answer = readAnswer(raw);
  if (answer === null) return { kind: "rejected", reason: "unreadable_answer" };
  saveQqStickerDraft(orm, asset.id, answer.description);
  const saved = saveQqStickerTagsDraft(orm, asset.id, answer.tags);
  return { kind: "annotated", asset: saved };
}
