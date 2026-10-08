import { afterEach, expect, it } from "bun:test";
import { AgentRuntime, type ConversationInput } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { ModelPort } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { SPEECH_REPLY_DESCRIPTION } from "../../src/shared/contracts/agent-action-descriptions";
import { SpeechReplyArgumentsSchema } from "../../src/shared/contracts/agent-output";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const owner = { kind: "test_job", id: "qq-reply", userId: "u", agentId: "a" };
const spec: AgentSpec = {
  id: "main",
  model: "chat",
  instructions: "Reply to the conversation.",
  context: "conversation",
  availableActions: [],
  limits: { steps: 4 },
};

function createRuntime(model: Partial<ModelPort>) {
  const handle = openBusinessDb();
  handles.push(handle);
  const repository = new AgentRunRepository(handle.db);
  const port: ModelPort = {
    async complete() {
      return '{"kind":"none"}';
    },
    async *streamText() {
      yield "generated answer";
    },
    async completeMultimodal() {
      return "unused";
    },
    ...model,
  };
  return { runtime: new AgentRuntime({ model: port, repository }), repository };
}

const direct: Pick<ConversationInput, "owner" | "authorizedTargets" | "outputMode" | "context"> = {
  owner,
  authorizedTargets: ["qq-group"],
  outputMode: "buffered",
  context: {
    async read() {
      return { pending: [] };
    },
  },
};

const terminalAction = {
  name: "speech.reply",
  description: SPEECH_REPLY_DESCRIPTION,
  parse: (arguments_: Record<string, unknown>) =>
    SpeechReplyArgumentsSchema.parse(arguments_).outputs,
};

it("preserves an independently selected reply reference through terminal inline output", async () => {
  const draft = {
    kind: "inline",
    targetId: "qq-group",
    text: "Quoted response",
    replyToMessageId: "-1001234567890",
    mentionIds: ["10001"],
  };
  const committed: unknown[] = [];
  const { runtime } = createRuntime({
    async complete() {
      return JSON.stringify({
        kind: "invoke",
        name: "speech.reply",
        arguments: { outputs: [draft] },
      });
    },
  });
  const result = await runtime.run(spec, {
    ...direct,
    terminalAction,
    async commitOutput(output) {
      committed.push(output);
    },
  });
  expect(result.status).toBe("completed");
  const expected = {
    targetId: "qq-group",
    status: "prepared",
    text: "Quoted response",
    replyToMessageId: "-1001234567890",
    mentionIds: ["10001"],
  };
  expect(result.outputs[0]).toMatchObject(expected);
  expect(committed[0]).toMatchObject(expected);
});

it("preserves mention-only inline output without deriving a quote or target mention", async () => {
  const draft = {
    kind: "inline",
    targetId: "qq-group",
    text: "",
    mentionIds: ["10003"],
  };
  const { runtime } = createRuntime({
    async complete() {
      return JSON.stringify({
        kind: "invoke",
        name: "speech.reply",
        arguments: { outputs: [draft] },
      });
    },
  });
  const result = await runtime.run(spec, { ...direct, terminalAction });
  expect(result.outputs[0]).toMatchObject({
    text: "",
    mentionIds: ["10003"],
  });
  expect(result.outputs[0]).not.toHaveProperty("replyToMessageId");
});

it("preserves the reply reference on the early-commit path", async () => {
  const earlyCommitted: unknown[] = [];
  const { runtime } = createRuntime({
    async complete() {
      return JSON.stringify({
        kind: "final",
        outputs: [
          {
            kind: "generate",
            targetId: "qq-group",
            instructions: "Answer the quoted message.",
            replyToMessageId: "-1001234567892",
          },
        ],
      });
    },
  });
  const result = await runtime.run(spec, {
    ...direct,
    async commitOutput(output) {
      earlyCommitted.push(output);
      return true;
    },
  });
  expect(earlyCommitted[0]).toMatchObject({
    text: "generated answer",
    replyToMessageId: "-1001234567892",
  });
  expect(result.outputs[0]).toMatchObject({ replyToMessageId: "-1001234567892" });
});

it("preserves the reply reference through generated output, reconsideration, and commit", async () => {
  const draft = {
    kind: "generate",
    targetId: "qq-group",
    instructions: "Answer the quoted message.",
    replyToMessageId: "-1001234567891",
    mentionIds: ["10002"],
  };
  const preparedDrafts: unknown[] = [];
  const reconsidered: unknown[] = [];
  const committed: unknown[] = [];
  const { runtime } = createRuntime({
    async complete() {
      return JSON.stringify({ kind: "final", outputs: [draft] });
    },
  });
  const result = await runtime.run(spec, {
    ...direct,
    async prepareOutput(value) {
      preparedDrafts.push(value);
      return { outputId: "prepared-qq-reply" };
    },
    async reconsider(outputs) {
      reconsidered.push(...outputs);
      return false;
    },
    async commitOutputs(outputs) {
      committed.push(...outputs);
    },
  });
  expect(result.status).toBe("completed");
  expect(preparedDrafts[0]).toMatchObject({
    replyToMessageId: "-1001234567891",
    mentionIds: ["10002"],
  });
  expect(reconsidered[0]).toMatchObject({
    replyToMessageId: "-1001234567891",
    mentionIds: ["10002"],
  });
  expect(committed[0]).toMatchObject({
    text: "generated answer",
    replyToMessageId: "-1001234567891",
    mentionIds: ["10002"],
  });
  expect(result.outputs[0]).toMatchObject({ replyToMessageId: "-1001234567891" });
});
