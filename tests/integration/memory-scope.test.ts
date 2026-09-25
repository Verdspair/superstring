// P2a: memory read/write scope for a non-web conversation (ADR0018).
//
// Long-term memory is owned by the Agent and, until now, every read was
// agent-level. A QQ group/private conversation needs its own `scope_key` so two
// groups of the same assistant cannot see each other, while the existing web
// behaviour must stay identical. These tests pin both halves: an unscoped read is
// still agent-level, and a scoped read never escapes its keys.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { catalog, catalogFingerprint, memoryBodies } from "../../src/server/db/context-repository";
import { enqueue, entries, policy } from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  type MemoryScopeKeys,
  qqMemoryScopeKeyset,
  scopeKeyVisible,
  webMemoryScopeKeyset,
} from "../../src/server/services/memory-scope";
import type { QqMemoryAccess, QqMemoryScope } from "../../src/server/services/qq-binding-contract";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";

function qqScope(
  conversationKind: "group" | "private",
  peerId: string,
  accountId = "10001",
): QqMemoryScope {
  return { kind: "qq", accountId, conversationKind, peerId, agentId: AGENT_ID };
}
const WEB_SCOPE: QqMemoryScope = { kind: "web", agentId: AGENT_ID };
function isolated(
  conversationKind: "group" | "private",
  peerId: string,
  accountId = "10001",
): QqMemoryAccess {
  const history = qqScope(conversationKind, peerId, accountId);
  return {
    conversationKey: JSON.stringify(["qq", accountId, conversationKind, peerId]),
    historyScope: history,
    readScopes: [history],
    writeScope: history,
  };
}
const GROUP_A = isolated("group", "20001");
const GROUP_B = isolated("group", "20002");
/** Same peer id, different account: must not collide with GROUP_A. */
const OTHER_ACCOUNT = isolated("group", "20001", "10002");
/** The user's own private chat with sharing switched on. */
const OWNER_SHARED: QqMemoryAccess = {
  ...isolated("private", "20001"),
  readScopes: [qqScope("private", "20001"), WEB_SCOPE],
  writeScope: WEB_SCOPE,
};

type Orm = ReturnType<typeof openBusinessDb>["orm"];

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  policy(business.orm, AGENT_ID);
  return { business, orm: business.orm, sessionId };
}

/** Insert an entry with an explicit scope_key, optionally sourced from a real turn. */
function seedEntry(
  orm: Orm,
  id: string,
  scopeKey: string,
  sessionId: string,
  options: { status?: string; withSource?: boolean } = {},
): string {
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: `记忆 ${id}`,
      summary: "简介",
      tags: JSON.stringify(["t"]),
      kinds: JSON.stringify(["semantic"]),
      body: `正文 ${id}`,
      scope: "reality_user",
      scopeKey,
      status: options.status ?? "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  if (options.withSource !== false) {
    const prep = prepareTurn(orm, sessionId, `问 ${id}`, `cr_${id}`);
    const token = prep.generationToken;
    if (token === null) throw new Error("expected a fresh generation token");
    saveCompletedAssistantMessage(orm, sessionId, `答 ${id}`, `cr_${id}`, token);
    const turn = getTurnByRequest(orm, sessionId, `cr_${id}`);
    if (!turn) throw new Error("expected the turn to exist");
    const messages = orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, turn.id))
      .all();
    const user = messages.find((message) => message.role === "user");
    const assistant = messages.find((message) => message.role === "assistant");
    if (!user || !assistant) throw new Error("expected both messages");
    orm
      .insert(schema.memorySources)
      .values({
        memoryId: id,
        turnId: turn.id,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        sequenceNo: user.sequenceNo,
      })
      .run();
  }
  return id;
}

function idsOf(orm: Orm, sessionId: string, scopeKeys?: MemoryScopeKeys): string[] {
  return catalog(orm, AGENT_ID, sessionId, { allEntries: true, scopeKeys })
    .map((item) => item.id)
    .sort();
}

