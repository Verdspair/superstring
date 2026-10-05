import { describe, expect, test } from "bun:test";
import { projectQqTextRelations } from "../../src/server/services/qq-text-relations";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type {
  QqConversationScope,
  QqIdentity,
  QqMessageFact,
  QqMessagePart,
} from "../../src/shared/contracts/qq-message";

const SCOPE: QqConversationScope = {
  conversationId: "c1",
  accountId: "90001",
  conversationKind: "group",
  peerId: "30003",
  agentId: "agent1",
  bindingId: "b1",
  bindingEpoch: 1,
  authorityRevision: 1,
};

function identity(overrides: Partial<QqIdentity> = {}): QqIdentity {
  return {
    role: "member",
    qq: "10001",
    groupCard: "阿林",
    personalNickname: "林某",
    legacyDisplayName: null,
    nameState: "known",
    ...overrides,
  };
}

function fact(overrides: Partial<QqMessageFact> = {}): QqMessageFact {
  return {
    id: "m102",
    platformMessageId: "-102",
    seq: 2,
    occurredAtSeconds: 1790920785,
    speaker: identity(),
    parts: [{ kind: "text", text: "你不是就在南京吗？" }],
    mentions: [],
    replyTo: null,
    sources: [],
    completeness: "full",
    ...overrides,
  };
}

function contaminatedFact(): QqMessageFact {
  // 结构兼容的污染字段：类型层面不承认它们，用运行时对象证明白名单。
  return {
    ...fact({
      parts: [
        { kind: "text", text: "你不是就在南京吗？" },
        { kind: "image", mediaId: "image1", category: "expression" },
      ],
      mentions: [
        {
          qq: "10002",
          identity: {
            role: "member",
            qq: "10002",
            groupCard: "小周",
            personalNickname: "周同学",
            legacyDisplayName: null,
            nameState: "known",
          },
        },
      ],
      replyTo: { platformMessageId: "-101" },
    }),
    mediaNotes: ["视觉推断：此人在南京旅行"],
    image_url: "data:image/png;base64,never-store-this",
  } as unknown as QqMessageFact;
}

