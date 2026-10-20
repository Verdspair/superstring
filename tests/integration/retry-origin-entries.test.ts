// R42 leaf-entry retry origins: the trusted host declares the origin at the actual leaf input,
// so the retry budget owner is decided at the live entry, never by an owner.kind regex and never
// promoted by the leaf itself. Selected entries covered here with injected runtimes: the sticker
// annotator (system, although its owner is qq_sticker), the QQ background watermark compressor
// (qq, declared on the compressor options because it runs outside any host ALS), and the QQ media
// adapter (qq from its options, forwarded to the vision leaf). The DB-backed workers (memory
// job origin from the real job snapshot, knowledge organizer, web ContextBuilder) are wired the
// same way and covered by source review; extending this file with DB fixtures is Root's call.

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LeafAgentRuntime } from "../../src/server/agent/agent-runtime";
import {
  type CompressionRecord,
  ConversationCompressor,
} from "../../src/server/agent/conversation-compression";
import { importQqSticker, readQqStickerAsset } from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { AppError } from "../../src/server/errors";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { createQqMediaAdapter } from "../../src/server/services/qq-media-adapter";
import {
  annotateQqSticker,
  createQqStickerAnnotator,
} from "../../src/server/services/qq-sticker-annotation";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";

interface CapturedLeaf {
  specId: string | undefined;
  retryOrigin: string | undefined;
  ownerKind: string | undefined;
  assertSources: (() => void) | undefined;
}

function capturingRuntime() {
  const captured: CapturedLeaf[] = [];
  const runtime = {
    completeLeaf: async (
      spec: { id?: string },
      input: {
        retryOrigin?: string;
        assertSources?: () => void;
        owner?: { kind: string };
        validate?: (text: string) => unknown;
        messages: { content: string }[];
      },
    ) => {
      captured.push({
        specId: spec.id,
        retryOrigin: input.retryOrigin,
        ownerKind: input.owner?.kind,
        assertSources: input.assertSources,
      });
      const payload = JSON.parse(input.messages[1]?.content ?? "{}") as {
        events?: { id: string; speaker: string }[];
      };
      const raw = JSON.stringify({
        facts: (payload.events ?? []).map((event) => ({
          kind: "fact",
          speaker: event.speaker,
          text: "旧事实",
          source_ids: [event.id],
        })),
      });
      input.validate?.(raw);
      return raw;
    },
    completeVisionLeaf: async (
      spec: { id?: string },
      input: { retryOrigin?: string; assertSources?: () => void; owner?: { kind: string } },
    ) => {
      captured.push({
        specId: spec.id,
        retryOrigin: input.retryOrigin,
        ownerKind: input.owner?.kind,
        assertSources: input.assertSources,
      });
      return JSON.stringify({ description: "合成说明", tags: ["合成"] });
    },
  };
  return { captured, runtime: runtime as unknown as LeafAgentRuntime };
}

