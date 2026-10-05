import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { mapBotHostDiagnosticTelemetry } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";
import {
  type RuntimeSpan,
  RuntimeSpansPageSchema,
} from "../../src/shared/contracts/runtime-observability";

/**
 * T14 观测面：media_mode 诊断经**生产映射**落 span 后，只能由**授权的 runs/observability
 * HTTP 接口**读回。本文件不装配宿主主链：诊断事件按宿主 emitMediaMode 的既有 scalar 形状
 * 合成（无 bytes/base64/URL/路径/正文），再交给 create-runtime 的真实 mapper 与
 * RuntimeTelemetry 的公开写入方法，因此断言的是产品真实字段，而不是仓储页的假象。
 */

const SECOND_AGENT_ID = "00000000-0000-0000-0000-000000000002";
const MODEL_NAME = "fixture-chat-model";

type BusinessDb = ReturnType<typeof openBusinessDb>;
const handles: BusinessDb[] = [];
const telemetries: RuntimeTelemetry[] = [];
afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.close();
  for (const handle of handles.splice(0)) handle.close();
});

/** 与 host emitMediaMode 同形的 details：无二进制、无 URL、无路径、无正文。 */
interface MediaModeDetails extends Record<string, string | number | boolean | null> {
  phase: string;
  requestedMode: string;
  actualMode: string;
  why: string | null;
  requestedModel: string;
  resolvedModel: string | null;
  imageCount: number;
  omissionCount: number;
}

function mediaModeDetails(input: {
  phase: "decision" | "evaluation" | "generation";
  requestedMode: "native" | "description";
  actualMode: string;
  why?: string | null;
  omissions?: readonly { mediaId: string; reason: string }[];
}): MediaModeDetails {
  const omissions = input.omissions ?? [];
  const details: MediaModeDetails = {
    phase: input.phase,
    requestedMode: input.requestedMode,
    actualMode: input.actualMode,
    why: input.why ?? null,
    requestedModel: MODEL_NAME,
    // 宿主当前恒为 null：resolved 不可得时不用 requested 顶替（现实现字段事实）。
    resolvedModel: null,
    imageCount: 0,
    omissionCount: omissions.length,
  };
  for (const [index, omission] of omissions.entries()) {
    details[`omission:${index}`] = JSON.stringify({
      mediaId: omission.mediaId,
      reason: omission.reason,
    });
  }
  return details;
}

function insertAgent(business: BusinessDb, id: string, at: string): void {
  business.orm
    .insert(schema.agents)
    .values({
      id,
      name: id === DEFAULT_AGENT_ID ? "本地助手" : "synthetic second assistant",
      systemPrompt: "synthetic",
      description: "",
      additionalInstructions: "",
      p5Config: "{}",
      modelName: MODEL_NAME,
      temperature: 0.7,
      memoryConsolidationModelName: null,
      memoryConsolidationPrompt: "synthetic",
      memoryConsolidationAdditionalInstructions: "",
      memoryRetrievalModelName: null,
      memoryRetrievalPrompt: "synthetic",
      contextCompressionModelName: null,
      personaIntensity: 60,
      isActive: 1,
      configVersion: 1,
      updatedAt: at,
      createdAt: at,
    })
    .run();
}

/** 一个私聊绑定 + 其真实 journal 会话（可见性判定的两个真源都由它提供）。 */
function oneBotConversation(
  business: BusinessDb,
  input: {
    id: string;
    peerId: string;
    agentId: string;
    schemeId: string;
    at: string;
  },
): { bindingId: string; conversationId: string } {
  business.orm
    .insert(schema.qqBindings)
    .values({
      id: input.id,
      accountId: "10001",
      conversationKind: "private",
      peerId: input.peerId,
      agentId: input.agentId,
      schemeId: input.schemeId,
      createdAt: input.at,
      updatedAt: input.at,
    })
    .run();
  const conversation = new ConversationEventRepository(business.db).ensureOneBot(input.id);
  if (!conversation) throw new Error("MISSING_QQ_CONVERSATION_FIXTURE");
  return { bindingId: input.id, conversationId: conversation.id };
}

