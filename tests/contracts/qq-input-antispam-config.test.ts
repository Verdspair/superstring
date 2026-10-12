import { describe, expect, it } from "bun:test";
import {
  QQ_ANTISPAM_LIMITS,
  QQ_INPUT_ANTI_SPAM_SCHEME_DEFAULT,
  QqBindingInputAntiSpamSchema,
  QqSchemeInputAntiSpamSchema,
} from "../../src/shared/contracts/qq";
import {
  QQ_ANTISPAM_HISTORICAL_DEFAULTS,
  QqTaskExecutionSnapshotSchema,
  resolveEffectiveInputAntiSpam,
} from "../../src/shared/contracts/qq-task";

describe("QQ input anti-spam thresholds", () => {
  it("defaults new schemes to enabled with historical 3 messages / 3 seconds", () => {
    expect(QQ_ANTISPAM_LIMITS).toEqual({
      minMessagesMin: 2,
      minMessagesMax: 20,
      minMessagesDefault: 3,
      windowSecondsMin: 1,
      windowSecondsMax: 30,
      windowSecondsDefault: 3,
    });
    expect(QQ_INPUT_ANTI_SPAM_SCHEME_DEFAULT).toEqual({
      enabled: true,
      burst_min_messages: 3,
      burst_window_seconds: 3,
    });
  });

  it("accepts both configured boundaries and rejects fractional or out-of-range values", () => {
    for (const minMessages of [2, 20]) {
      expect(
        QqSchemeInputAntiSpamSchema.safeParse({
          enabled: true,
          burst_min_messages: minMessages,
          burst_window_seconds: 3,
        }).success,
      ).toBe(true);
    }
    for (const windowSeconds of [1, 30]) {
      expect(
        QqSchemeInputAntiSpamSchema.safeParse({
          enabled: true,
          burst_min_messages: 3,
          burst_window_seconds: windowSeconds,
        }).success,
      ).toBe(true);
    }
    for (const burst_min_messages of [1, 21, 2.5]) {
      expect(
        QqSchemeInputAntiSpamSchema.safeParse({
          enabled: true,
          burst_min_messages,
          burst_window_seconds: 3,
        }).success,
      ).toBe(false);
    }
    for (const burst_window_seconds of [0, 31, 1.5]) {
      expect(
        QqSchemeInputAntiSpamSchema.safeParse({
          enabled: true,
          burst_min_messages: 3,
          burst_window_seconds,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts nullable binding threshold overrides, enforces both ranges, and keeps null distinct from a value", () => {
    expect(
      QqBindingInputAntiSpamSchema.parse({
        enabled: null,
        burst_min_messages: null,
        burst_window_seconds: null,
      }),
    ).toEqual({ enabled: null, burst_min_messages: null, burst_window_seconds: null });
    for (const burst_min_messages of [2, 20]) {
      expect(
        QqBindingInputAntiSpamSchema.safeParse({
          enabled: null,
          burst_min_messages,
          burst_window_seconds: null,
        }).success,
      ).toBe(true);
    }
    for (const burst_window_seconds of [1, 30]) {
      expect(
        QqBindingInputAntiSpamSchema.safeParse({
          enabled: null,
          burst_min_messages: null,
          burst_window_seconds,
        }).success,
      ).toBe(true);
    }
    for (const [field, value] of [
      ["burst_min_messages", 1],
      ["burst_min_messages", 21],
      ["burst_window_seconds", 0],
      ["burst_window_seconds", 31],
    ] as const) {
      expect(
        QqBindingInputAntiSpamSchema.safeParse({
          enabled: null,
          burst_min_messages: field === "burst_min_messages" ? value : null,
          burst_window_seconds: field === "burst_window_seconds" ? value : null,
        }).success,
      ).toBe(false);
    }
  });

  it("requires threshold snapshot fields as a pair while allowing legacy snapshots with neither", () => {
    const legacy = {
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
      taskClass: "mention" as const,
      cause: "direct_reply" as const,
      sourceFromSeq: 1,
      sourceThroughSeq: 1,
      sourceExpiresAt: null,
      authorizedTargets: ["target"],
      targetParticipants: [{ targetId: "target", speakerId: "speaker" }],
      maxSteps: 1,
      deliveryTtlSeconds: 1,
      mentionTaskLimit: 1,
      ordinaryTaskLimit: 1,
      taskKey: "key",
    };
    expect(QqTaskExecutionSnapshotSchema.safeParse(legacy).success).toBe(true);
    expect(
      QqTaskExecutionSnapshotSchema.safeParse({
        ...legacy,
        antiSpamBurstMinMessages: 2,
      }).success,
    ).toBe(false);
    expect(
      QqTaskExecutionSnapshotSchema.safeParse({
        ...legacy,
        antiSpamBurstMinMessages: 2,
        antiSpamBurstWindowSeconds: 1,
      }).success,
    ).toBe(true);
    expect(QQ_ANTISPAM_HISTORICAL_DEFAULTS).toEqual({
      burstMinMessages: 3,
      burstWindowSeconds: 3,
    });
  });

  it("preserves enabled and resolves each nullable binding override independently", () => {
    const scheme = {
      enabled: true,
      burst_min_messages: 4,
      burst_window_seconds: 9,
    };
    expect(
      QqBindingInputAntiSpamSchema.parse({
        enabled: false,
        burst_min_messages: null,
        burst_window_seconds: 5,
      }),
    ).toEqual({ enabled: false, burst_min_messages: null, burst_window_seconds: 5 });
    expect(
      resolveEffectiveInputAntiSpam(scheme, {
        enabled: false,
        burst_min_messages: 6,
        burst_window_seconds: null,
      }),
    ).toEqual({ enabled: false, burstMinMessages: 6, burstWindowSeconds: 9 });
    expect(
      resolveEffectiveInputAntiSpam(scheme, {
        enabled: null,
        burst_min_messages: null,
        burst_window_seconds: null,
      }),
    ).toEqual({ enabled: true, burstMinMessages: 4, burstWindowSeconds: 9 });
  });
});