describe("leaf entry retry origins", () => {
  it("keeps the sticker annotation leaf system-origin although its owner is qq_sticker", async () => {
    const { captured, runtime } = capturingRuntime();
    const annotate = createQqStickerAnnotator(runtime);
    await annotate({
      model: "vision-local",
      prompt: "说明素材",
      images: [{ mimeType: "image/png", bytes: new Uint8Array(8) }],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.specId).toBe("sticker.annotate");
    expect(captured[0]?.retryOrigin).toBe("system");
    expect(captured[0]?.ownerKind).toBe("qq_sticker");
    // 守卫由 annotate 调用方提供（真实素材复验）+ 既有取消信号；下方专门用例触发真实变更。
    expect(() => captured[0]?.assertSources?.()).not.toThrow();
  });

  it("carries the compressor's declared qq origin into the QQ compression leaf", async () => {
    const { captured, runtime } = capturingRuntime();
    let sourcesCurrent = true;
    const compressor = new ConversationCompressor({
      runtime: {
        context_compression_model_name: "compress-model",
        p5_config: {
          auxiliary_timeout_seconds: 30,
          summary_max_tokens: 2048,
          safety_margin_ratio: 0.1,
        },
      },
      gateway: { loadedContextCapacity: async () => 65536 },
      agentRuntime: runtime,
      owner: { kind: "qq_binding", id: "binding-1", userId: "user-1", agentId: "agent-1" },
      assertSources: () => {
        if (!sourcesCurrent) throw new Error("summary sources changed");
      },
      retryOrigin: "qq",
    } as unknown as ConstructorParameters<typeof ConversationCompressor>[0]);
    const records: CompressionRecord[] = [
      {
        id: "event-1",
        seq: 1,
        speaker: "member:20002",
        text: "第一条",
        sources: [{ kind: "qq_observation", id: "obs-1", revision: "rev" }],
      },
    ];
    const evidence = await compressor.summarize({
      records,
      target: 200,
      signal: AbortSignal.timeout(5000),
      requireFacts: true,
    });
    expect(evidence).not.toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0]?.specId).toBe("context.compress.events");
    expect(captured[0]?.retryOrigin).toBe("qq");
    expect(captured[0]?.assertSources).toBeTypeOf("function");
    // 每次额外物理发送前的守卫就是宿主的 assertSources：真实变更必须被它拒绝。
    sourcesCurrent = false;
    expect(() => captured[0]?.assertSources?.()).toThrow();
  });

  it("forwards the QQ media adapter's declared origin to the vision leaf", async () => {
    const { captured, runtime } = capturingRuntime();
    const png = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: png }),
      agentRuntime: runtime,
      prompt: "说明媒体",
      retryOrigin: "qq",
    });
    const cancel = new AbortController();
    await adapter.read({
      kind: "image",
      sourceRef: "ref",
      model: "vision-local",
      signal: cancel.signal,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.specId).toBe("media.describe");
    expect(captured[0]?.retryOrigin).toBe("qq");
    expect(captured[0]?.assertSources).toBeTypeOf("function");
    expect(() => captured[0]?.assertSources?.()).not.toThrow();
    cancel.abort();
    expect(() => captured[0]?.assertSources?.()).toThrow();
  });

  it("leaves the leaf origin unset when the adapter declares none (no promote from the leaf)", async () => {
    const { captured, runtime } = capturingRuntime();
    const png = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));
    const adapter = createQqMediaAdapter({
      fetchSource: async () => ({ bytes: png }),
      agentRuntime: runtime,
      prompt: "说明媒体",
    });
    await adapter.read({ kind: "image", sourceRef: "ref", model: "vision-local" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.retryOrigin).toBeUndefined();
    expect(captured[0]?.assertSources).toBeTypeOf("function");
  });
});

// Sticker per-send source guard: the annotate caller owns the real asset re-verification
// (existence + updatedAt/fileName identity); the annotator factory forwards it and keeps the
// existing cancellation check.

function stickerFixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const dir = mkdtempSync(path.join(tmpdir(), "sticker-origin-"));
  const store = new QqStickerStore({ directory: dir });
  const id = randomUUID();
  const png = new Uint8Array(encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(0x40), 8, 8));
  const copy = store.importCopy({ assetId: id, bytes: png });
  importQqSticker(business.orm, { id, copy, name: "素材.png" });
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    business.close();
  };
  return { business, store, id, cleanup };
}

/** 真实入场信号：叶子被调用即 resolve，测试据此同步推进，不靠轮询。 */
function enteredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function blockingStickerRuntime(
  blocked: Promise<string>,
  entered: { resolve: () => void },
  captured: { retryOrigin?: string; assertSources?: () => void }[],
): LeafAgentRuntime {
  return {
    completeLeaf: async () => {
      throw new Error("sticker annotation never calls the text leaf");
    },
    completeVisionLeaf: async (
      _spec: { id?: string },
      input: { retryOrigin?: string; assertSources?: () => void },
    ) => {
      captured.push({ retryOrigin: input.retryOrigin, assertSources: input.assertSources });
      entered.resolve();
      return blocked;
    },
  } as unknown as LeafAgentRuntime;
}

