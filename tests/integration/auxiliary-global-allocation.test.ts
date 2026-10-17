// Auxiliary GLOBAL allocation regression (0068) — current-regression coverage, not a RED claim.
//
// The producers are already implemented and Root's aux-owner file covers knowledge_organize
// fixed/absent plus qq_media_describe fixed/absent. This file adds the lanes that were still
// open, using only isolated production fixtures (real organizer/service modules, synthetic
// gateways, a temp sticker store — never the app's real data area):
//
//   * qq_sticker_annotate: a saved output_reserved is sent BOTH as the preflight reserve and as
//     the leaf's max_tokens (the old preflight-1024 vs unwired-maxTokens mismatch stays repaired);
//     an input_limit gates on the measurable text units only — the images' cost stays unknown,
//     and the gate rejects before any model call instead of faking an image guarantee;
//     an absent profile keeps the old behavior verbatim (1024 preflight reserve, no max_tokens).
//   * qq_media_describe auto: a known capacity caps the measurable text part and the saved
//     output_reserved travels as the hard max_tokens; an unknown capacity fails closed
//     (CONTEXT_CAPACITY_UNKNOWN) — auto is never silently ungated.
//   * knowledge_organize auto: a saved input_limit gates each segment request before the call.
//
// No production change, no native run here (Root executes bun test), relative imports only.

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../../src/server/db/organization-repository";
import { importQqSticker, readQqStickerAsset } from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import type { VisionClient, VisionRequest } from "../../src/server/llm/vision-client";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { createQqMediaAdapter } from "../../src/server/services/qq-media-adapter";
import {
  annotateQqSticker,
  QQ_STICKER_ANNOTATION_OUTPUT_RESERVED,
  type QqStickerAnnotator,
} from "../../src/server/services/qq-sticker-annotation";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { createEphemeralAgentRuntime } from "../harness/ephemeral-runtime";

const MODEL = "qwen/qwen3-4b-2507";
const PNG = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));
const ANNOTATION = JSON.stringify({ description: "合成说明", tags: ["合成"] });

function setup(): BusinessDbHandle {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return business;
}

/** Write a global auxiliary profile through the real organization settings boundary (CAS). */
function setAux(business: BusinessDbHandle, allocation: Record<string, unknown>): void {
  updateOrganizationSettings(business.orm, {
    auxiliary_allocation: allocation,
    expected_revision: readOrganizationSettings(business.orm).revision,
  } as Parameters<typeof updateOrganizationSettings>[1]);
}

function jobStatus(business: BusinessDbHandle): { status: string; error_code: string | null } {
  return business.db
    .query<{ status: string; error_code: string | null }, []>(
      "SELECT status, error_code FROM knowledge_jobs ORDER BY rowid DESC LIMIT 1",
    )
    .get() as { status: string; error_code: string | null };
}

// ---- qq_sticker_annotate ----------------------------------------------------------------

interface StickerCall {
  maxTokens?: number;
  outputReserved?: number;
}

function stickerAnnotator(): { calls: StickerCall[]; annotate: QqStickerAnnotator } {
  const calls: StickerCall[] = [];
  const annotate: QqStickerAnnotator = async (input) => {
    calls.push({ maxTokens: input.maxTokens, outputReserved: input.outputReserved });
    return ANNOTATION;
  };
  return { calls, annotate };
}

function stickerGateway(): Pick<ModelGateway, "loadedContextCapacity"> {
  return { loadedContextCapacity: async () => 16000 };
}

function stickerFixture(business: BusinessDbHandle): {
  store: QqStickerStore;
  id: string;
  dir: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "aux-global-sticker-"));
  const store = new QqStickerStore({ directory: dir });
  const id = crypto.randomUUID();
  const copy = store.importCopy({ assetId: id, bytes: PNG });
  importQqSticker(business.orm, { id, copy, name: "素材.png" });
  return { store, id, dir };
}

async function annotate(
  business: BusinessDbHandle,
  fixture: ReturnType<typeof stickerFixture>,
  annotateFn: QqStickerAnnotator,
) {
  return annotateQqSticker(business.orm, stickerGateway(), annotateFn, fixture.store, {
    assetId: fixture.id,
    visionModel: "vision-local",
  });
}

