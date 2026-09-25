import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { enqueue, govern } from "../../src/server/db/memory-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  captureQqTask,
  createQqBinding,
  qqConversationKey,
  qqConversationScope,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import { qqImmediateOpenings } from "../../src/server/services/qq-judgement-runner";
import { enqueueQqMemoryNow } from "../../src/server/services/qq-memory-enqueue";
import {
  qqMemoryReadIsCurrent,
  recallQqReplyMemory,
} from "../../src/server/services/qq-memory-recall";
import { generateQqTextReply } from "../../src/server/services/qq-reply-runner";
import { pendingQqReview } from "../../src/server/services/qq-review-runner";
import { checkQqTextPreflight } from "../../src/server/services/qq-send-preflight";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { MemoryScopeViewSchema } from "../../src/shared/contracts";
import { memoryScopeIdentity } from "../../src/shared/memory-scope";

const agentId = "00000000-0000-0000-0000-000000000001";
const now = Math.floor(Date.now() / 1000);
function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic");
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "test",
    triggers: { direct_reply: true, follow_up: true, chiming_in: true, idle_topic: true },
  });
  const result = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (result.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(h.orm, result.binding);
  const captured = captureQqTask(binding, "reply");
  if (captured.kind !== "captured") throw new Error("snapshot");
  const agent = getAgentRow(h.orm, agentId);
  if (!agent) throw new Error("agent");
  const runtime = runtimeFromAgent(agent);
  return { ...h, binding, snapshot: captured.snapshot, runtime, app: createApp({ business: h }) };
}
function seed(h: ReturnType<typeof setup>, peerId: string, body: string, status = "active") {
  const id = crypto.randomUUID();
  const key = qqMemoryScopeKey({ ...qqConversationScope(h.binding), peerId });
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey: id,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      messageId: id,
      occurredAtSeconds: now - 40,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: nowIso(),
    })
    .run();
  h.orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: id,
      body: "Tell me about apples",
      occurredAtSeconds: now - 40,
      expiresAt: new Date((now + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
  h.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId,
      userId: DEFAULT_USER_ID,
      name: body,
      summary: body,
      tags: "[]",
      kinds: '["semantic"]',
      body,
      scope: "reality_user",
      scopeKey: key,
      status,
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  h.orm
    .insert(schema.qqMemorySources)
    .values({
      memoryId: id,
      eventKey: id,
      scopeKey: key,
      conversationKey: qqConversationKey({ accountId: "10001", kind: "group", peerId }),
      messageId: id,
      occurredAtSeconds: now - 40,
      speakerKind: "member",
      speakerId: "20002",
    })
    .run();
  return { id, key };
}
const base = `/agents/${agentId}/memory`;

describe("unified memory scopes and recall", () => {
  it("labels real five-part scope keys and refuses foreign or malformed keys", () => {
    expect(memoryScopeIdentity(agentId, agentId)).toEqual({ kind: "web" });
    expect(
      memoryScopeIdentity(JSON.stringify(["qq", "10001", "group", "30003", agentId]), agentId),
    ).toEqual({ kind: "qq", accountId: "10001", conversationKind: "group", peerId: "30003" });
    expect(memoryScopeIdentity('["qq","10001","group","30003"]', agentId).kind).toBe("legacy");
    expect(memoryScopeIdentity('["qq","10001","group","30003","other"]', agentId).kind).toBe(
      "legacy",
    );
  });
  it("lists partitions including inactive history and reports real job scope without changing grants", async () => {
    const h = setup();
    try {
      const own = seed(h, "30003", "apples");
      const other = seed(h, "40004", "pears");
      const job = enqueueQqMemoryNow(h.orm, {
        scope: qqConversationScope(h.binding),
        requestKey: "scope_job",
      });
      const scopes = MemoryScopeViewSchema.array().parse(
        await (await h.app.request(`${base}/scopes`)).json(),
      );
      expect(scopes.find((s) => s.scope_key === agentId)?.read_scope_keys).toBeNull();
      expect(scopes.find((s) => s.scope_key === own.key)).toMatchObject({
        count: 1,
        active_count: 1,
        pending: 0,
        read_scope_keys: [own.key],
        write_scope_key: own.key,
        latest_job: { id: job?.id, status: "queued" },
      });
      expect(scopes.find((s) => s.scope_key === other.key)).toMatchObject({
        count: 1,
        binding: null,
        read_scope_keys: [],
      });
    } finally {
      h.close();
    }
  });
  it("filters before pagination and never crosses the selected assistant", async () => {
    const h = setup();
    try {
      const own = seed(h, "30003", "apple one");
      seed(h, "30003", "apple two", "suppressed");
      seed(h, "40004", "apple elsewhere");
      const query = new URLSearchParams({
        scope_key: own.key,
        search: "apple",
        status: "active",
        limit: "1",
      });
      expect(await (await h.app.request(`${base}/entries?${query}`)).json()).toMatchObject({
        total: 1,
        items: [{ id: own.id }],
      });
      expect(await (await h.app.request(`${base}/entries?scope_key=foreign`)).json()).toEqual({
        total: 0,
        items: [],
      });
      expect((await h.app.request(`${base}/entries?status=unknown`)).status).toBe(422);
    } finally {
      h.close();
    }
  });
  it("preserves QQ scope when merging and refuses cross-partition merges from the management API", async () => {
    const h = setup();
    try {
      const a = seed(h, "30003", "a");
      const b = seed(h, "30003", "b");
      const other = seed(h, "40004", "other");
      const response = await h.app.request(`${base}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_key: "cross", memory_ids: [a.id, other.id] }),
      });
      expect(response.status).toBe(409);
      const job = enqueue(h.orm, agentId, "same", { kind: "merge", memoryIds: [a.id, b.id] });
      expect(JSON.parse(job.configSnapshot).scope_key).toBe(a.key);
    } finally {
      h.close();
    }
  });
  // 用户 2026-09-25 明确：回复侧的记忆**始终受读取强度影响**（关闭/保守/标准/宽泛/全目录/全部正文）。
  // 这一组是那个口径的证据：模式决定"要不要问记忆读取模型、最多给多少"，资格仍然只有一处来源
  // （绑定的读范围）。
  it.each(["conservative", "standard", "broad", "full_catalog", "full_body", "off"] as const)(
    "uses the scheme's %s retrieval mode within the QQ grant",
    async (mode) => {
      const h = setup();
      try {
        const own = seed(h, "30003", "own apples");
        seed(h, "40004", "private pears");
        h.runtime.p5_config.retrieval_mode = mode;
        const calls: string[] = [];
        const result = await recallQqReplyMemory(
          h.orm,
          {
            loadedContextCapacity: async () => 65536,
            complete: async (input) => {
              calls.push(JSON.stringify(input));
              return JSON.stringify({ ids: [own.id] });
            },
          },
          { runtime: h.runtime, snapshot: h.snapshot, question: "apples", available: 20000 },
        );
        expect(JSON.stringify(calls)).not.toContain("private pears");
        expect(JSON.stringify(result.material)).not.toContain("private pears");
        if (mode === "off") expect(result.material).toEqual([]);
        else expect(JSON.stringify(result.material)).toContain("own apples");
        // 关闭与"全部正文"不叫记忆读取模型；其余档位（含全目录）都要它挑一次。
        expect(calls.length > 0).toBe(mode !== "off" && mode !== "full_body");
      } finally {
        h.close();
      }
    },
  );
  it("fails closed for foreign selected IDs, a budget overrun and authority changes", async () => {
    const h = setup();
    try {
      const own = seed(h, "30003", "own apples");
      const other = seed(h, "40004", "private pears");
      h.runtime.p5_config.retrieval_mode = "standard";
      const args = {
        runtime: h.runtime,
        snapshot: h.snapshot,
        question: "apples",
        available: 20000,
      };
      const gateway = {
        loadedContextCapacity: async () => 65536,
        complete: async () => JSON.stringify({ ids: [other.id] }),
      };
      // 模型挑了不属于本会话的条目：整体拒绝，不"少给一条"。
      await expect(recallQqReplyMemory(h.orm, gateway, args)).rejects.toThrow();
      gateway.complete = async () => JSON.stringify({ ids: [own.id] });
      // 预算不够就拒绝（不静默截断，也不假装成功）。
      await expect(
        recallQqReplyMemory(h.orm, gateway, { ...args, available: 1 }),
      ).rejects.toThrow();
      gateway.complete = async () => {
        h.orm
          .update(schema.qqBindings)
          .set({ paused: 1, revision: 2 })
          .where(eq(schema.qqBindings.id, h.binding.id))
          .run();
        return JSON.stringify({ ids: [own.id] });
      };
      // 读取期间授权变了：这一份记忆作废。
      await expect(recallQqReplyMemory(h.orm, gateway, args)).rejects.toThrow();
    } finally {
      h.close();
    }
  });
  it("carries a read-scope fingerprint that a governance change invalidates", async () => {
    const h = setup();
    try {
      const own = seed(h, "30003", "own apples");
      h.runtime.p5_config.retrieval_mode = "standard";
      const material = await recallQqReplyMemory(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async () => JSON.stringify({ ids: [own.id] }),
        },
        { runtime: h.runtime, snapshot: h.snapshot, question: "apples", available: 20000 },
      );
      const read = material.read;
      if (read === undefined) throw new Error("expected a read snapshot");
      expect(qqMemoryReadIsCurrent(h.orm, agentId, read)).toBe(true);
      govern(h.orm, agentId, [own.id], "suppress");
      expect(qqMemoryReadIsCurrent(h.orm, agentId, read)).toBe(false);
    } finally {
      h.close();
    }
  });
  it("injects memory into a real QQ reply as user data and rechecks governance before send", async () => {
    const h = setup();
    try {
      const own = seed(h, "30003", "own apples");
      h.runtime.p5_config.retrieval_mode = "standard";
      h.orm
        .update(schema.agents)
        .set({ p5Config: JSON.stringify(h.runtime.p5_config) })
        .where(eq(schema.agents.id, agentId))
        .run();
      const prepared = prepareQqJudgement(h.orm, {
        bindingId: h.binding.id,
        path: "direct_reply",
        nowSeconds: now,
      });
      if (prepared.kind !== "prepared") throw new Error(prepared.reason);
      const openings = qqImmediateOpenings(prepared);
      const calls: Parameters<Parameters<typeof generateQqTextReply>[1]["complete"]>[0][] = [];
      const result = await generateQqTextReply(
        h.orm,
        {
          loadedContextCapacity: async () => 65536,
          complete: async (input) => {
            calls.push(input);
            return input.responseSchema ? JSON.stringify({ ids: [own.id] }) : "apples answer";
          },
        },
        { kind: "candidate", prepared, openings },
        openings[0],
        now,
      );
      expect(result.kind).toBe("draft");
      const last = calls.at(-1);
      if (!last) throw new Error("no reply call");
      expect(
        last.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n"),
      ).toContain("own apples");
      expect(
        last.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n"),
      ).not.toContain("own apples");
      if (result.kind !== "draft") return;
      govern(h.orm, agentId, [own.id], "suppress");
      expect(
        checkQqTextPreflight(h.orm, pendingQqReview(result), {
          counts: ["confirmed"],
          isAvailable: () => false,
        }),
      ).toEqual({ kind: "blocked", reason: "memory_changed" });
    } finally {
      h.close();
    }
  });
});
