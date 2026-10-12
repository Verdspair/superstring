import { expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

const ACCOUNT_ID = "10001";

const isDecisionRequest = (request: ModelRequest) => {
  const schema = request.responseSchema as { oneOf?: unknown } | undefined;
  return Array.isArray(schema?.oneOf);
};

const activationCause = (request: ModelRequest): string | null => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const entry = JSON.parse(part.text) as { kind?: string; value?: { cause?: string } };
        if (entry.kind === "activation_trigger") return entry.value?.cause ?? null;
      } catch {}
    }
  }
  return null;
};

const authorizedTarget = (request: ModelRequest): string => {
  const match = JSON.stringify(request.messages).match(/"authorizedTargets"\s*:\s*\[\s*"(\d+)/);
  return match?.[1] ?? "20002";
};

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_FOR_OLD_GENERATION_GATE");
    await Bun.sleep(5);
  }
};

it("confirmed newer direct reply suppresses a gated older ordinary autonomy commit", async () => {
  const h: BusinessDbHandle = cloneBusinessDb();
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "late-coverage-synthetic",
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    reply: { split_by_speaker: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
    },
  });
  const bindingId = crypto.randomUUID();
  const now = () => new Date().toISOString();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(bindingId, DEFAULT_AGENT_ID, scheme.id, now(), now());
  const journal = new ConversationEventRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  let oldSourceSeq = 0;
  let oldGenerationReached: () => void = () => {};
  let releaseOldGeneration: () => void = () => {};
  const oldGenerationGate = new Promise<void>((resolve) => {
    releaseOldGeneration = resolve;
  });
  const phases: string[] = [];
  const model: ModelPort = {
    async complete(request) {
      const schema = request.responseSchema as
        | { properties?: Record<string, { type?: string }> }
        | undefined;
      if (schema?.properties?.evaluations?.type === "array") {
        phases.push("initiative-score");
        const payload = request.messages
          .flatMap((message) => message.content)
          .flatMap((part) => {
            if (part.kind !== "text") return [];
            try {
              const parsed = JSON.parse(part.text) as {
                kind?: string;
                sourceSeqs?: number[];
                targets?: { targetId: string }[];
              };
              return parsed.kind === "qq_batch_targets" ? [parsed] : [];
            } catch {
              return [];
            }
          })
          .find((entry) => entry.targets?.some((target) => target.targetId === "20002"));
        if (!payload) throw new Error("SCORE_TARGET_MISSING");
        return JSON.stringify({
          evaluations: [
            {
              targetId: "20002",
              score: 9,
              intent: "answer ordinary input",
              sourceSeqs: payload.sourceSeqs ?? [oldSourceSeq],
            },
          ],
        });
      }
      if (!isDecisionRequest(request)) return "{}";
      const cause = activationCause(request);
      if (cause === "direct_reply") {
        phases.push("direct-decision");
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "inline", targetId: authorizedTarget(request), text: "new direct reply" },
          ],
        });
      }
      phases.push("older-ordinary-decision");
      return JSON.stringify({
        kind: "final",
        outputs: [
          {
            kind: "generate",
            targetId: authorizedTarget(request),
            instructions: "answer older ordinary input",
          },
        ],
      });
    },
    async *streamText() {
      phases.push("older-ordinary-generation-gated");
      oldGenerationReached();
      await oldGenerationGate;
      phases.push("older-ordinary-generation-released");
      yield "stale ordinary autonomy reply";
    },
    async completeMultimodal() {
      return "";
    },
  };
  const runtime = new AgentRuntime({ repository: runs, model, now });
  const gateway = {
    async complete() {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    async loadedContextCapacity() {
      return 65536;
    },
  };
  const sends: { peerId: string; request: unknown }[] = [];
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway,
    agentRuntime: runtime,
    host: new ConversationHost({ runtime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-late-coverage-stickers" }),
    port: {
      async send(request) {
        sends.push({ peerId: request.peerId, request });
        return { kind: "confirmed", messageId: String(20000 + sends.length) };
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
      modelCallConcurrency: 1,
    }),
  });
  const receive = (messageId: string, text: string, addressed: boolean) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: Math.floor(Date.now() / 1000),
        self_id: Number(ACCOUNT_ID),
        user_id: 20002,
        group_id: 30003,
        message_id: messageId,
        message: [
          ...(addressed ? [{ type: "at", data: { qq: ACCOUNT_ID } }] : []),
          { type: "text", data: { text } },
        ],
        sender: { nickname: "20002" },
      },
      ACCOUNT_ID,
    );
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: bot.adapter,
    });
  };

  try {
    expect(receive("30001", "older ordinary input", false).kind).toBe("recorded");
    const conversation = journal.ensureOneBot(bindingId)!;
    oldSourceSeq = journal
      .eventsAfter(conversation.id, 0, 20)
      .items.find((event) => event.kind === "inbound")!.seq;
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => phases.includes("older-ordinary-generation-gated"));
    expect(phases).toEqual([
      "initiative-score",
      "older-ordinary-decision",
      "older-ordinary-generation-gated",
    ]);
    const oldTask = h.db
      .query("SELECT status,source_through_seq FROM qq_conversation_tasks WHERE cause='chiming_in'")
      .get() as { status: string; source_through_seq: number } | null;
    expect(oldTask).toMatchObject({ status: "running", source_through_seq: oldSourceSeq });

    expect(receive("30002", "new direct input", true).kind).toBe("recorded");
    const directSourceSeq = journal
      .eventsAfter(conversation.id, oldSourceSeq, 20)
      .items.find((event) => event.kind === "inbound")!.seq;
    const directTask = h.db
      .query(
        "SELECT status,source_through_seq FROM qq_conversation_tasks WHERE cause='direct_reply'",
      )
      .get() as { status: string; source_through_seq: number } | null;
    expect(directTask).toMatchObject({ status: "pending", source_through_seq: directSourceSeq });

    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(
      () =>
        (
          h.db
            .query("SELECT status FROM qq_conversation_tasks WHERE cause='direct_reply'")
            .get() as { status: string } | null
        )?.status === "completed",
    );
    const directIntent = h.db
      .query(
        "SELECT speech_kind,status,source_through_seq FROM outbound_intents WHERE speech_kind='direct_reply'",
      )
      .get() as { speech_kind: string; status: string; source_through_seq: number } | null;
    expect(directIntent).toEqual({
      speech_kind: "direct_reply",
      status: "confirmed",
      source_through_seq: directSourceSeq,
    });
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0]?.request)).toContain("new direct reply");

    releaseOldGeneration();
    await bot.scheduler.waitForIdle();
    const oldTaskAfterCoverage = h.db
      .query("SELECT status,error_code FROM qq_conversation_tasks WHERE cause='chiming_in'")
      .get() as { status: string; error_code: string | null } | null;
    expect(oldTaskAfterCoverage).toMatchObject({ status: "cancelled", error_code: null });
    const intents = h.db
      .query("SELECT speech_kind,status,source_through_seq FROM outbound_intents ORDER BY rowid")
      .all();
    expect(intents).toEqual([
      { speech_kind: "direct_reply", status: "confirmed", source_through_seq: directSourceSeq },
    ]);
    expect(sends).toHaveLength(1);
    expect(phases).toContain("older-ordinary-generation-released");
  } finally {
    releaseOldGeneration();
    bot.scheduler.stop();
    await bot.scheduler.waitForIdle();
    bot.delivery.stop();
    await bot.delivery.waitForIdle();
    bot.release();
    h.close();
  }
});
