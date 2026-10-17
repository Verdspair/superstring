import { afterEach, expect, it, spyOn } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { textMessage } from "../../src/server/agent/context-engine";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { QqTaskScheduler } from "../../src/server/conversation/qq-task-scheduler";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { createQqConversationTask } from "../../src/server/db/qq-task-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { AppError } from "../../src/server/errors";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import {
  QqTaskExecutionSnapshotSchema,
  qqConversationTaskKey,
} from "../../src/shared/contracts/qq-task";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function business() {
  const h = openBusinessDb();
  handles.push(h);
  return h;
}
const spec: AgentSpec = {
  id: "failure-propagation",
  instructions: "fixture",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
};

it.each([
  ["CONTEXT_SOURCE_INVALID", "CONTEXT_SOURCE_INVALID", "CONTEXT_SOURCE_INVALID"],
  ["CONTEXT_SOURCE_INVALID", "MODEL_ERROR", "AGENT_OUTPUT_FAILED"],
  ["MODEL_ERROR", "MODEL_ERROR", "AGENT_OUTPUT_FAILED"],
  ["private body source-id", "private body source-id", "AGENT_OUTPUT_FAILED"],
])("aggregates only consistent declared failure codes (%s / %s)", async (left, right, expected) => {
  const h = business();
  const repository = new AgentRunRepository(h.db);
  const runtime = new AgentRuntime({
    repository,
    model: {
      complete: async () =>
        JSON.stringify({
          kind: "final",
          outputs: ["alice", "bob"].map((targetId) => ({
            kind: "inline",
            targetId,
            text: "synthetic",
            stickerIds: [],
          })),
        }),
      async *streamText() {
        yield "unused";
      },
      completeMultimodal: async () => "unused",
    },
  });
  let runId = "";
  let commits = 0;
  const run = runtime.run(spec, {
    owner: { kind: "test_job", id: "fixture", agentId: "agent" },
    authorizedTargets: ["alice", "bob"],
    outputMode: "buffered",
    context: { read: async () => ({ pending: [textMessage("user", "synthetic")] }) },
    onEvent: (event) => {
      if (event.type === "started") runId = event.runId;
    },
    commitOutput: async (output, outputRunId) => {
      runId = outputRunId;
      commits++;
      throw Object.assign(new Error("private message must not be persisted"), {
        code: output.targetId === "alice" ? left : right,
      });
    },
  });
  await expect(run).rejects.toMatchObject({ code: expected });
  if (expected === "CONTEXT_SOURCE_INVALID") await expect(run).rejects.toBeInstanceOf(AppError);
  expect(commits).toBe(2);
  expect(runId).not.toBe("");
  const storedRuns = h.db.query("SELECT run_id FROM agent_runs WHERE spec_id=?").all(spec.id) as {
    run_id: string;
  }[];
  expect(storedRuns).toHaveLength(1);
  expect(storedRuns[0]!.run_id).toBe(runId);
  const failedRun = repository.getRun(storedRuns[0]!.run_id);
  expect(failedRun).not.toBeNull();
  expect(failedRun).toMatchObject({ status: "failed", errorCode: expected });
});

it.each(["prepare", "generation", "mixed"])(
  "keeps generic outer failure for %s errors even with approved source code",
  async (stage) => {
    const h = business();
    const repository = new AgentRunRepository(h.db);
    const failure = () => new AppError("CONTEXT_SOURCE_INVALID", "synthetic failure");
    const runtime = new AgentRuntime({
      repository,
      model: {
        complete: async () =>
          JSON.stringify({
            kind: "final",
            outputs: ["alice", "bob"].map((targetId) => ({
              kind: stage === "generation" ? "generate" : "inline",
              targetId,
              ...(stage === "generation"
                ? { instructions: "respond" }
                : { text: "synthetic", stickerIds: [] }),
            })),
          }),
        async *streamText() {
          yield "";
          throw failure();
        },
        completeMultimodal: async () => {
          throw failure();
        },
      },
    });
    let runId = "";
    let commits = 0;
    const run = runtime.run(spec, {
      owner: { kind: "test_job", id: "fixture", agentId: "agent" },
      authorizedTargets: ["alice", "bob"],
      outputMode: "buffered",
      context: { read: async () => ({ pending: [textMessage("user", "synthetic")] }) },
      onEvent: (event) => {
        if (event.type === "started") runId = event.runId;
      },
      prepareOutput: async (draft) => {
        if (stage === "prepare" || (stage === "mixed" && draft.targetId === "bob")) throw failure();
        return { outputId: `synthetic-${draft.targetId}` };
      },
      commitOutput: async () => {
        commits++;
        throw failure();
      },
    });
    await expect(run).rejects.toMatchObject({ code: "AGENT_OUTPUT_FAILED" });
    expect(commits).toBe(stage === "mixed" ? 1 : 0);
    expect(repository.getRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "AGENT_OUTPUT_FAILED",
    });
  },
);

