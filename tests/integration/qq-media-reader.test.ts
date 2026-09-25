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

  it("stores an attributed description and does not read a second time", async () => {
    const h = setup();
    try {
      let calls = 0;
      const adapter = {
        read: async (input: {
          kind: "image" | "record" | "video";
          sourceRef: string;
          model: string;
        }) => {
          calls++;
          expect(input).toEqual({
            kind: "image",
            sourceRef: "upstream-ref",
            model: "vision-local",
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

  it("does not send an unsupported document or use a voice reader without its model", async () => {
    for (const kind of ["file", "record"] as const) {
      const h = setup(kind);
      try {
        const outcome = await readQqMediaOnce(
          h.orm,
          {
            read: async () => {
              throw new Error("must not run");
            },
          },
          base,
        );
        expect(outcome.kind).toBe("unreadable");
        expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(0);
      } finally {
        h.close();
      }
    }
  });

  /**
   * 用户 2026-09-25（第二问）：「试过但没读出来」的闸门只拦**图片**。
   *
   * 语音与视频在这一版设计上永远读不出来（转写协议未定、没有视频解码器）。把它们算成"失败"，
   * 就等于只要群里有语音、还有转写模型，那一小时窗口里的自主接话/冷场发起每次都被按住——
   * 用户报告的"自主接话从不触发"里，这一条是原因之一。
   */
  it("spends an attempt on a voice message but never lets it veto opening", async () => {
    const h = setup("record");
    try {
      const outcome = await readQqMediaOnce(
        h.orm,
        {
          read: async () => {
            throw new Error("QQ media adapter cannot transcribe voice");
          },
        },
        {
          ...base,
          modelConfig: { visionModelName: null, transcriptionModelName: "whisper-local" },
        },
      );
      // 尝试真的花掉了（这一行在管理面上仍能看到"试过、没有描述"）……
      expect(outcome.kind).toBe("failed");
      expect(mediaNoteRow(h.orm, base.eventKey, 0)?.attempts).toBe(1);
      // ……但它不算"没读懂图"，所以不拦主动开口。
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
});
