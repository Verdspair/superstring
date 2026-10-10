import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";
import type { RuntimeSpan, RuntimeTrace } from "../../src/shared/contracts/runtime-observability";
import { i18n } from "../../src/web/i18n/runtime";
import { EvidenceWorkbench } from "../../src/web/screens/observability/EvidenceWorkbench";
import { ModelCallsTable } from "../../src/web/screens/observability/ModelCallsTable";
import { taskName, traceCause, traceTask } from "../../src/web/screens/observability/presentation";
import { TraceTimeline } from "../../src/web/screens/observability/TraceTimeline";
import { RunWorkspace } from "../../src/web/screens/runs/RunEntry";

const t = (key: string) => i18n.t(key);

const makeSpan = (patch: Partial<RuntimeSpan> = {}): RuntimeSpan => ({
  id: 1,
  traceId: "t1".padEnd(32, "0"),
  spanId: "s1",
  parentSpanId: null,
  name: "agent.run",
  at: "2026-10-10T00:00:00Z",
  finishedAt: "2026-10-10T00:00:01Z",
  durationMs: 1000,
  channel: "onebot11",
  stage: "run",
  status: "completed",
  code: "OK",
  model: "gemini",
  conversationId: "c1",
  agentId: "a1",
  runId: "r1",
  wakeId: "w1",
  outputId: null,
  sourceSeq: 1,
  details: {},
  ...patch,
});

const makeTrace = (patch: Partial<RuntimeTrace> = {}): RuntimeTrace => ({
  traceId: "t1".padEnd(32, "0"),
  cursorId: 1,
  root: makeSpan(),
  at: "2026-10-10T00:00:00Z",
  lastActivityAt: "2026-10-10T00:00:01Z",
  finishedAt: "2026-10-10T00:00:01Z",
  durationMs: 1000,
  status: "completed",
  spanCount: 1,
  matchedSpanCount: 1,
  models: ["gemini"],
  channels: ["onebot11"],
  runIds: ["r1"],
  wakeIds: ["w1"],
  causes: [],
  specIds: [],
  ...patch,
});

afterEach(() => {
  cleanup();
  i18n.changeLanguage("zh-CN");
});