it.each([false, true])(
  "keeps healthy early output with failed sibling; silent=%s",
  async (silent) => {
    const h = business();
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(h.db),
      model: {
        complete: async () =>
          JSON.stringify({
            kind: "final",
            outputs: ["alice", "bob"].map((targetId) => ({
              kind: "inline",
              targetId,
              text: "synthetic",
              stickerIds: [],
            })),
          }),
        async *streamText() {
          yield "unused";
        },
        completeMultimodal: async () => "unused",
      },
    });
    const commits: string[] = [];
    const result = await runtime.run(spec, {
      owner: { kind: "test_job", id: "fixture", agentId: "agent" },
      authorizedTargets: ["alice", "bob"],
      outputMode: "buffered",
      context: { read: async () => ({ pending: [textMessage("user", "synthetic")] }) },
      silentBlockCodes: ["AGENT_EARLY_COMMIT_REJECTED"],
      commitOutput: async (output) => {
        commits.push(output.targetId);
        if (output.targetId === "alice") return true;
        if (silent) return false;
        throw new AppError("CONTEXT_SOURCE_INVALID", "synthetic guard failure");
      },
    });
    expect(result.status).toBe("completed");
    expect(commits).toEqual(["alice", "bob"]);
    expect(result.outputs).toMatchObject([
      { targetId: "alice", status: "prepared" },
      { targetId: "bob", status: silent ? "blocked" : "failed" },
    ]);
  },
);

