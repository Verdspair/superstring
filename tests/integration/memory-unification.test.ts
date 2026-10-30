import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { enqueue } from "../../src/server/db/memory-repository";
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
import { enqueueQqMemoryNow } from "../../src/server/services/qq-memory-enqueue";
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
    triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: true },
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
  if (peerId === h.binding.peerId) {
    const journal = new ConversationEventRepository(h.db);
    journal.ensureOneBot(h.binding.id);
    journal.ingestOneBotEvent(id, h.binding.id);
  }
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
        read_scope_keys: null,
        write_scope_key: own.key,
        latest_job: { id: job?.id, status: "queued" },
      });
      expect(scopes.find((s) => s.scope_key === other.key)).toMatchObject({
        count: 1,
        binding: null,
        read_scope_keys: null,
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
});