describe("runtime task names presentation", () => {
  it("labels a QQ initiative batch trace by its root spec as QQ主动发言", () => {
    i18n.changeLanguage("zh-CN");
    const trace = makeTrace({
      root: makeSpan({ details: { specId: "onebot.initiative.batch" } }),
      specIds: ["onebot.initiative.batch", "onebot.initiative.evaluate_batch", "onebot.main"],
    });
    expect(traceTask(trace, t)).toBe("QQ主动发言");
  });

  it("labels a QQ context compression trace as QQ历史消息摘要", () => {
    i18n.changeLanguage("zh-CN");
    const trace = makeTrace({
      root: makeSpan({ details: { specId: "context.compress.events" } }),
      specIds: ["context.compress.events"],
    });
    expect(traceTask(trace, t)).toBe("QQ历史消息摘要");
  });

  it("shows QQ历史消息摘要 in the model calls table for compression calls", () => {
    i18n.changeLanguage("zh-CN");
    render(
      <ModelCallsTable
        items={[
          makeSpan({
            stage: "model",
            name: "agent.model",
            details: { specId: "context.compress.events", phase: "leaf" },
          }),
        ]}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("QQ历史消息摘要")).toBeTruthy();
  });

  it("keeps background and trigger cause labels", () => {
    i18n.changeLanguage("zh-CN");
    const background = makeTrace({
      root: makeSpan({ details: { specId: "context.compress.events" } }),
      specIds: ["context.compress.events"],
    });
    expect(traceCause(background, t)).toBe("后台历史摘要");

    const chiming = makeTrace({
      root: makeSpan({ details: { specId: "onebot.main" } }),
      specIds: ["onebot.main"],
      causes: ["chiming_in"],
    });
    expect(traceCause(chiming, t)).toBe("自主接话");
  });

  it("renders friendly task title in TraceTimeline node and aria label for agent.run steps", () => {
    i18n.changeLanguage("zh-CN");
    const span = makeSpan({
      name: "agent.run",
      stage: "run",
      details: { specId: "onebot.initiative.evaluate_batch" },
    });
    const trace = makeTrace({ root: span, specIds: ["onebot.initiative.evaluate_batch"] });
    render(
      <TraceTimeline
        data={{
          now: "2026-10-10T00:00:01Z",
          trace,
          items: [span],
          matchedSpanIds: [span.spanId],
        }}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("判断是否主动发言")).toBeTruthy();
  });

  it("renders friendly spanTitle in EvidenceWorkbench header", () => {
    i18n.changeLanguage("zh-CN");
    const span = makeSpan({
      name: "agent.run",
      stage: "run",
      details: { specId: "context.compress.events" },
    });
    render(<EvidenceWorkbench item={span} />);
    expect(screen.getByRole("heading", { level: 3, name: "QQ历史消息摘要" })).toBeTruthy();
  });

  it("renders friendly task name and preserves raw specId in RunEntry", () => {
    i18n.changeLanguage("zh-CN");
    const snapshot: RunSnapshot = {
      runId: "run-test-1",
      specId: "context.compress.events",
      specVersion: "1",
      owner: { kind: "memory_job", id: "job-1" },
      status: "completed",
      errorCode: null,
      lastSeq: 1,
      startedAt: "2026-10-10T00:00:00.000Z",
      endedAt: "2026-10-10T00:00:01.000Z",
      steps: [],
      outputs: [],
    };
    render(<RunWorkspace runId="run-test-1" initialSnapshot={snapshot} />);
    expect(screen.getByRole("heading", { level: 3, name: "QQ历史消息摘要" })).toBeTruthy();
    expect(screen.getByText("context.compress.events")).toBeTruthy();
  });

  it("resolves English translations without untranslated keys", () => {
    i18n.changeLanguage("en");
    expect(taskName("context.compress.events", t)).toBe("QQ message summary");
    expect(taskName("onebot.initiative.batch", t)).toBe("QQ proactive speech");
    expect(taskName("onebot.main.research", t)).toBe("Research subtask");
    expect(taskName("memory.suppression", t)).toBe("Check if memory is suppressed");
    i18n.changeLanguage("zh-CN");
  });

  it("preserves legacy keys accurately", () => {
    i18n.changeLanguage("zh-CN");
    expect(taskName("web.main", t)).toBe("网页主 Agent");
    expect(taskName("onebot.initiative.evaluate", t)).toBe("主动发言判断");
    expect(taskName("knowledge.select", t)).toBe("知识筛选");
  });

  it("safely handles unknown and prototype properties without collision", () => {
    expect(taskName("toString", t)).toBe("toString");
    expect(taskName("unknown_custom_spec", t)).toBe("unknown_custom_spec");
  });

  it("resolves traceTask accurately for generic multi-tasks vs non-generic ingress", () => {
    i18n.changeLanguage("zh-CN");
    const multiGeneric = makeTrace({
      root: makeSpan({ name: "agent.run", details: {} }),
      specIds: ["memory.select", "knowledge.organize"],
    });
    expect(traceTask(multiGeneric, t)).toBe("多任务运行");

    const multiIngress = makeTrace({
      root: makeSpan({ name: "bot.ingress", details: {} }),
      specIds: ["onebot.initiative.batch", "onebot.main"],
    });
    expect(traceTask(multiIngress, t)).toBe("消息接入");
  });

  it("handles traceCause with idle topic and mixed tasks safely", () => {
    i18n.changeLanguage("zh-CN");
    const idleTrace = makeTrace({
      root: makeSpan({ details: { specId: "onebot.initiative.batch" } }),
      specIds: ["onebot.initiative.batch"],
      causes: ["idle_topic"],
    });
    expect(traceCause(idleTrace, t)).toBe("冷场发起");

    const mixedTraceWithoutRootSpec = makeTrace({
      root: makeSpan({ details: {} }),
      specIds: ["context.compress.events", "memory.select"],
      causes: [],
    });
    expect(traceCause(mixedTraceWithoutRootSpec, t)).toBe("");
  });

  it("translates memory suppression as checking for suppressed candidate facts", () => {
    i18n.changeLanguage("zh-CN");
    expect(taskName("memory.suppression", t)).toBe("检查记忆是否被屏蔽");
  });
});
