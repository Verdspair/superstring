import { describe, expect, it } from "bun:test";
import { attemptedUnreadMediaNoteIds } from "../../src/server/db/qq-media-repository";
import {
  findMediaReadTasksForContent,
  findMediaReadTasksForContents,
  findServableMediaReadTaskByIdentity,
  findSucceededMediaReadTaskForContent,
  mediaReadTaskIdentityKey,
} from "../../src/server/db/qq-media-task-repository";
import { conversationMessagesSince } from "../../src/server/db/qq-observation-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const now = "2033-05-18T03:33:20.000Z";
const live = "2033-05-19T03:33:20.000Z";
const dead = "2033-05-17T03:33:20.000Z";
const identity = {
  accountId: "10001",
  conversationKind: "group",
  peerId: "30003",
  agentId: DEFAULT_AGENT_ID,
  segmentKind: "image",
  contentSha256: "a".repeat(64),
};

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function note(h: ReturnType<typeof setup>, id: string, attempts = 0) {
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: id,
      accountId: identity.accountId,
      conversationKind: identity.conversationKind,
      peerId: identity.peerId,
      agentId: DEFAULT_AGENT_ID,
      messageId: id,
      occurredAtSeconds: 2_000_000_000,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: now,
    })
    .run();
  h.orm
    .insert(schema.qqMediaNotes)
    .values({
      id,
      eventKey: id,
      segmentIndex: 0,
      segmentKind: "image",
      sourceRef: "synthetic",
      attempts,
      addressed: 0,
      expiresAt: live,
      recordedAt: now,
      updatedAt: now,
    })
    .run();
  h.orm
    .insert(schema.qqMediaAssetSources)
    .values({
      id: `source-${id}`,
      assetId: "asset",
      mediaNoteId: id,
      expiresAt: live,
      recordedAt: now,
    })
    .run();
}

function asset(h: ReturnType<typeof setup>) {
  h.orm
    .insert(schema.qqMediaAssets)
    .values({
      id: "asset",
      accountId: identity.accountId,
      conversationKind: identity.conversationKind,
      peerId: identity.peerId,
      agentId: DEFAULT_AGENT_ID,
      contentSha256: identity.contentSha256,
      bytes: Buffer.from([1]),
      mimeType: "image/png",
      revision: 1,
      expiresAt: live,
      recordedAt: now,
    })
    .run();
}

function task(
  h: ReturnType<typeof setup>,
  id: string,
  input: {
    purpose?: "baseline" | "detail";
    questionKey?: string | null;
    requestId?: string | null;
    status?: "failed" | "succeeded";
    expiresAt?: string;
    policy?: string;
    sha?: string;
  },
) {
  const purpose = input.purpose ?? "baseline";
  const succeeded = input.status === "succeeded";
  h.orm
    .insert(schema.qqMediaReadTasks)
    .values({
      id,
      mediaNoteId: null,
      accountId: identity.accountId,
      conversationKind: identity.conversationKind,
      peerId: identity.peerId,
      agentId: DEFAULT_AGENT_ID,
      identityKey: mediaReadTaskIdentityKey({
        ...identity,
        purpose,
        questionKey: input.questionKey,
        requestId: input.requestId,
        contentSha256: input.sha ?? identity.contentSha256,
      }),
      purpose,
      questionKey: input.questionKey ?? null,
      requestId: input.requestId ?? null,
      status: input.status ?? "failed",
      attempts: 1,
      note: succeeded ? "result" : null,
      modelName: succeeded ? "vision" : null,
      policy: input.policy ?? "policy",
      revision: 1,
      expiresAt: input.expiresAt ?? live,
      recordedAt: now,
    })
    .run();
}

function countQueries(h: ReturnType<typeof setup>) {
  const queries: string[] = [];
  for (const method of ["query", "prepare"] as const) {
    const original = h.db[method].bind(h.db);
    h.db[method] = ((query: string) => {
      const statement = original(query);
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...bindings: unknown[]) => {
            if (property === "all" || property === "get" || property === "values")
              queries.push(query);
            return Reflect.apply(value, target, bindings);
          };
        },
      });
    }) as (typeof h.db)[typeof method];
  }
  return queries;
}

function candidateCount(queries: string[]) {
  return queries.filter((query) => {
    const normalized = query.replaceAll('"', "").replace(/\s+/g, " ").toLowerCase();
    return (
      normalized.includes("from qq_media_read_tasks where ") &&
      normalized.includes("qq_media_read_tasks.account_id = ?") &&
      normalized.includes("qq_media_read_tasks.conversation_kind = ?") &&
      normalized.includes("qq_media_read_tasks.peer_id = ?") &&
      normalized.includes("qq_media_read_tasks.agent_id = ?") &&
      normalized.includes("qq_media_read_tasks.identity_key is not null")
    );
  }).length;
}