describe("memory scope keysets", () => {
  it("keeps the web keyset agent-level and unscoped", () => {
    const keyset = webMemoryScopeKeyset(AGENT_ID);
    expect(keyset.read).toBeNull();
    expect(keyset.write).toBe(AGENT_ID);
    // An unscoped read stays visible to everything, matching today's behaviour.
    expect(scopeKeyVisible(AGENT_ID, keyset.read)).toBe(true);
    expect(scopeKeyVisible('["qq","10001","group","20001","x"]', keyset.read)).toBe(true);
  });

  it("derives distinguishable keys per conversation, and shares only when enabled", () => {
    const a = qqMemoryScopeKeyset(GROUP_A);
    const b = qqMemoryScopeKeyset(GROUP_B);
    const other = qqMemoryScopeKeyset(OTHER_ACCOUNT);
    const shared = qqMemoryScopeKeyset(OWNER_SHARED);
    expect(a.read).toEqual([a.write]);
    expect(a.write).toBe(`["qq","10001","group","20001","${AGENT_ID}"]`);
    expect(new Set([a.write, b.write, other.write]).size).toBe(3);
    // Sharing reads its own private history plus the web scope, and writes to web.
    // The web key is the bare agent id — the same key existing web rows carry — so a
    // shared read actually finds the user's web memory.
    expect(shared.read).toEqual([qqMemoryScopeKeyset(OWNER_SHARED).read?.[0] ?? "", AGENT_ID]);
    expect(shared.write).toBe(AGENT_ID);
    // The web key is literally the agent id, so it matches rows web already wrote.
    expect(qqMemoryScopeKeyset(OWNER_SHARED).write).toBe(AGENT_ID);
    expect(scopeKeyVisible(AGENT_ID, shared.read)).toBe(true);
    expect(scopeKeyVisible(a.write, shared.read)).toBe(false);
    expect(shared.fingerprintSeed).not.toBe(a.fingerprintSeed);
  });

  it("fails closed for an empty read scope instead of falling back to the agent", () => {
    expect(scopeKeyVisible(AGENT_ID, [])).toBe(false);
    expect(scopeKeyVisible('["qq","10001","group","20001","x"]', [])).toBe(false);
  });
});

describe("scoped recall", () => {
  it("keeps an unscoped read agent-level, including rows with a foreign scope_key", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_qq_a", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_legacy_key", "legacy-key", h.sessionId);
      seedEntry(h.orm, "m_web", AGENT_ID, h.sessionId);
      expect(idsOf(h.orm, h.sessionId)).toEqual(["m_legacy_key", "m_qq_a", "m_web"]);
    } finally {
      h.business.close();
    }
  });

  it("separates two groups, another account and the same peer of a different account", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_a", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_b", qqMemoryScopeKeyset(GROUP_B).write, h.sessionId);
      seedEntry(h.orm, "m_other_account", qqMemoryScopeKeyset(OTHER_ACCOUNT).write, h.sessionId);
      seedEntry(h.orm, "m_web", AGENT_ID, h.sessionId);
      expect(idsOf(h.orm, h.sessionId, qqMemoryScopeKeyset(GROUP_A).read)).toEqual(["m_a"]);
      expect(idsOf(h.orm, h.sessionId, qqMemoryScopeKeyset(GROUP_B).read)).toEqual(["m_b"]);
      expect(idsOf(h.orm, h.sessionId, qqMemoryScopeKeyset(OTHER_ACCOUNT).read)).toEqual([
        "m_other_account",
      ]);
    } finally {
      h.business.close();
    }
  });

  it("lets the shared owner private chat read web memory but not another group's", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_owner", qqMemoryScopeKeyset(OWNER_SHARED).write, h.sessionId);
      seedEntry(h.orm, "m_group_a", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_web", AGENT_ID, h.sessionId);
      expect(idsOf(h.orm, h.sessionId, qqMemoryScopeKeyset(OWNER_SHARED).read)).toEqual([
        "m_owner",
        "m_web",
      ]);
    } finally {
      h.business.close();
    }
  });

  it("returns nothing for an empty read scope and hides non-active rows", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_active", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_suppressed", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId, {
        status: "suppressed",
      });
      expect(idsOf(h.orm, h.sessionId, [])).toEqual([]);
      expect(idsOf(h.orm, h.sessionId, qqMemoryScopeKeyset(GROUP_A).read)).toEqual(["m_active"]);
    } finally {
      h.business.close();
    }
  });

  it("refuses to load bodies outside the read scope, and keeps requested order", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_a1", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_a2", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_web", AGENT_ID, h.sessionId);
      const scope = qqMemoryScopeKeyset(GROUP_A).read;
      expect(
        memoryBodies(h.orm, AGENT_ID, h.sessionId, ["m_a2", "m_a1"], scope).map((i) => i.id),
      ).toEqual(["m_a2", "m_a1"]);
      // A memory that exists but sits in another scope is refused as a whole.
      expect(() => memoryBodies(h.orm, AGENT_ID, h.sessionId, ["m_web"], scope)).toThrow();
      expect(() => memoryBodies(h.orm, AGENT_ID, h.sessionId, ["m_a1", "m_web"], scope)).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("filters entries by scope and still asserts full resolution", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_a", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_web", AGENT_ID, h.sessionId);
      const scope = qqMemoryScopeKeyset(GROUP_A).read;
      expect(entries(h.orm, AGENT_ID, undefined, { scopeKeys: scope }).map((e) => e.id)).toEqual([
        "m_a",
      ]);
      expect(entries(h.orm, AGENT_ID, ["m_a"], { scopeKeys: scope })).toHaveLength(1);
      expect(() => entries(h.orm, AGENT_ID, ["m_web"], { scopeKeys: scope })).toThrow();
      expect(() => entries(h.orm, AGENT_ID, ["m_a", "m_web"], { scopeKeys: scope })).toThrow();
    } finally {
      h.business.close();
    }
  });
});

