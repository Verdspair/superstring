import { describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT as fixtureLegacyContext } from "../../src/server/services/qq-context-contract";
import { QQ_RHYTHM_DEFAULT as fixtureLegacyRhythm } from "../../src/server/services/qq-rhythm-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { QQ_ALLOCATION_DEFAULT as fixtureLegacyAllocation } from "../../src/shared/contracts/context-allocation";
import * as fixtureLegacyQq from "../../src/shared/contracts/qq";
import { cloneBusinessDb, runtimeFixtureBusiness } from "../harness/business-db";

function fixture() {
  const h = runtimeFixtureBusiness(cloneBusinessDb(), "reply-model");
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    context: { ...fixtureLegacyContext },
    rhythm: { ...fixtureLegacyRhythm },
    compression: { ...fixtureLegacyQq.QQ_COMPRESSION_DEFAULT },
    outputReserve: { ...fixtureLegacyQq.QQ_MODEL_OUTPUT_RESERVE_DEFAULT },
    allocation: structuredClone(fixtureLegacyAllocation),
    stickers: { ...fixtureLegacyQq.QQ_STICKER_DEDUP_DEFAULT },
    mediaInput: structuredClone(fixtureLegacyQq.QQ_MEDIA_INPUT_SCHEME_DEFAULT),
    name: "fit-invalidation",
  });
  const c = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (c.kind !== "saved") throw Error("binding");
  const binding = insertQqBinding(h.orm, c.binding);
  const task = captureQqTask(binding, "reply");
  if (task.kind !== "captured") throw Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "off";
  runtime.p5_config.compression_enabled = false;
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw Error("conversation");
  const gateway = { loadedContextCapacity: async () => 12288, complete: async () => "unused" };
  const spec = {
    id: "fit-invalidation",
    model: "reply-model",
    context: "conversation" as const,
    instructions: "fixture",
    availableActions: [],
    limits: { steps: 12 },
  };
  const source = new BotContextSource({
    ...h,
    gateway,
    agentRuntime: createAgentRuntime({ gateway, repository: new AgentRunRepository(h.db) }),
    journal,
    outbox,
    conversationId: conversation.id,
    binding,
    snapshot: task.snapshot,
    scheme,
    runtime,
    spec,
    path: "direct_reply",
    decisionTier: "reply",
    targets: () => [{ id: "member", speakerId: "20002" }],
    assertCurrent() {},
  });
  return { h, source };
}

describe("captured action-result pricing survives material invalidation", () => {
  it("never accepts an oversized result after the media completion invalidates cached material", async () => {
    const { h, source } = fixture();
    try {
      await source.read({ signal: new AbortController().signal, observations: [] });
      const accept = await source.actionResultFitter(
        "media.describe",
        { id: "synthetic" },
        new AbortController().signal,
        true,
      );
      const oversized = { status: "described", text: "x".repeat(100000) };
      expect(accept(oversized, [])).toBe(false);
      source.invalidate();
      expect(accept(oversized, [])).toBe(false);
    } finally {
      h.close();
    }
  });
  it("keeps accepted sibling reservations when only material caches are invalidated", async () => {
    const { h, source } = fixture();
    try {
      const signal = new AbortController().signal;
      await source.read({ signal, observations: [] });
      const first = await source.actionResultFitter("media.describe", { id: "first" }, signal);
      const second = await source.actionResultFitter("media.describe", { id: "second" }, signal);
      let lower = 0,
        upper = 20000;
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        if (first({ text: "x".repeat(middle) }, [])) lower = middle;
        else upper = middle - 1;
      }
      expect(lower).toBeGreaterThan(0);
      const accepted = { text: "x".repeat(lower) };
      expect(first(accepted, [])).toBe(true);
      expect(second(accepted, [])).toBe(false);
      source.invalidate();
      expect(second(accepted, [])).toBe(false);
    } finally {
      h.close();
    }
  });
});