describe("sticker annotation real source guard", () => {
  it("passes the live guard in flight on an unchanged asset and annotates normally", async () => {
    const { business, store, id, cleanup } = stickerFixture();
    let release!: (value: string) => void;
    const blocked = new Promise<string>((resolve) => {
      release = resolve;
    });
    const entered = enteredSignal();
    const captured: { retryOrigin?: string; assertSources?: () => void }[] = [];
    const running = annotateQqSticker(
      business.orm,
      { loadedContextCapacity: async () => 65536 },
      createQqStickerAnnotator(blockingStickerRuntime(blocked, entered, captured)),
      store,
      { assetId: id, visionModel: "vision-local" },
    );
    try {
      await entered.promise;
      expect(captured[0]?.retryOrigin).toBe("system");
      expect(captured[0]?.assertSources).toBeTypeOf("function");
      // 模型在飞、草稿未写：素材未变 -> 放行。
      expect(() => captured[0]?.assertSources?.()).not.toThrow();
      release(JSON.stringify({ description: "正常说明", tags: ["正常"] }));
      expect(await running).toMatchObject({
        kind: "annotated",
        asset: { id, descriptionDraft: "正常说明", tagsDraft: ["正常"] },
      });
      expect(readQqStickerAsset(business.orm, id)?.descriptionDraft).toBe("正常说明");
    } finally {
      // 失败路径也必须释放并等待落地，避免 DB 先于在飞调用关闭。
      release(JSON.stringify({ description: "正常说明", tags: ["正常"] }));
      await running.catch(() => undefined);
      cleanup();
    }
  });

  it("rejects a concurrent edit live while the model call is in flight", async () => {
    const { business, store, id, cleanup } = stickerFixture();
    let release!: (value: string) => void;
    const blocked = new Promise<string>((resolve) => {
      release = resolve;
    });
    const entered = enteredSignal();
    const captured: { retryOrigin?: string; assertSources?: () => void }[] = [];
    const running = annotateQqSticker(
      business.orm,
      { loadedContextCapacity: async () => 65536 },
      createQqStickerAnnotator(blockingStickerRuntime(blocked, entered, captured)),
      store,
      { assetId: id, visionModel: "vision-local" },
    );
    try {
      await entered.promise;
      expect(() => captured[0]?.assertSources?.()).not.toThrow();
      // 模型在飞时真实并发编辑：同一条闭包必须立刻拒绝。
      business.db
        .query("UPDATE qq_sticker_assets SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
        .run(id);
      expect(() => captured[0]?.assertSources?.()).toThrow();
      release(JSON.stringify({ description: "过期说明", tags: ["过期"] }));
      await expect(running).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(readQqStickerAsset(business.orm, id)?.descriptionDraft).toBeNull();
    } finally {
      // 失败路径也必须释放并等待落地，避免 DB 先于在飞调用关闭。
      release(JSON.stringify({ description: "过期说明", tags: ["过期"] }));
      await running.catch(() => undefined);
      cleanup();
    }
  });

  it("rejects a deletion live while the model call is in flight", async () => {
    const { business, store, id, cleanup } = stickerFixture();
    let release!: (value: string) => void;
    const blocked = new Promise<string>((resolve) => {
      release = resolve;
    });
    const entered = enteredSignal();
    const captured: { retryOrigin?: string; assertSources?: () => void }[] = [];
    const running = annotateQqSticker(
      business.orm,
      { loadedContextCapacity: async () => 65536 },
      createQqStickerAnnotator(blockingStickerRuntime(blocked, entered, captured)),
      store,
      { assetId: id, visionModel: "vision-local" },
    );
    try {
      await entered.promise;
      expect(() => captured[0]?.assertSources?.()).not.toThrow();
      // 模型在飞时真实删除：同一条闭包必须立刻拒绝。
      business.db.query("DELETE FROM qq_sticker_assets WHERE id = ?").run(id);
      expect(() => captured[0]?.assertSources?.()).toThrow();
      release(JSON.stringify({ description: "过期说明", tags: ["过期"] }));
      await expect(running).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(readQqStickerAsset(business.orm, id)).toBeNull();
    } finally {
      // 失败路径也必须释放并等待落地，避免 DB 先于在飞调用关闭。
      release(JSON.stringify({ description: "过期说明", tags: ["过期"] }));
      await running.catch(() => undefined);
      cleanup();
    }
  });

  it("refuses to land a stale draft when the asset changes during the model call", async () => {
    const { business, store, id, cleanup } = stickerFixture();
    try {
      const runtime = {
        completeLeaf: async () => {
          throw new Error("sticker annotation never calls the text leaf");
        },
        completeVisionLeaf: async () => {
          // 模型发送期间素材被并发编辑：结果返回前状态已失效。
          business.db
            .query(
              "UPDATE qq_sticker_assets SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
            )
            .run(id);
          return JSON.stringify({ description: "过期说明", tags: ["过期"] });
        },
      } as unknown as LeafAgentRuntime;
      await expect(
        annotateQqSticker(
          business.orm,
          { loadedContextCapacity: async () => 65536 },
          createQqStickerAnnotator(runtime),
          store,
          { assetId: id, visionModel: "vision-local" },
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      // 失效结果不得落成草稿。
      expect(readQqStickerAsset(business.orm, id)?.descriptionDraft).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("keeps the rejected:model_error envelope for unrelated model AppErrors", async () => {
    const { business, store, id, cleanup } = stickerFixture();
    try {
      const modelFailure = async () => {
        throw new AppError("MODEL_ERROR", "模型调用失败");
      };
      const result = await annotateQqSticker(
        business.orm,
        { loadedContextCapacity: async () => 65536 },
        modelFailure,
        store,
        { assetId: id, visionModel: "vision-local" },
      );
      expect(result).toEqual({ kind: "rejected", reason: "model_error" });
      expect(readQqStickerAsset(business.orm, id)?.descriptionDraft).toBeNull();
    } finally {
      cleanup();
    }
  });
});
