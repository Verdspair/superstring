import { describe, expect, it } from "bun:test";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import { cloneBusinessDb } from "../harness/business-db";

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
    const h = cloneBusinessDb();
    try {
      ensureDefaults(h.orm, "guard-model");
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
      const source = Object.create(BotContextSource.prototype);
      Object.assign(source, {
        options: { db: h.db, orm: h.orm, assertCurrent: () => {}, now: () => at },
        modelBudgets: new Map(),
        observations: [],
        guard: { assertSources: () => {} },
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
      source.options.guard = source.guard;
      expect(() => source.assertCurrent()).not.toThrow();
      runs.redactContext({ runId: "shared-run", stepId: "shared-step" }, "revoked");
      expect(() => source.assertCurrent()).toThrow("已共享回复意图的受保护来源已失效");
    } finally {
      h.close();
    }
  });
});
