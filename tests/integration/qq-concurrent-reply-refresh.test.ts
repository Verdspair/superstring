import { describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { readQqScheme } from "../../src/server/db/qq-scheme-repository";
import { getAgentRow } from "../../src/server/db/repositories";
import { captureQqTask } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import { createOneBotHarness } from "../harness/onebot";

const message = (value: string): ModelMessage => ({
  role: "user",
  content: [{ kind: "text", text: value }],
});
function fixture(limit = 100) {
  const source = Object.create(BotContextSource.prototype);
  const original = message("same-state");
  const view = {
    selection: { messages: [] },
    material: { pending: [original] },
    concurrentMessage: original,
    limit,
  };
  let current = message("same-state");
  let fitChecks = 0;
  Object.assign(source, {
    views: new Map([["reply", view]]),
    assertCurrent() {},
    assertCurrentWithCandidate() {},
    relatedReplyDeliveries: () => ({ taskIds: [], revision: "fixture", omitted: 0 }),
    *readConcurrentJobsFactSteps() {
      yield;
      return undefined;
    },
    concurrentJobsMessage: () => ({ message: current, sources: [], contexts: [] }),
    fitsWithObservations: (_tier: string, material: typeof view.material, maximum: number) => {
      fitChecks++;
      return JSON.stringify(material).length <= maximum;
    },
  });
  return {
    source,
    view,
    set: (value: ModelMessage) => {
      current = value;
    },
    checks: () => fitChecks,
    prepare: () => source.concurrentProjection(view, undefined) as typeof view,
  };
}
describe("concurrent reply material projection preparation", () => {
  it("keeps unchanged message identity without fitting or mutating the published view", () => {
    const f = fixture(1000);
    const original = f.view.concurrentMessage;
    const first = f.prepare(),
      second = f.prepare();
    expect(first.concurrentMessage).toBe(original);
    expect(second.concurrentMessage).toBe(original);
    expect(first.material).toBe(f.view.material);
    expect(f.view.material.pending[0]).toBe(original);
    expect(f.checks()).toBe(0);
    f.set(message("changed-state"));
    const changed = f.prepare();
    expect(changed.material.pending).toHaveLength(1);
    expect(changed.material.pending[0]?.content[0]).toEqual({
      kind: "text",
      text: "changed-state",
    });
    expect(f.view.concurrentMessage).toBe(original);
    expect(f.view.material.pending[0]).toBe(original);
    expect(f.checks()).toBe(0);
  });
  it("prepares over-budget facts without publishing; fitting belongs to the view boundary", () => {
    const f = fixture(100);
    const original = f.view.material;
    f.set(message("larger-state-".repeat(100)));
    const candidate = f.prepare();
    expect(candidate.material.pending[0]?.content[0].kind).toBe("text");
    expect(candidate.material).not.toBe(original);
    expect(f.view.material).toBe(original);
    expect(f.checks()).toBe(0);
  });
});

describe("shared intent send-boundary currentness", () => {
  it("rejects a redacted protected intent before the next model boundary", () => {
    const h = createOneBotHarness();
    try {
      const at = new Date().toISOString();
      const runs = new AgentRunRepository(h.db);
      runs.createRun({
        runId: "shared-run",
        specId: "test",
        specVersion: "1",
        owner: { kind: "test", id: "test" },
        at,
      });
      runs.startStep({
        runId: "shared-run",
        stepId: "shared-step",
        stepNo: 1,
        model: "test",
        phase: "leaf",
        at,
        messages: [],
        sources: [],
      });
      runs.finishStep("shared-step", "completed", at, {
        output: { text: "declared", format: "text", complete: true },
      });
      const binding = readQqBinding(h.orm, h.bindingId);
      const scheme = readQqScheme(h.orm, h.scheme.id);
      if (!binding || !scheme) throw new Error("missing binding or scheme");
      const capture = captureQqTask(binding, "reply");
      if (capture.kind !== "captured") throw new Error("binding not captured");
      const agent = getAgentRow(h.orm, binding.agentId);
      if (!agent) throw new Error("missing agent");
      const source = new BotContextSource({
        db: h.db,
        orm: h.orm,
        gateway: { loadedContextCapacity: async () => 65536 },
        agentRuntime: new AgentRuntime({
          repository: runs,
          model: {
            complete: async () => "",
            async *streamText() {},
            completeMultimodal: async () => "",
          },
        }),
        journal: h.journal,
        outbox: h.outbox,
        conversationId: h.conversationId,
        binding,
        snapshot: capture.snapshot,
        scheme,
        runtime: runtimeFromAgent(agent),
        spec: {
          id: "test",
          model: "guard-model",
          context: "conversation",
          instructions: "",
          availableActions: [],
          limits: { steps: 1 },
        },
        path: "direct_reply",
        decisionTier: "reply",
        targets: () => [],
        assertCurrent: () => {},
        now: () => at,
      });
      Object.assign(source, {
        views: new Map([
          [
            "reply",
            {
              material: {},
              concurrentSources: [],
              concurrentContexts: [{ runId: "shared-run", stepId: "shared-step", expiresAt: null }],
            },
          ],
        ]),
      });
      // The real protected snapshot exists, so the first HTTP guard passes.
      expect(() => source.assertCurrent()).not.toThrow();
      runs.redactContext({ runId: "shared-run", stepId: "shared-step" }, "revoked");
      expect(() => source.assertCurrent()).toThrow("已共享回复意图的受保护来源已失效");
    } finally {
      h.close();
    }
  });
});