describe("projectQqTextRelations", () => {
  test("whitelists relationship facts, never image interpretations (plan Step1 anchor)", () => {
    const { records, sources } = projectQqTextRelations({
      facts: [contaminatedFact()],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify({ records, sources });
    expect(json).toContain("你不是就在南京吗？");
    expect(json).toContain("10002");
    expect(json).not.toContain("视觉推断：此人在南京旅行");
    expect(json).not.toContain("image_url");
    expect(json).not.toContain("mediaNotes");
    expect(json).not.toContain("never-store-this");
  });

  test("records carry stable id, platform id, seq, send time and completeness", () => {
    const { records } = projectQqTextRelations({
      facts: [fact()],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "m102",
      platformMessageId: "-102",
      seq: 2,
      occurredAtSeconds: 1790920785,
      completeness: "full",
    });
  });

  test("speaker identity keeps dual nicknames; currentName is a separate mapping, never merged", () => {
    const { records } = projectQqTextRelations({
      facts: [
        fact({
          speaker: identity({
            legacyDisplayName: "老林",
            nameState: "legacy",
            currentName: { groupCard: "阿林2", personalNickname: "林某2" },
          }),
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const record = records[0] as {
      speaker: Record<string, unknown>;
      currentName?: Record<string, unknown>;
    };
    expect(record.speaker).toMatchObject({
      role: "member",
      qq: "10001",
      groupCard: "阿林",
      personalNickname: "林某",
      legacyDisplayName: "老林",
      nameState: "legacy",
    });
    // 当前映射另列，不混入发送时快照。
    expect(record.currentName).toEqual({ groupCard: "阿林2", personalNickname: "林某2" });
    expect(JSON.stringify(record.speaker)).not.toContain("阿林2");
  });

  test("text/mention/face/image existence facts are ordered per part; mentions list is separate", () => {
    const parts: QqMessagePart[] = [
      { kind: "text", text: "前文" },
      { kind: "mention", qq: "10002" },
      { kind: "face", id: "f1", name: "笑" },
      { kind: "text", text: "中段" },
      { kind: "image", mediaId: "image1", category: "ordinary" },
      { kind: "text", text: "你不是就在南京吗？" },
    ];
    const { records } = projectQqTextRelations({
      facts: [fact({ parts, mentions: [{ qq: "10002", identity: null }] })],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify(records);
    // 原顺序保留，face/image 只保存在已知事实（existence + id/category/name）。
    const order = ["前文", "mention", "f1", "中段", "image1", "ordinary", "你不是就在南京吗？"];
    let cursor = -1;
    for (const marker of order) {
      const at = json.indexOf(marker, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    // mention 点名列表与本条 mentions 分开：点名对象仍可核。
    expect(json).toContain("10002");
  });

  test("unknown identity fields are dropped, not spread", () => {
    const rogue = {
      ...fact({ speaker: identity() }),
      // 身份对象内的未知字段也必须被丢弃。
    } as unknown as QqMessageFact;
    (rogue.speaker as unknown as Record<string, unknown>).hometown = "南京";
    (rogue.speaker as unknown as Record<string, unknown>).avatarUrl = "http://x/y.png";
    const { records } = projectQqTextRelations({
      facts: [rogue],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify(records);
    expect(json).not.toContain("hometown");
    expect(json).not.toContain("avatarUrl");
    expect(json).not.toContain("y.png");
  });

  test("user's own words containing visual-describing keywords are kept verbatim", () => {
    const { records } = projectQqTextRelations({
      facts: [
        fact({
          parts: [{ kind: "text", text: "我看图片里就是南京站，画面里很像" }],
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify(records);
    expect(json).toContain("我看图片里就是南京站，画面里很像");
  });

  test("image parts keep only kind/mediaId/category known facts, no caption/path/base64", () => {
    const { records } = projectQqTextRelations({
      facts: [
        fact({
          parts: [{ kind: "image", mediaId: "img9", category: "unknown" }],
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify(records);
    expect(json).toContain("img9");
    expect(json).toContain("unknown");
    expect(json).not.toContain("http");
    expect(json).not.toContain("base64");
  });

  test("two members sharing the same QQ-derived nickname stay distinct by stable message id", () => {
    const a = fact({
      id: "ma",
      speaker: identity({ qq: "10001", groupCard: "同名", personalNickname: "同名" }),
    });
    const b = fact({
      id: "mb",
      seq: 3,
      speaker: identity({ qq: "20002", groupCard: "同名", personalNickname: "同名" }),
    });
    const { records } = projectQqTextRelations({
      facts: [a, b],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const ids = records.map((r) => (r as { id: string }).id);
    expect(ids).toEqual(["ma", "mb"]);
    const qqs = records.map((r) => (r as { speaker: { qq: string } }).speaker.qq);
    expect(qqs).toEqual(["10001", "20002"]);
  });

  test("anonymous messages stay distinct by message id; no invented QQ/platform anonymousId", () => {
    const anon = (id: string, seq: number) =>
      fact({
        id,
        seq,
        speaker: identity({
          role: "anonymous",
          qq: null,
          groupCard: null,
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "unknown",
        }),
      });
    const { records } = projectQqTextRelations({
      facts: [anon("an1", 4), anon("an2", 5)],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify(records);
    expect(json).toContain("an1");
    expect(json).toContain("an2");
    // 不归并为同一人：两条各自独立记录。
    expect(records).toHaveLength(2);
    // 不造 QQ / platform anonymousId：speaker.qq 为 null 原样，且无任何编造号。
    for (const r of records) {
      expect((r as { speaker: { qq: string | null } }).speaker.qq).toBeNull();
    }
    expect(json).not.toContain("anonymousId");
  });

  test("replyTo is a relation to platform message id; author text stays attributed to its own author", () => {
    const { records } = projectQqTextRelations({
      facts: [
        fact({
          replyTo: { platformMessageId: "-101" },
          mentions: [],
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const record = records[0] as {
      speaker: { qq: string };
      replyTo: { platformMessageId: string };
    };
    expect(record.replyTo).toEqual({ platformMessageId: "-101" });
    // 引用不改变归属：正文仍是当前作者 10001 的。
    expect(record.speaker.qq).toBe("10001");
  });

  test("expired fact is skipped entirely from records and sources; valid facts stay", () => {
    const expired: SourceRef = {
      kind: "qq_message_fact",
      id: "m102",
      revision: "rev-1",
      expiresAt: "2020-01-01T00:00:00.000Z",
    };
    const valid: SourceRef = {
      kind: "qq_message_fact",
      id: "m103",
      revision: "rev-1",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const { records, sources } = projectQqTextRelations({
      facts: [
        fact({
          sources: [expired],
          speaker: identity({ currentName: { groupCard: "阿林", personalNickname: "林某" } }),
          mentions: [
            {
              qq: "10002",
              identity: identity({ qq: "10002", groupCard: "小周", personalNickname: "周同学" }),
            },
          ],
          replyTo: { platformMessageId: "-101" },
        }),
        fact({
          id: "m103",
          platformMessageId: "-103",
          seq: 3,
          sources: [valid],
          speaker: identity({ qq: "30003", groupCard: "阿福", personalNickname: "福某" }),
          parts: [{ kind: "text", text: "阿福的有效原文" }],
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    // 过期事实整体跳过：无记录、无来源，身份/正文/关系/当前名均不外泄。
    expect(records.map((r) => (r as { id: string }).id)).toEqual(["m103"]);
    const json = JSON.stringify(records);
    expect(json).not.toContain("m102");
    expect(json).not.toContain("你不是就在南京吗？");
    expect(json).not.toContain("阿林");
    expect(json).not.toContain("林某");
    expect(json).not.toContain("小周");
    expect(json).not.toContain("周同学");
    expect(json).not.toContain("10002");
    expect(json).not.toContain("-101");
    expect(sources).toEqual([valid]);
  });

  test("valid (unexpired) source fact keeps currentName mapping", () => {
    const valid: SourceRef = {
      kind: "qq_message_fact",
      id: "m102",
      revision: "rev-1",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const { records } = projectQqTextRelations({
      facts: [
        fact({
          sources: [valid],
          speaker: identity({
            currentName: { groupCard: "阿林", personalNickname: "林某" },
          }),
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const record = records[0] as {
      currentName: { groupCard: string; personalNickname: string } | null;
    };
    expect(record.currentName).toEqual({ groupCard: "阿林", personalNickname: "林某" });
  });

  test("unavailable fact never yields private body, names, mention identities or reply relation", () => {
    const { records } = projectQqTextRelations({
      facts: [
        fact({
          completeness: "unavailable",
          speaker: identity({ currentName: { groupCard: "阿林3", personalNickname: "林某3" } }),
          mentions: [
            {
              qq: "10002",
              identity: identity({ qq: "10002", groupCard: "小周", personalNickname: "周同学" }),
            },
          ],
          replyTo: { platformMessageId: "-101" },
        }),
      ],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    const json = JSON.stringify(records);
    // 无私有正文/名字（含 currentName）、点名身份名、回复关系；身份状态可标不可用。
    expect(json).not.toContain("你不是就在南京吗？");
    expect(json).not.toContain("阿林3");
    expect(json).not.toContain("林某3");
    expect(json).not.toContain("小周");
    expect(json).not.toContain("周同学");
    expect(json).not.toContain("10002");
    expect(json).not.toContain("-101");
    expect(json).toContain("unavailable");
  });

  test("sources: exact dedupe, same key keeps earliest expiry cap, different revisions are not conflated", () => {
    const kept: SourceRef = {
      kind: "qq_message_fact",
      id: "m102",
      revision: "rev-2",
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    const dup: SourceRef = { ...kept };
    const later: SourceRef = {
      kind: "qq_message_fact",
      id: "m102",
      revision: "rev-2",
      expiresAt: "2028-01-01T00:00:00.000Z",
    };
    const noExpiry: SourceRef = { kind: "qq_message_fact", id: "m102", revision: "rev-2" };
    const otherRev: SourceRef = { kind: "qq_message_fact", id: "m102", revision: "rev-1" };
    const { sources } = projectQqTextRelations({
      facts: [fact({ sources: [kept, dup, later, noExpiry, otherRev] })],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(sources).toHaveLength(2);
    expect(sources).toContainEqual(kept);
    expect(sources).toContainEqual(otherRev);
  });

  test("input facts are never mutated", () => {
    const input = contaminatedFact();
    const before = JSON.stringify(input);
    projectQqTextRelations({
      facts: [input],
      scope: SCOPE,
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(JSON.stringify(input)).toBe(before);
  });
});