function setup() {
  const business = openBusinessDb();
  handles.push(business);
  ensureDefaults(business.orm, MODEL_NAME);
  const at = new Date().toISOString();
  const scheme = createQqScheme(business.orm, { name: "media-telemetry-runs-api" });
  insertAgent(business, SECOND_AGENT_ID, at);
  const own = oneBotConversation(business, {
    id: "binding-own",
    peerId: "20001",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    at,
  });
  const other = oneBotConversation(business, {
    id: "binding-other",
    peerId: "20002",
    agentId: SECOND_AGENT_ID,
    schemeId: scheme.id,
    at,
  });
  const runs = new AgentRunRepository(business.db);
  const telemetry = new RuntimeTelemetry(business.db);
  telemetries.push(telemetry);
  // 真实装配：与生产 app 同一份 /v2/runs 与 /v2/observability 路由。
  const app = createApp({ business });
  /** 真实 run + 真实 step（run API 读回的就是这条记录）。 */
  const runFor = (conversationId: string, agentId: string): RunSnapshot => {
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    runs.createRun({
      runId,
      specId: "onebot.main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversationId, userId: DEFAULT_USER_ID, agentId },
      at,
    });
    runs.startStep({
      runId,
      stepId,
      stepNo: 1,
      model: MODEL_NAME,
      phase: "leaf",
      at,
      messages: [{ role: "user", content: [{ kind: "text", text: "synthetic" }] }],
      sources: [],
    });
    return runs.getRun(runId) as RunSnapshot;
  };
  /** 宿主诊断 → 生产 mapper → RuntimeTelemetry.record（与 create-runtime 的装配逐字同形）。 */
  const recordMediaMode = (input: {
    conversationId: string;
    runId: string;
    sourceSeq: number;
    details: MediaModeDetails;
    code?: string;
  }): void => {
    const mapped = mapBotHostDiagnosticTelemetry({
      conversationId: input.conversationId,
      runId: input.runId,
      sourceSeq: input.sourceSeq,
      stage: "media_mode",
      status: "observed",
      ...(input.code ? { code: input.code } : {}),
      details: input.details,
    });
    telemetry.record(mapped.name, mapped.metadata);
  };
  const spansOf = async (runId: string): Promise<RuntimeSpan[]> => {
    const response = await app.request(`/v2/observability/spans?runId=${runId}&limit=200`);
    expect(response.status).toBe(200);
    return RuntimeSpansPageSchema.parse(await response.json()).items;
  };
  return { business, app, runs, telemetry, own, other, runFor, recordMediaMode, spansOf };
}