describe("media repository request-local query work", () => {
  it("one scope query for N repeated notes amid M tasks, with the same old identity verdicts", () => {
    const h = setup();
    try {
      asset(h);
      const ids = Array.from({ length: 24 }, (_, i) => `note-${i}`);
      for (const id of ids) note(h, id);
      task(h, "baseline-failed", {});
      task(h, "detail-success", { purpose: "detail", questionKey: "q", status: "succeeded" });
      task(h, "old-request", {
        purpose: "detail",
        questionKey: "q",
        requestId: "old",
        expiresAt: dead,
      });
      for (let i = 0; i < 40; i++)
        task(h, `unrelated-${i}`, { sha: (i + 1).toString(16).padStart(64, "0") });
      const reference = findMediaReadTasksForContent(h.orm, identity);
      expect(reference.map((row) => row.id).sort()).toEqual(["baseline-failed", "detail-success"]);
      const queries = countQueries(h);
      const batch = findMediaReadTasksForContents(
        h.orm,
        ids.map(() => identity),
      );
      expect(batch.every((rows) => JSON.stringify(rows) === JSON.stringify(reference))).toBe(true);
      expect(candidateCount(queries)).toBe(1);
      queries.length = 0;
      const legacyPerNote = ids.map(() => findMediaReadTasksForContent(h.orm, identity));
      expect(legacyPerNote).toEqual(batch);
      expect(candidateCount(queries)).toBe(ids.length);
      queries.length = 0;
      expect(attemptedUnreadMediaNoteIds(h.orm, ids, now).sort()).toEqual([...ids].sort());
      expect(candidateCount(queries)).toBe(1);
      expect(queries).toHaveLength(3);
      expect(
        findMediaReadTasksForContent(h.orm, { ...identity, requestId: "old" })
          .map((row) => row.id)
          .sort(),
      ).toEqual(["baseline-failed", "old-request"]);
      expect(
        findServableMediaReadTaskByIdentity(h.orm, {
          ...identity,
          purpose: "detail",
          questionKey: "q",
          requestId: "old",
          modelName: "vision",
          policy: "policy",
          now,
        }),
      ).toBeNull();
    } finally {
      h.close();
    }
  });

  it("legacy model-only success resolves row failure; expired success and other purposes cannot", () => {
    const h = setup();
    try {
      asset(h);
      note(h, "legacy-note", 1);
      task(h, "legacy-result", { status: "succeeded", policy: "legacy" });
      task(h, "expired-detail", {
        purpose: "detail",
        questionKey: "old",
        status: "succeeded",
        expiresAt: dead,
      });
      expect(attemptedUnreadMediaNoteIds(h.orm, ["legacy-note"], now)).toEqual([]);
      expect(
        findSucceededMediaReadTaskForContent(h.orm, {
          ...identity,
          purpose: "baseline",
          modelName: "vision",
          policy: "different-policy",
          now,
        })?.id,
      ).toBe("legacy-result");
      expect(
        findSucceededMediaReadTaskForContent(h.orm, {
          ...identity,
          purpose: "baseline",
          modelName: "other-model",
          policy: "legacy",
          now,
        }),
      ).toBeNull();
      expect(
        findSucceededMediaReadTaskForContent(h.orm, {
          ...identity,
          purpose: "detail",
          questionKey: "old",
          modelName: "vision",
          policy: "policy",
          now,
        }),
      ).toBeNull();
    } finally {
      h.close();
    }
  });

  it("source grouping retains all live described sources and suppresses them with includeMediaNotes false", () => {
    const h = setup();
    try {
      asset(h);
      note(h, "event");
      h.db
        .query(
          "UPDATE qq_media_notes SET note='result',note_model='vision',attempts=1 WHERE id='event'",
        )
        .run();
      h.orm
        .insert(schema.qqMediaNotes)
        .values([
          {
            id: "second",
            eventKey: "event",
            segmentIndex: 1,
            segmentKind: "image",
            sourceRef: "two",
            note: "second result",
            noteModel: "vision",
            attempts: 1,
            addressed: 0,
            expiresAt: live,
            recordedAt: now,
            updatedAt: now,
          },
          {
            id: "expired",
            eventKey: "event",
            segmentIndex: 2,
            segmentKind: "image",
            sourceRef: "three",
            note: "dead result",
            noteModel: "vision",
            attempts: 1,
            addressed: 0,
            expiresAt: dead,
            recordedAt: now,
            updatedAt: now,
          },
        ])
        .run();
      const scope = { kind: "qq" as const, ...identity, conversationKind: "group" as const };
      const read = (includeSources: boolean, includeMediaNotes: boolean) =>
        conversationMessagesSince(h.orm, scope, {
          sinceSeconds: 0,
          limit: 10,
          now,
          includeSources,
          includeMediaNotes,
        })[0];
      expect(
        read(true, true)
          ?.sources?.map((ref) => ref.id)
          .sort(),
      ).toEqual(["event", "second"]);
      expect(read(true, true)?.mediaNotes).toHaveLength(2);
      expect(read(false, true)?.sources).toBeUndefined();
      expect(read(true, false)?.sources).toEqual([]);
      expect(read(true, false)?.mediaNotes).toEqual([]);
      expect(read(true, false)?.mediaUnread).toBe(2);
    } finally {
      h.close();
    }
  });
});