it.each(["CONTEXT_SOURCE_INVALID", "MEDIA_READ_FAILED"])(
  "preserves host guard %s through the initiative parent with zero outbox",
  async (code) => {
    const h = business();
    ensureDefaults(h.orm, "fixture");
    updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const scheme = createQqScheme(h.orm, {
      name: "fixture",
      reply: { split_by_speaker: true },
      triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
      rhythm: {
        ...QQ_RHYTHM_DEFAULT,
        initiative_batch_target_count: 1,
        initiative_batch_jitter_count: 0,
        initiative_time_window_enabled: false,
        merge_window_seconds: 0,
      },
    });
    const bindingId = "11111111-1111-4111-8111-111111111111";
    const seconds = 2_000_000_000;
    const now = () => new Date(seconds * 1000).toISOString();
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
      )
      .run(bindingId, DEFAULT_AGENT_ID, scheme.id, now(), now());
    const journal = new ConversationEventRepository(h.db);
    const wakes = new WakeRepository(h.db);
    const outbox = new OutboundIntentRepository(h.db);
    const repository = new AgentRunRepository(h.db);
    let generated = false;
    let guardFailures = 0;
    const original = BotContextSource.prototype.assertCurrent;
    const failure =
      code === "CONTEXT_SOURCE_INVALID"
        ? new AppError("CONTEXT_SOURCE_INVALID", "synthetic changed source")
        : Object.assign(new Error("synthetic media failure"), { code });
    const guard = spyOn(BotContextSource.prototype, "assertCurrent").mockImplementation(function (
      this: BotContextSource,
    ) {
      if (generated && guardFailures === 0) {
        guardFailures++;
        throw failure;
      }
      return original.call(this);
    });
    const runtime = new AgentRuntime({
      repository,
      now,
      model: {
        complete: async (request) =>
          request.responseSchema?.properties !== null &&
          typeof request.responseSchema?.properties === "object" &&
          "evaluations" in request.responseSchema.properties
            ? JSON.stringify({
                evaluations: [{ targetId: "20002", score: 9, intent: "respond", sourceSeqs: [] }],
              })
            : JSON.stringify({
                kind: "invoke",
                calls: [
                  {
                    name: "reply.text",
                    arguments: {
                      outputs: [{ kind: "generate", targetId: "20002", instructions: "respond" }],
                    },
                  },
                ],
              }),
        async *streamText() {
          yield "synthetic answer";
          generated = true;
        },
        completeMultimodal: async () => "unused",
      },
    });
    const conversationHost = new ConversationHost({ runtime });
    const activate = conversationHost.activate.bind(conversationHost);
    if (code === "MEDIA_READ_FAILED")
      spyOn(conversationHost, "activate").mockImplementation((input) =>
        activate({
          ...input,
          beforeFinal: async () => {
            throw failure;
          },
        }),
      );
    const host = new OneBotHost({
      orm: h.orm,
      journal,
      wakes,
      outbox,
      agentRuntime: runtime,
      host: conversationHost,
      gateway: { complete: async () => "unused", loadedContextCapacity: async () => 65536 },
      stickers: { counts: ["confirmed"], isAvailable: () => false },
      policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600 }),
      now,
    });
    const adapter = new OneBot11Adapter({ orm: h.orm, journal, wakes, nowSeconds: () => seconds });
    try {
      recordInbound(
        h.orm,
        normalizeOneBotMessage(
          {
            post_type: "message",
            message_type: "group",
            sub_type: "normal",
            time: seconds,
            self_id: 10001,
            user_id: 20002,
            group_id: 30003,
            message_id: "1",
            message: [{ type: "text", data: { text: "synthetic" } }],
          },
          "10001",
        ),
        { accountId: "10001", conversationIngress: adapter },
      );
      const wake = wakes.claim({ at: now(), leaseMs: 120000, cause: "chiming_in" });
      expect(wake).not.toBeNull();
      const activation = host.activate(wake!, new AbortController().signal);
      await expect(activation).rejects.toMatchObject({ code });
      if (code === "CONTEXT_SOURCE_INVALID") {
        await expect(activation).rejects.toBeInstanceOf(AppError);
        const task = createQqConversationTask(
          h.orm,
          {
            taskKey: qqConversationTaskKey.ordinary({
              conversationId: wake!.conversationId,
              bindingEpoch: journal.get(wake!.conversationId)!.bindingEpoch,
              agentId: DEFAULT_AGENT_ID,
              wakeId: wake!.id,
            }),
            conversationId: wake!.conversationId,
            bindingEpoch: journal.get(wake!.conversationId)!.bindingEpoch,
            agentId: DEFAULT_AGENT_ID,
            taskClass: "ordinary",
            cause: "chiming_in",
            sourceFromSeq: wakes.getSourceFromSeq(wake!.id) ?? wake!.throughSeq,
            sourceThroughSeq: wake!.throughSeq,
            originWakeId: wake!.id,
            wakeLeaseToken: wake!.leaseToken!,
            at: now(),
          },
          { validateSource: () => "valid" },
        ).task;
        const binding = h.db
          .query("SELECT revision,authority_revision FROM qq_bindings WHERE id=?")
          .get(bindingId) as { revision: number; authority_revision: number };
        const agent = h.db
          .query("SELECT config_version FROM agents WHERE id=?")
          .get(DEFAULT_AGENT_ID) as { config_version: number };
        const scheduler = new QqTaskScheduler({
          orm: h.orm,
          now,
          policy: () => ({ leaseMs: 60000, renewMs: 20000 }),
          limitsFor: () => ({ mentionTaskLimit: 4, ordinaryTaskLimit: 1 }),
          sourceState: () => "valid",
          freezeAtClaim: (_transaction, claimed) =>
            QqTaskExecutionSnapshotSchema.parse({
              accountId: "10001",
              conversationId: claimed.conversationId,
              bindingId,
              bindingEpoch: claimed.bindingEpoch,
              agentId: DEFAULT_AGENT_ID,
              schemeId: scheme.id,
              bindingRevision: binding.revision,
              authorityRevision: binding.authority_revision,
              schemeRevision: scheme.revision,
              agentConfigVersion: agent.config_version,
              taskClass: claimed.taskClass,
              cause: claimed.cause,
              sourceFromSeq: claimed.sourceFromSeq,
              sourceThroughSeq: claimed.sourceThroughSeq,
              sourceExpiresAt: claimed.sourceExpiresAt,
              authorizedTargets: ["20002"],
              targetParticipants: [{ targetId: "20002", speakerId: "20002" }],
              maxSteps: 20,
              deliveryTtlSeconds: 600,
              mentionTaskLimit: 4,
              ordinaryTaskLimit: 1,
              taskKey: claimed.taskKey,
            }),
          activate: async () => {
            throw await activation.catch((error: unknown) => error);
          },
          resolveExistingRunAndOutbox: () => "failed",
        });
        try {
          expect(await scheduler.runOnce()).toBe(true);
          await scheduler.waitForIdle();
          expect(
            h.db
              .query("SELECT status,error_code FROM qq_conversation_tasks WHERE id=?")
              .get(task.id),
          ).toEqual({ status: "failed", error_code: "CONTEXT_SOURCE_INVALID" });
        } finally {
          scheduler.stop();
          await scheduler.waitForIdle();
        }
      }
      expect(guardFailures).toBe(code === "CONTEXT_SOURCE_INVALID" ? 1 : 0);
      expect(outbox.list({})).toEqual([]);
      expect(
        h.db.query("SELECT error_code FROM agent_runs WHERE status='failed' ORDER BY rowid").all(),
      ).toEqual([{ error_code: code }, { error_code: code }]);
    } finally {
      guard.mockRestore();
    }
  },
);