describe("media_mode telemetry is readable only through authorized runs HTTP APIs", () => {
  it("reads back a native media_mode diagnostic for the owning run, conversation and step", async () => {
    const { app, own, runFor, recordMediaMode, spansOf, business } = setup();
    const run = runFor(own.conversationId, DEFAULT_AGENT_ID);
    recordMediaMode({
      conversationId: own.conversationId,
      runId: run.runId,
      sourceSeq: 3,
      details: mediaModeDetails({
        phase: "generation",
        requestedMode: "native",
        actualMode: "native",
        omissions: [{ mediaId: "media-a", reason: "not_selected" }],
      }),
    });

    const spans = await spansOf(run.runId);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span).toMatchObject({
      name: "bot.host.feedback",
      channel: "onebot11",
      stage: "context",
      status: "observed",
      code: "BOT_FEEDBACK",
      runId: run.runId,
      conversationId: own.conversationId,
      sourceSeq: 3,
    });
    // 模型标识来自宿主 details；span 的 model 列在现实现里是 null，不用它冒充 provider 模型。
    expect(span.model).toBeNull();
    expect(span.details).toMatchObject({
      phase: "generation",
      requestedMode: "native",
      actualMode: "native",
      why: null,
      requestedModel: MODEL_NAME,
      resolvedModel: null,
      imageCount: 0,
      omissionCount: 1,
      feedbackStatus: "observed",
      "omission:0": JSON.stringify({ mediaId: "media-a", reason: "not_selected" }),
    });

    // 同一个 run 经授权的 runs 路由读回：owner/step 是真实行，不是测试拼的期望对象。
    const detail = await app.request(`/v2/runs/${run.runId}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as RunSnapshot;
    expect(body.owner).toEqual({
      kind: "conversation",
      id: own.conversationId,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    });
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]!.context).toEqual({ runId: run.runId, stepId: body.steps[0]!.stepId });
    // run 快照不携带诊断细节；细节只出现在观测面。
    expect(JSON.stringify(body)).not.toContain("omission:0");

    // 授权列表按 owner 归属过滤，只回本会话自己的 run。
    const list = await app.request(`/v2/runs?ownerKind=conversation&ownerId=${own.conversationId}`);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const listed = (await list.json()) as { runs: RunSnapshot[] };
    expect(listed.runs.map((item) => item.runId)).toContain(run.runId);
    expect(listed.runs.every((item) => item.owner.id === own.conversationId)).toBe(true);
    // 事件接口对同一条 run 正常；该路由与诊断细节无关，不伪造事件。
    expect((await app.request(`/v2/runs/${run.runId}/events`)).status).toBe(200);
    expect(
      business.db.query("SELECT COUNT(*) AS n FROM runtime_spans WHERE run_id=?").get(run.runId),
    ).toEqual({ n: 1 });
  });

  it("reads back the description fallback with its real why, code and actual mode", async () => {
    const { own, runFor, recordMediaMode, spansOf } = setup();
    const run = runFor(own.conversationId, DEFAULT_AGENT_ID);
    recordMediaMode({
      conversationId: own.conversationId,
      runId: run.runId,
      sourceSeq: 7,
      code: "MODEL_IMAGE_UNSUPPORTED",
      details: mediaModeDetails({
        phase: "decision",
        requestedMode: "native",
        actualMode: "description",
        why: "model_image_unsupported",
      }),
    });
    const spans = await spansOf(run.runId);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "bot.host.feedback",
      stage: "context",
      status: "observed",
      code: "MODEL_IMAGE_UNSUPPORTED",
    });
    expect(spans[0]!.details).toMatchObject({
      phase: "decision",
      requestedMode: "native",
      actualMode: "description",
      why: "model_image_unsupported",
      requestedModel: MODEL_NAME,
      resolvedModel: null,
      omissionCount: 0,
    });
  });

  it("scopes read-back to the run's own owner and refuses a run that claims another conversation's assistant", async () => {
    const { app, own, other, runFor, recordMediaMode, spansOf, business } = setup();
    const ownRun = runFor(own.conversationId, DEFAULT_AGENT_ID);
    const otherRun = runFor(other.conversationId, SECOND_AGENT_ID);
    recordMediaMode({
      conversationId: other.conversationId,
      runId: otherRun.runId,
      sourceSeq: 1,
      details: mediaModeDetails({
        phase: "evaluation",
        requestedMode: "native",
        actualMode: "native",
      }),
    });
    // 本机单用户部署：会话归属是第一层边界，不是用户角色。本地 principal 对自己的
    // 另一条会话照常可读——不伪造多用户体系，也不把这条当成越权。
    expect((await app.request(`/v2/runs/${otherRun.runId}`)).status).toBe(200);
    expect(await spansOf(otherRun.runId)).toHaveLength(1);
    expect(await spansOf(ownRun.runId)).toHaveLength(0);

    // 真正的强负：run 自称归属某会话、却借用另一任助手的 agentId → 不可读（404）。
    const misclaimed = runFor(other.conversationId, DEFAULT_AGENT_ID);
    expect(
      business.db.query("SELECT agent_id FROM agent_runs WHERE run_id=?").get(misclaimed.runId),
    ).toEqual({ agent_id: DEFAULT_AGENT_ID });
    const denied = await app.request(`/v2/runs/${misclaimed.runId}`);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({
      error: { code: "RUN_NOT_FOUND", message: "运行不存在或不可访问" },
    });
    expect(
      (
        await app.request(
          `/v2/runs/${misclaimed.runId}/context/${misclaimed.steps[0]?.stepId ?? "0"}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request(`/v2/runs?ownerKind=conversation&ownerId=${own.conversationId}`)).status,
    ).toBe(200);
    // 会话列表按 owner 归属过滤：A 会话的 run 不出现在 B 会话的列表请求里。
    const listed = (await (
      await app.request(`/v2/runs?ownerKind=conversation&ownerId=${own.conversationId}`)
    ).json()) as { runs: RunSnapshot[] };
    expect(listed.runs.map((item) => item.runId)).toContain(ownRun.runId);
    expect(listed.runs.map((item) => item.runId)).not.toContain(otherRun.runId);
    // 缺参数仍是 422，不是空列表。
    expect((await app.request("/v2/runs?ownerKind=conversation")).status).toBe(422);
  });

  it("publishes no bytes, base64, URL or path in any media_mode read-back", async () => {
    const { app, own, runFor, recordMediaMode, spansOf } = setup();
    const run = runFor(own.conversationId, DEFAULT_AGENT_ID);
    recordMediaMode({
      conversationId: own.conversationId,
      runId: run.runId,
      sourceSeq: 11,
      details: mediaModeDetails({
        phase: "generation",
        requestedMode: "description",
        actualMode: "description",
        omissions: [
          { mediaId: "media-a", reason: "not_selected" },
          { mediaId: "media-b", reason: "unreadable" },
        ],
      }),
    });
    const spans = await spansOf(run.runId);
    const text = JSON.stringify(await (await app.request(`/v2/runs/${run.runId}`)).json());
    const detailText = JSON.stringify(spans);
    for (const body of [detailText, text]) {
      expect(body).not.toContain("base64");
      expect(body).not.toContain("data:image");
      expect(body).not.toContain("http://");
      expect(body).not.toContain("https://");
      // 文件系统风格的反斜杠路径不出现；JSON 自身的转义反斜杠不算（下一行按解码值断言）。
      expect(body).not.toMatch(/[A-Za-z]:\\\\|\\\\Users|\\\\home/);
    }
    // omissions 逐条按固定形状落 span，不拼接成自由文本。
    const keys = Object.keys(spans[0]!.details).filter((key) => key.startsWith("omission:"));
    expect(keys).toEqual(["omission:0", "omission:1"]);
    for (const key of keys) {
      expect(Object.keys(JSON.parse(String(spans[0]!.details[key])))).toEqual([
        "mediaId",
        "reason",
      ]);
    }
  });

  it("requires the observability filter to stay real: unknown stage and malformed ids are rejected", async () => {
    const { app, own, runFor, recordMediaMode, spansOf } = setup();
    const run = runFor(own.conversationId, DEFAULT_AGENT_ID);
    recordMediaMode({
      conversationId: own.conversationId,
      runId: run.runId,
      sourceSeq: 1,
      details: mediaModeDetails({
        phase: "decision",
        requestedMode: "native",
        actualMode: "native",
      }),
    });
    expect(
      (await app.request(`/v2/observability/spans?stage=media_mode&runId=${run.runId}`)).status,
    ).toBe(422);
    expect((await app.request("/v2/observability/spans?runId=not-a-uuid")).status).toBe(422);
    // stage=context 是 media_mode 的真实落桶（现映射事实），不是测试自选标签。
    expect(await spansOf(run.runId)).toHaveLength(1);
  });
});
