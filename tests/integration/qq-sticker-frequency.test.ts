import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { toOrmHandle } from "../../src/server/db/connection";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { readEffectiveQqScheme } from "../../src/server/db/qq-group-config-repository";
import {
  createQqScheme,
  readQqScheme,
  schemeStickers,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { createSession, ensureDefaults } from "../../src/server/db/repositories";
import { ensureBusinessSchema } from "../../src/server/db/schema-gate";
import { createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QqSchemeStickersSchema } from "../../src/shared/contracts/qq";
import { QqTaskExecutionSnapshotSchema } from "../../src/shared/contracts/qq-task";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";

function setup() {
  const db = new Database(":memory:");
  ensureBusinessSchema(db);
  const orm = toOrmHandle(db).orm;
  ensureDefaults(orm, MODEL);
  createSession(orm, "会话", { modelName: MODEL });
  const scheme = createQqScheme(orm, { name: "频率方案" });
  return { db, orm, scheme };
}

describe("QQ scheme sticker frequency", () => {
  it("keeps legacy task snapshots without minting a frequency default", () => {
    const legacy = QqTaskExecutionSnapshotSchema.parse({
      accountId: "account",
      conversationId: "conversation",
      bindingId: "binding",
      bindingEpoch: 1,
      agentId: "agent",
      schemeId: "scheme",
      bindingRevision: 1,
      authorityRevision: 1,
      schemeRevision: 1,
      agentConfigVersion: 1,
      taskClass: "ordinary",
      cause: "direct_reply",
      sourceFromSeq: 1,
      sourceThroughSeq: 1,
      sourceExpiresAt: null,
      authorizedTargets: ["target"],
      targetParticipants: [{ targetId: "target", speakerId: null }],
      maxSteps: 1,
      deliveryTtlSeconds: 60,
      mentionTaskLimit: 4,
      ordinaryTaskLimit: 1,
      taskKey: "task",
    });
    expect(Object.hasOwn(legacy, "stickerFrequency")).toBe(false);
    expect(
      QqTaskExecutionSnapshotSchema.parse({ ...legacy, stickerFrequency: "low" }).stickerFrequency,
    ).toBe("low");
  });

  it("persists only frequency changes, reads the effective field, and preserves it on unrelated updates", () => {
    const { db, orm, scheme } = setup();
    try {
      expect(schemeStickers(scheme).frequency).toBe("medium");
      const high = updateQqScheme(orm, scheme.id, {
        name: scheme.name,
        stickers: { ...schemeStickers(scheme), frequency: "high" },
        expectedRevision: scheme.revision,
      });
      expect(high.revision).toBe(scheme.revision + 1);
      expect(schemeStickers(high).frequency).toBe("high");
      const unchanged = updateQqScheme(orm, scheme.id, {
        name: scheme.name,
        stickers: { ...schemeStickers(high) },
        expectedRevision: high.revision,
      });
      expect(unchanged.revision).toBe(high.revision);
      const renamed = updateQqScheme(orm, scheme.id, {
        name: "改名方案",
        expectedRevision: unchanged.revision,
      });
      expect(schemeStickers(renamed).frequency).toBe("high");
      expect(readQqScheme(orm, scheme.id)?.stickerFrequency).toBe("high");
      expect(
        db.query("SELECT sticker_frequency FROM qq_schemes WHERE id=?").get(scheme.id),
      ).toEqual({
        sticker_frequency: "high",
      });
      expect(() =>
        db.query("UPDATE qq_schemes SET sticker_frequency='sometimes' WHERE id=?").run(scheme.id),
      ).toThrow();
      const privateBindingResult = createQqBinding({
        id: crypto.randomUUID(),
        accountId: "10001",
        kind: "private",
        peerId: "30001",
        agentId: AGENT_ID,
        schemeId: scheme.id,
        paused: false,
        shareWebMemory: false,
      });
      if (privateBindingResult.kind !== "saved") throw new Error("private binding seed rejected");
      const privateBinding = insertQqBinding(orm, privateBindingResult.binding);
      expect(readEffectiveQqScheme(orm, privateBinding)?.stickerFrequency).toBe("high");
    } finally {
      db.close();
    }
  });

  it("defaults omitted request frequency to medium and returns the selected enum", () => {
    const defaults = QqSchemeStickersSchema.parse({
      sticker_min_repeat_minutes: 10,
      sticker_recent_avoid_count: 5,
    });
    expect(defaults.frequency).toBe("medium");

    for (const frequency of ["low", "medium", "high"] as const) {
      expect(
        QqSchemeStickersSchema.parse({
          sticker_min_repeat_minutes: 10,
          sticker_recent_avoid_count: 5,
          frequency,
        }).frequency,
      ).toBe(frequency);
    }
  });
});