describe("scope-aware fingerprint", () => {
  it("changes with the read scope and with scope contents", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_a", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      const unscoped = catalogFingerprint(h.orm, AGENT_ID, h.sessionId);
      const fingerprintOf = (keys: MemoryScopeKeys) =>
        catalogFingerprint(h.orm, AGENT_ID, h.sessionId, keys);
      const scopeA = fingerprintOf(qqMemoryScopeKeyset(GROUP_A).read);
      // A read scope that matches the same rows as another is still a different scan,
      // because the digest covers the scope itself.
      expect(scopeA).not.toBe(unscoped);
      expect(fingerprintOf(qqMemoryScopeKeyset(GROUP_A).read)).toBe(scopeA);
      expect(fingerprintOf(qqMemoryScopeKeyset(GROUP_B).read)).not.toBe(scopeA);
      expect(fingerprintOf([])).not.toBe(scopeA);
      seedEntry(h.orm, "m_a2", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      expect(fingerprintOf(qqMemoryScopeKeyset(GROUP_A).read)).not.toBe(scopeA);
    } finally {
      h.business.close();
    }
  });
});

describe("scope-aware enqueue", () => {
  it("freezes the caller's resolved scope instead of re-deriving it", () => {
    const h = setup();
    try {
      const prep = prepareTurn(h.orm, h.sessionId, "问", "cr_job_a");
      const token = prep.generationToken;
      if (token === null) throw new Error("expected a fresh generation token");
      saveCompletedAssistantMessage(h.orm, h.sessionId, "答", "cr_job_a", token);
      const turn = getTurnByRequest(h.orm, h.sessionId, "cr_job_a");
      if (!turn) throw new Error("expected the turn to exist");
      const args = {
        kind: "manual" as const,
        sessionId: h.sessionId,
        turnIds: [turn.id],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      };
      const job = enqueue(h.orm, AGENT_ID, "req_scope_a", args);
      expect((JSON.parse(job.configSnapshot) as { scope_key: string }).scope_key).toBe(
        qqMemoryScopeKeyset(GROUP_A).write,
      );
      // Same request key and payload replays the same job.
      expect(enqueue(h.orm, AGENT_ID, "req_scope_a", args).id).toBe(job.id);
    } finally {
      h.business.close();
    }
  });

  it("keeps the agent-level key for web jobs", () => {
    const h = setup();
    try {
      const prep = prepareTurn(h.orm, h.sessionId, "问", "cr_job_web");
      const token = prep.generationToken;
      if (token === null) throw new Error("expected a fresh generation token");
      saveCompletedAssistantMessage(h.orm, h.sessionId, "答", "cr_job_web", token);
      const turn = getTurnByRequest(h.orm, h.sessionId, "cr_job_web");
      if (!turn) throw new Error("expected the turn to exist");
      const job = enqueue(h.orm, AGENT_ID, "req_web", {
        kind: "manual",
        sessionId: h.sessionId,
        turnIds: [turn.id],
      });
      expect((JSON.parse(job.configSnapshot) as { scope_key: string }).scope_key).toBe(AGENT_ID);
    } finally {
      h.business.close();
    }
  });

  it("refuses a merge that would relocate memory into another scope", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_merge_a", qqMemoryScopeKeyset(GROUP_A).write, h.sessionId);
      seedEntry(h.orm, "m_merge_web", AGENT_ID, h.sessionId);
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_merge_cross", {
          kind: "merge",
          memoryIds: ["m_merge_a", "m_merge_web"],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
        }),
      ).toThrow();
      // Merging within one scope is allowed and keeps that scope's key.
      const job = enqueue(h.orm, AGENT_ID, "req_merge_same", {
        kind: "merge",
        memoryIds: ["m_merge_a"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      expect((JSON.parse(job.configSnapshot) as { scope_key: string }).scope_key).toBe(
        qqMemoryScopeKeyset(GROUP_A).write,
      );
    } finally {
      h.business.close();
    }
  });

  it("still stores the agent-level key for a web merge", () => {
    const h = setup();
    try {
      seedEntry(h.orm, "m_web_merge", AGENT_ID, h.sessionId);
      const job = enqueue(h.orm, AGENT_ID, "req_web_merge", {
        kind: "merge",
        memoryIds: ["m_web_merge"],
      });
      expect((JSON.parse(job.configSnapshot) as { scope_key: string }).scope_key).toBe(AGENT_ID);
    } finally {
      h.business.close();
    }
  });
});