describe("auxiliary global allocation: qq_sticker_annotate", () => {
  it("sends the saved output_reserved as both the preflight reserve and the leaf maxTokens", async () => {
    const business = setup();
    const fixture = stickerFixture(business);
    try {
      setAux(business, { qq_sticker_annotate: { mode: "fixed", output_reserved: 923 } });
      const { calls, annotate: annotateFn } = stickerAnnotator();
      const result = await annotate(business, fixture, annotateFn);
      expect(result.kind).toBe("annotated");
      // One number, two hard uses: the preflight reserve and the wire max_tokens agree.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.maxTokens).toBe(923);
      expect(calls[0]?.outputReserved).toBe(923);
      // The drafts still land as drafts; nothing else about the asset changed.
      const asset = readQqStickerAsset(business.orm, fixture.id);
      expect(asset?.descriptionDraft).toBe("合成说明");
      expect(asset?.tagsDraft).toEqual(["合成"]);
      expect(asset?.description).toBeNull();
    } finally {
      business.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("keeps the old behavior when no profile exists: 1024 preflight reserve, no maxTokens", async () => {
    const business = setup();
    const fixture = stickerFixture(business);
    try {
      const { calls, annotate: annotateFn } = stickerAnnotator();
      const result = await annotate(business, fixture, annotateFn);
      expect(result.kind).toBe("annotated");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.maxTokens).toBeUndefined();
      expect(calls[0]?.outputReserved).toBe(QQ_STICKER_ANNOTATION_OUTPUT_RESERVED);
    } finally {
      business.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("gates a saved input_limit on the measurable text units before any model call", async () => {
    const business = setup();
    const fixture = stickerFixture(business);
    try {
      // The fixed prompt text alone exceeds 1 estimated unit; the image cost is NOT counted
      // (unknown stays unknown), so this proves the text gate rejects without any call.
      setAux(business, { qq_sticker_annotate: { mode: "fixed", input_limit: 1 } });
      const { calls, annotate: annotateFn } = stickerAnnotator();
      const result = await annotate(business, fixture, annotateFn);
      expect(result).toEqual({ kind: "rejected", reason: "capacity_exceeded" });
      expect(calls).toHaveLength(0);
    } finally {
      business.close();
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ---- qq_media_describe (auto) -----------------------------------------------------------

function visionClient() {
  const calls: VisionRequest[] = [];
  const client: VisionClient = {
    annotate: async (request) => {
      calls.push(request);
      return "一张合成图片";
    },
  };
  return { calls, client };
}

describe("auxiliary global allocation: qq_media_describe auto", () => {
  it("caps the measurable text part by the known capacity and sends output_reserved as maxTokens", async () => {
    const business = setup();
    const { calls, client } = visionClient();
    const runtime = createEphemeralAgentRuntime({ vision: client });
    try {
      const adapter = createQqMediaAdapter({
        fetchSource: async () => ({ bytes: PNG }),
        agentRuntime: runtime,
        prompt: "如实说明这条消息里的媒体内容。",
        auxiliary_allocation: { mode: "auto", output_reserved: 500 },
        loadedContextCapacity: async () => 16000,
      });
      expect(
        await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local", bytes: PNG }),
      ).toBe("一张合成图片");
      // Known capacity admits the request; the saved reserve is the hard wire cap.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.maxTokens).toBe(500);
    } finally {
      runtime.close();
      business.close();
    }
  });

  it("fails closed when the auto capacity source is unknown instead of faking an ungated auto", async () => {
    const business = setup();
    const { calls, client } = visionClient();
    const runtime = createEphemeralAgentRuntime({ vision: client });
    try {
      const adapter = createQqMediaAdapter({
        fetchSource: async () => ({ bytes: PNG }),
        agentRuntime: runtime,
        prompt: "如实说明这条消息里的媒体内容。",
        auxiliary_allocation: { mode: "auto" },
        loadedContextCapacity: async () => null,
      });
      await expect(
        adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local", bytes: PNG }),
      ).rejects.toThrow("CONTEXT_CAPACITY_UNKNOWN");
      expect(calls).toHaveLength(0);
    } finally {
      runtime.close();
      business.close();
    }
  });
});

// ---- knowledge_organize (auto gate) -----------------------------------------------------

function knowledgeGateway(calls: { maxTokens?: number }[]): ModelGateway {
  return {
    config: { baseUrl: "http://synthetic.invalid/v1", model: MODEL, timeoutSeconds: 1 },
    async listModels() {
      return [MODEL];
    },
    async loadedContextCapacity() {
      return 16000;
    },
    async probeModelLoaded() {
      return true;
    },
    async complete(options) {
      calls.push(options);
      return JSON.stringify({ summary: "设备条件", tags: ["设备"], body: "阈值42.5。" });
    },
    async *streamChat() {
      yield "synthetic";
    },
  };
}

describe("auxiliary global allocation: knowledge_organize auto", () => {
  it("gates a saved input_limit per segment request before the model call", async () => {
    const business = setup();
    try {
      setAux(business, { knowledge_organize: { mode: "auto", input_limit: 1 } });
      const calls: { maxTokens?: number }[] = [];
      const organizer = new KnowledgeOrganizer({
        db: business.db,
        orm: business.orm,
        gateway: knowledgeGateway(calls),
      });
      new KnowledgeRepository(business.db).importDocument({
        category_id: "default",
        name: "合成资料",
        original_text: "阈值42.5，例外仅限维护模式。",
      });
      expect(await organizer.runCycle()).toBe(true);
      // The full request (prompt + segment + response schema) exceeds 1 unit: fail closed.
      expect(calls).toHaveLength(0);
      expect(jobStatus(business)).toEqual({ status: "failed", error_code: "CONTEXT_AUX_BUDGET" });
      expect(business.db.query("SELECT id FROM knowledge_drafts").all()).toEqual([]);
      await organizer.stop();
    } finally {
      business.close();
    }
  });
});
