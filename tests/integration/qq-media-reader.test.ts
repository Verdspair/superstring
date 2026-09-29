import { describe, expect, it } from "bun:test";
import {
  attemptedUnreadMediaCount,
  mediaNoteRow,
  recordMediaSegment,
} from "../../src/server/db/qq-media-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { readQqMediaOnce } from "../../src/server/services/qq-media-reader";

const base = {
  eventKey: "media-1",
  segmentIndex: 0,
  addressedToAssistant: true,
  relatedSupplementArrived: false,
  modelConfig: { visionModelName: "vision-local", transcriptionModelName: null },
};
function setup(kind: "image" | "record" | "video" | "file" = "image") {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "media-reader-test" });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: "11111111-1111-4111-8111-111111111111",
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: "00000000-0000-0000-0000-000000000001",
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: base.eventKey,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId: "00000000-0000-0000-0000-000000000001",
      messageId: "m1",
      occurredAtSeconds: Math.floor(Date.now() / 1000),
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
  recordMediaSegment(h.orm, {
    eventKey: base.eventKey,
    segmentIndex: 0,
    kind,
    sourceRef: "upstream-ref",
    occurredAtSeconds: Math.floor(Date.now() / 1000),
    addressed: true,
  });
  return h;
}

describe("one injected QQ media reading", () => {
  it("does not create a model task for a paused conversation", async () => {
    const h = setup();
    try {
      h.orm.update(schema.qqBindings).set({ paused: 1 }).run();
      expect(
        await readQqMediaOnce(
          h.orm,
          {
            capabilities: ["image"] as const,
            read: async () => {
              throw new Error("must not run");
            },
          },
          base,
        ),
      ).toEqual({ kind: "unreadable", reason: "binding_inactive" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("does not create a model task for an inactive assistant", async () => {
    const h = setup();
    try {
      h.orm.update(schema.agents).set({ isActive: 0 }).run();
      let calls = 0;
      expect(
        await readQqMediaOnce(
          h.orm,
          {
            capabilities: ["image"] as const,
            read: async () => {
              calls++;
              return "不应发生";
            },
          },
          base,
        ),
      ).toEqual({
        kind: "unreadable",
        reason: "binding_inactive",
      });
      expect(calls).toBe(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("discards a description if the assistant is disabled during reading", async () => {
    const h = setup();
    try {
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            h.orm.update(schema.agents).set({ isActive: 0 }).run();
            return "过期授权";
          },
        },
        base,
      );
      expect(outcome).toEqual({ kind: "unreadable", reason: "segment_changed" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("discards an in-flight description if the conversation is paused", async () => {
    const h = setup();
    try {
      const result = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            h.orm.update(schema.qqBindings).set({ paused: 1, revision: 2 }).run();
            return "不应写回";
          },
        },
        base,
      );
      expect(result).toEqual({ kind: "unreadable", reason: "segment_changed" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("rejects a revision loop even when a pause was later undone", async () => {
    const h = setup();
    try {
      const result = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            h.orm.update(schema.qqBindings).set({ paused: 0, revision: 3 }).run();
            return "旧请求结果";
          },
        },
        base,
      );
      expect(result).toEqual({ kind: "unreadable", reason: "segment_changed" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("does not keep an addressed failure waiting after an in-flight pause", async () => {
    const h = setup();
    try {
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            h.orm.update(schema.qqBindings).set({ paused: 1, revision: 2 }).run();
            throw new Error("upstream failed after pause");
          },
        },
        base,
      );
      expect(outcome).toEqual({ kind: "unreadable", reason: "segment_changed" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
    } finally {
      h.close();
    }
  });

  it("does not write a description when the source expires during reading", async () => {
    const h = setup();
    try {
      const result = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            h.orm.update(schema.qqMediaNotes).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).run();
            return "过期结果";
          },
        },
        base,
      );
      expect(result).toEqual({ kind: "unreadable", reason: "segment_changed" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("refuses an expired reference before invoking an external reader", async () => {
    const h = setup();
    try {
      h.orm.update(schema.qqMediaNotes).set({ expiresAt: "2000-01-01T00:00:00.000Z" }).run();
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            throw new Error("must not run");
          },
        },
        base,
      );
      expect(outcome).toEqual({ kind: "unreadable", reason: "segment_expired" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("never invokes a reader without a configured purpose model", async () => {
    const h = setup();
    try {
      let calls = 0;
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            calls++;
            return "x";
          },
        },
        {
          ...base,
          modelConfig: { visionModelName: null, transcriptionModelName: null },
        },
      );
      expect(outcome).toEqual({ kind: "unreadable", reason: "model_not_configured" });
      expect(calls).toBe(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
    } finally {
      h.close();
    }
  });

  it("does not spend the retry while the first read is still in flight", async () => {
    const h = setup();
    try {
      let finish: (description: string) => void = () => {
        throw new Error("first read did not start");
      };
      let started: () => void = () => {
        throw new Error("first read was not initialized");
      };
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const reader = {
        capabilities: ["image"] as const,
        read: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
            started();
          }),
      };
      const first = readQqMediaOnce(h.orm, reader, base);
      await running;
      const second = await readQqMediaOnce(h.orm, reader, {
        ...base,
        relatedSupplementArrived: true,
      });
      expect(second).toEqual({ kind: "unreadable", reason: "read_in_progress" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
      finish("第一轮读到的内容");
      expect(await first).toEqual({ kind: "described", attempt: 1 });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBe("第一轮读到的内容");
    } finally {
      h.close();
    }
  });

  it("releases the local read guard after a failed attempt", async () => {
    const h = setup();
    try {
      const reader = {
        capabilities: ["image"] as const,
        read: async () => {
          throw new Error("synthetic failure");
        },
      };
      expect(await readQqMediaOnce(h.orm, reader, base)).toMatchObject({
        kind: "failed",
        attempt: 1,
      });
      expect(
        await readQqMediaOnce(h.orm, reader, { ...base, relatedSupplementArrived: true }),
      ).toMatchObject({
        kind: "failed",
        attempt: 2,
      });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(2);
    } finally {
      h.close();
    }
  });

  it("reuses a description from the same conversation for an identical reference", async () => {
    const h = setup("image");
    try {
      let calls = 0;
      const adapter = {
        capabilities: ["image"] as const,
        read: async () => {
          calls++;
          return "橘猫";
        },
      };
      expect(await readQqMediaOnce(h.orm, adapter, base)).toEqual({
        kind: "described",
        attempt: 1,
      });
      // 同一张图被再次发出：另一条消息、另一个片段位置、同一个来源引用。
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "media-2",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: "00000000-0000-0000-0000-000000000001",
          messageId: "m2",
          occurredAtSeconds: Math.floor(Date.now() / 1000),
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      recordMediaSegment(h.orm, {
        eventKey: "media-2",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "upstream-ref",
        occurredAtSeconds: Math.floor(Date.now() / 1000),
        addressed: true,
      });
      expect(await readQqMediaOnce(h.orm, adapter, { ...base, eventKey: "media-2" })).toEqual({
        kind: "described",
        attempt: 0,
      });
      expect(calls).toBe(1);
      expect(mediaNoteRow(h.orm, "media-2", 0)).toMatchObject({
        note: "橘猫",
        noteModel: "vision-local",
        attempts: 0,
      });
    } finally {
      h.close();
    }
  });

  it("does not reuse a description from another conversation", async () => {
    const h = setup("image");
    try {
      let calls = 0;
      const adapter = {
        capabilities: ["image"] as const,
        read: async () => {
          calls++;
          return "橘猫";
        },
      };
      expect(await readQqMediaOnce(h.orm, adapter, base)).toEqual({
        kind: "described",
        attempt: 1,
      });
      // 另一间群（不同 peer）里的同一来源引用不得照抄描述：先要有那个绑定。
      const schemeRow = h.orm.select().from(schema.qqSchemes).get();
      h.orm
        .insert(schema.qqBindings)
        .values({
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30004",
          agentId: "00000000-0000-0000-0000-000000000001",
          schemeId: schemeRow?.id ?? "",
          paused: 0,
          shareWebMemory: 0,
          memoryBatchSize: null,
          ownerIdentityRevision: null,
          revision: 1,
          authorityRevision: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .run();
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "media-other",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30004",
          agentId: "00000000-0000-0000-0000-000000000001",
          messageId: "m3",
          occurredAtSeconds: Math.floor(Date.now() / 1000),
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      recordMediaSegment(h.orm, {
        eventKey: "media-other",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "upstream-ref",
        occurredAtSeconds: Math.floor(Date.now() / 1000),
        addressed: true,
      });
      expect(await readQqMediaOnce(h.orm, adapter, { ...base, eventKey: "media-other" })).toEqual({
        kind: "described",
        attempt: 1,
      });
      expect(calls).toBe(2);
    } finally {
      h.close();
    }
  });

  it("stores an attributed description and does not read a second time", async () => {
    const h = setup();
    try {
      let calls = 0;
      const adapter = {
        capabilities: ["image"] as const,
        read: async (input: {
          kind: "image" | "record" | "video";
          sourceRef: string;
          model: string;
        }) => {
          calls++;
          expect(input).toMatchObject({
            kind: "image",
            sourceRef: "upstream-ref",
            model: "vision-local",
            source: { kind: "qq_media", revision: "1" },
            owner: { kind: "qq_media" },
          });
          return "橘猫";
        },
      };
      expect(await readQqMediaOnce(h.orm, adapter, base)).toEqual({
        kind: "described",
        attempt: 1,
      });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)).toMatchObject({
        note: "橘猫",
        noteModel: "vision-local",
        attempts: 1,
      });
      expect(await readQqMediaOnce(h.orm, adapter, base)).toEqual({
        kind: "unreadable",
        reason: "already_described",
      });
      expect(calls).toBe(1);
    } finally {
      h.close();
    }
  });

  it("fails silently, waits for related supplement, then stops after the second attempt", async () => {
    const h = setup();
    try {
      let calls = 0;
      const adapter = {
        capabilities: ["image"] as const,
        read: async () => {
          calls++;
          throw new Error("secret upstream failure");
        },
      };
      expect(await readQqMediaOnce(h.orm, adapter, base)).toEqual({
        kind: "failed",
        attempt: 1,
        announceInConversation: false,
        awaitSupplement: true,
      });
      expect(await readQqMediaOnce(h.orm, adapter, base)).toEqual({
        kind: "unreadable",
        reason: "awaiting_supplement",
      });
      expect(
        await readQqMediaOnce(h.orm, adapter, { ...base, relatedSupplementArrived: true }),
      ).toEqual({
        kind: "failed",
        attempt: 2,
        announceInConversation: false,
        awaitSupplement: false,
      });
      expect(
        await readQqMediaOnce(h.orm, adapter, { ...base, relatedSupplementArrived: true }),
      ).toEqual({ kind: "unreadable", reason: "attempts_exhausted" });
      expect(calls).toBe(2);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBeNull();
    } finally {
      h.close();
    }
  });

  it("never retries a non-addressed failure, even after a supplement", async () => {
    const h = setup();
    try {
      let calls = 0;
      const adapter = {
        capabilities: ["image"] as const,
        read: async () => {
          calls++;
          return " ";
        },
      };
      const nonAddressed = { ...base, addressedToAssistant: false };
      expect(await readQqMediaOnce(h.orm, adapter, nonAddressed)).toMatchObject({
        kind: "failed",
        awaitSupplement: false,
      });
      expect(
        await readQqMediaOnce(h.orm, adapter, { ...nonAddressed, relatedSupplementArrived: true }),
      ).toEqual({ kind: "unreadable", reason: "not_addressed" });
      expect(calls).toBe(1);
    } finally {
      h.close();
    }
  });

  it("never attempts a document, voice or video segment the adapter cannot read", async () => {
    for (const kind of ["file", "record", "video"] as const) {
      // 文件不属于可读种类（策划上就不是媒体理解对象），语音与视频是"实现声明读不了"。
      const reason = kind === "file" ? "unsupported_kind" : "capability_unavailable";
      const h = setup(kind);
      try {
        const outcome = await readQqMediaOnce(
          h.orm,
          {
            capabilities: ["image"] as const,
            read: async () => {
              throw new Error("must not run");
            },
          },
          base,
        );
        // 0.4.0 P5：能力声明先于一切——读不了的种类连尝试都不花。
        expect(outcome).toEqual({ kind: "unreadable", reason });
        expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      } finally {
        h.close();
      }
    }
  });

  /**
   * （第二问）：「试过但没读出来」的闸门只拦**图片**。
   *
   * 语音与视频在这一版设计上永远读不出来（转写协议未定、没有视频解码器）。0.4.0 P5 起由
   * 适配器的能力声明**在花钱之前**判定：配了转写模型也不试、不记尝试、不产生失败——
   * "本来读不了"与"试过失败"从此是两件事，管理面上不再堆积永远失败的语音行。
   */
  it("declares voice unavailable instead of spending an attempt that can never succeed", async () => {
    const h = setup("record");
    try {
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            throw new Error("QQ media adapter cannot transcribe voice");
          },
        },
        {
          ...base,
          modelConfig: { visionModelName: null, transcriptionModelName: "whisper-local" },
        },
      );
      expect(outcome).toEqual({ kind: "unreadable", reason: "capability_unavailable" });
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      // 不花尝试，也就不拦主动开口。
      expect(attemptedUnreadMediaCount(h.orm, [base.eventKey])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("still counts a failed image as 'tried but unread'", async () => {
    const h = setup("image");
    try {
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            throw new Error("vision call failed: 400");
          },
        },
        base,
      );
      expect(outcome.kind).toBe("failed");
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
      expect(attemptedUnreadMediaCount(h.orm, [base.eventKey])).toBe(1);
    } finally {
      h.close();
    }
  });

  it("does not reuse a description across a rebind to another assistant", async () => {
    const h = setup("image");
    try {
      expect(
        await readQqMediaOnce(
          h.orm,
          { capabilities: ["image"] as const, read: async () => "橘猫" },
          base,
        ),
      ).toEqual({ kind: "described", attempt: 1 });
      // 改绑到第二任助手：绑定行换人，来源引用不变。
      h.orm
        .insert(schema.agents)
        .values({
          id: "00000000-0000-0000-0000-000000000002",
          name: "二号助手",
          systemPrompt: "synthetic",
          description: "",
          additionalInstructions: "",
          p5Config: "{}",
          modelName: "synthetic-model",
          temperature: 0.7,
          memoryConsolidationModelName: null,
          memoryConsolidationPrompt: "synthetic",
          memoryConsolidationAdditionalInstructions: "",
          memoryRetrievalModelName: null,
          memoryRetrievalPrompt: "synthetic",
          contextCompressionModelName: null,
          personaIntensity: 60,
          isActive: 1,
          configVersion: 1,
          updatedAt: nowIso(),
          createdAt: nowIso(),
        })
        .run();
      h.orm
        .update(schema.qqBindings)
        .set({ agentId: "00000000-0000-0000-0000-000000000002", revision: 2, authorityRevision: 2 })
        .run();
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "media-rebound",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: "00000000-0000-0000-0000-000000000002",
          messageId: "m-rebound",
          occurredAtSeconds: Math.floor(Date.now() / 1000),
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      recordMediaSegment(h.orm, {
        eventKey: "media-rebound",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "upstream-ref",
        occurredAtSeconds: Math.floor(Date.now() / 1000),
        addressed: true,
      });
      let calls = 0;
      const second = {
        capabilities: ["image"] as const,
        read: async () => {
          calls++;
          return "改绑后的读法";
        },
      };
      expect(await readQqMediaOnce(h.orm, second, { ...base, eventKey: "media-rebound" })).toEqual({
        kind: "described",
        attempt: 1,
      });
      expect(calls).toBe(1);
      expect(mediaNoteRow(h.orm, "media-rebound", 0)).toMatchObject({
        note: "改绑后的读法",
        noteModel: "vision-local",
      });
      // 旧助手的描述留在旧行上，不被漂移、也不被改写。
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.note).toBe("橘猫");
    } finally {
      h.close();
    }
  });

  it("refuses a cancelled read before claiming anything", async () => {
    const h = setup();
    try {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      await expect(
        readQqMediaOnce(
          h.orm,
          {
            capabilities: ["image"] as const,
            read: async () => {
              calls++;
              return "不应发生";
            },
          },
          base,
          controller.signal,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(mediaNoteRow(h.orm, base.eventKey, 0)).toMatchObject({ attempts: 0, note: null });
    } finally {
      h.close();
    }
  });

  it("rejects a late description after cancellation instead of writing it", async () => {
    const h = setup();
    try {
      const controller = new AbortController();
      const pending = readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async (input: { signal?: AbortSignal }) => {
            // 取消信号贯穿到适配器：取流/视觉调用必须能看见它。
            expect(input.signal).toBe(controller.signal);
            controller.abort();
            return "迟到的描述";
          },
        },
        base,
        controller.signal,
      );
      await expect(pending).rejects.toThrow();
      const row = mediaNoteRow(h.orm, base.eventKey, 0);
      expect(row?.note).toBeNull();
      // 尝试在取流前已认领：取消不写回，但这一次尝试不会被取消"复活"。
      expect(row?.attempts).toBe(1);
    } finally {
      h.close();
    }
  });

  it("rejects a cancelled read instead of recording it as a failure", async () => {
    const h = setup();
    try {
      const controller = new AbortController();
      const pending = readQqMediaOnce(
        h.orm,
        {
          capabilities: ["image"] as const,
          read: async () => {
            controller.abort();
            throw new Error("cancelled upstream failure");
          },
        },
        base,
        controller.signal,
      );
      await expect(pending).rejects.toThrow();
      expect(mediaNoteRow(h.orm, base.eventKey, 0)).toMatchObject({ attempts: 1, note: null });
    } finally {
      h.close();
    }
  });
});
