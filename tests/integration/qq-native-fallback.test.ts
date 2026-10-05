// T11 §9 fallback 强测试（独立新文件）：真实 MODEL_IMAGE_UNSUPPORTED → describeAfterUnsupported
// description 备用 + 媒体观测面（bot.host.feedback span details）真持久读回；非 unsupported 故障
// 绝不降级（整轮既有失败/重试语义）。全部走现有 OneBot harness 生产链；vision 桩只替换视觉模型
// 本身，描述任务/缓存/来源复验/字节 identity 走真实代码。

import { expect, it } from "bun:test";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import type { BotHostDiagnostic } from "../../src/server/channels/onebot11/bot-host";
import { mapBotHostDiagnosticTelemetry } from "../../src/server/channels/onebot11/create-runtime";
import { ModelUnavailableError } from "../../src/server/errors";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

const png = () => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);

interface SpanRow {
  name: string;
  details: string | null;
}

const mediaModeSpans = (h: OneBotHarness): Record<string, unknown>[] =>
  (
    h.db
      .query("SELECT name,details FROM runtime_spans WHERE name='bot.host.feedback' ORDER BY id")
      .all() as SpanRow[]
  )
    .map((row) => JSON.parse(row.details ?? "{}") as Record<string, unknown>)
    .filter((details) => typeof details.phase === "string");

const hasImagePart = (request: ModelRequest): boolean =>
  request.messages.some((message) => message.content.some((part) => part.kind === "image"));

type SchemaKind = "score" | "decision-envelope" | "decision" | "text-envelope" | "other";

const classifySchema = (request: ModelRequest): SchemaKind => {
  const schema = (request.responseSchema ?? {}) as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  if (props.score !== undefined && schema.oneOf === undefined) return "score";
  if (props.scoreResult !== undefined) return "score";
  if (schema.oneOf !== undefined) {
    // QQ 决策 envelope（QQ_DECISION_ENVELOPE_SCHEMA）把 media 加进 oneOf 每个分支的
    // properties，不在顶层 props；按分支 properties 并集判断，plain 决策照回 plain。
    const branches = schema.oneOf as Record<string, unknown>[];
    const mediaInBranches = branches.some(
      (branch) =>
        ((branch.properties as Record<string, unknown> | undefined) ?? {}).media !== undefined,
    );
    return mediaInBranches ? "decision-envelope" : "decision";
  }
  if (props.text !== undefined && props.media !== undefined) return "text-envelope";
  return "other";
};

const decisionReply = (): string =>
  JSON.stringify({
    kind: "final",
    outputs: [{ kind: "generate", targetId: "10001", instructions: "reply" }],
  });

const fallbackHarness = (
  complete: (request: ModelRequest) => Promise<string>,
  onDiagnostic?: (event: BotHostDiagnostic) => void,
): { harness: OneBotHarness; descriptionReads: { count: number } } => {
  const descriptionReads = { count: 0 };
  const harness = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "focus-image": png() },
    judgementModelName: "judge-model",
    model: {
      complete,
      async *streamText() {
        yield "主动回复正文";
      },
      // description 备用的视觉读取走叶子 completeMultimodal（native 主链不经 visionCalls）。
      async completeMultimodal() {
        descriptionReads.count += 1;
        return "SECRET_NOTE 一只猫在晒太阳";
      },
    } as Partial<ModelPort>,
    onDiagnostic,
  });
  return { harness, descriptionReads };
};

it("real MODEL_IMAGE_UNSUPPORTED falls back to description once and the mode metadata is span-readable", async () => {
  let telemetry: RuntimeTelemetry | null = null;
  let scoreAttempts = 0;
  const { harness: h, descriptionReads } = fallbackHarness(
    async (request) => {
      const resolved = request.model ?? "judge-model";
      request.onModelResolved?.(resolved);
      request.assertPreparedCurrent?.({ model: resolved });
      const kind = classifySchema(request);
      if (kind === "score") {
        scoreAttempts += 1;
        if (scoreAttempts === 1) {
          // 第一次评分材料带原生图 part → 网关能力闸精确拒绝（零 HTTP）。
          expect(hasImagePart(request)).toBe(true);
          throw new ModelUnavailableError("MODEL_IMAGE_UNSUPPORTED", "不支持图片");
        }
        // fallback 后重建的评分材料：不再有任何 image part（description notes 取代）。
        expect(hasImagePart(request)).toBe(false);
        return JSON.stringify({ score: 6 });
      }
      // 决策调用：unknown 图在位时走 envelope schema（{decision, media}）；text-only 决策走
      // 原 schema；生成相 unknown 图走一次 {text, media} structured complete。各按本体契约返回。
      if (kind === "text-envelope") return JSON.stringify({ text: "主动回复正文", media: [] });
      if (kind === "decision-envelope" || kind === "decision") {
        return JSON.stringify({
          decision: {
            kind: "final",
            outputs: [{ kind: "generate", targetId: "10001", instructions: "reply" }],
          },
          media: [],
        });
      }
      return decisionReply();
    },
    (event) => {
      // 与 create-runtime 同一映射函数：诊断 → bot.host.feedback span（真持久，可读回）。
      if (!telemetry) return;
      const mapped = mapBotHostDiagnosticTelemetry(event);
      telemetry.record(mapped.name, mapped.metadata);
    },
  );
  try {
    telemetry = new RuntimeTelemetry(h.db);
    h.receive({
      id: "-1",
      speaker: "10001",
      text: "看图说话",
      image: "focus-image",
      groupCard: "阿林",
    });
    h.advance(31);
    await h.activate("chiming_in");
    await h.deliver();

    // description 备用恰好一次真实视觉读取（native 主链的描述走叶子 completeMultimodal）；
    // 评分恰两次（拒绝一次＋备用材料一次）；无额外分类模型 call；整轮完成并投递。
    expect(descriptionReads.count).toBe(1);
    expect(scoreAttempts).toBe(2);
    expect(h.sent).toHaveLength(1);

    // 观测面读回（runtime_spans 真持久行）：
    const modes = mediaModeSpans(h);
    const decision = modes.find((entry) => entry.phase === "decision");
    expect(decision).toBeDefined();
    expect(decision?.actualMode).toBe("native");
    expect(decision?.requestedMode).toBe("native");
    const fallbackEvent = modes.find(
      (entry) => entry.phase === "evaluation" && entry.why === "model_image_unsupported",
    );
    expect(fallbackEvent).toBeDefined();
    expect(fallbackEvent?.requestedMode).toBe("native");
    expect(fallbackEvent?.actualMode).toBe("description");
    // resolved 不可得＝null，不用 requested 顶替。
    expect(fallbackEvent?.resolvedModel).toBeNull();
    const resolvedFallback = modes.find(
      (entry) =>
        entry.phase === "evaluation" &&
        entry.why === "model_image_unsupported" &&
        entry.resolvedModel === "judge-model",
    );
    expect(resolvedFallback?.requestedModel).toBe("judge-model");
    expect(fallbackEvent?.omissionCount).toBe(0);
    expect(fallbackEvent?.imageCount).toBe(0);
  } finally {
    if (telemetry) await telemetry.close();
    closeHarnesses();
  }
});

it("a non-unsupported model failure never degrades to description", async () => {
  let diagnostics = 0;
  const { harness: h, descriptionReads } = fallbackHarness(
    async (request) => {
      const kind = classifySchema(request);
      if (kind === "score") {
        // 一般故障同样发生在带图评分材料上，但绝不触发 description 降级。
        expect(hasImagePart(request)).toBe(true);
        throw new ModelUnavailableError("MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用");
      }
      if (kind === "text-envelope") return JSON.stringify({ text: "主动回复正文", media: [] });
      if (kind === "decision-envelope" || kind === "decision") {
        return JSON.stringify({
          decision: {
            kind: "final",
            outputs: [{ kind: "generate", targetId: "10001", instructions: "reply" }],
          },
          media: [],
        });
      }
      return decisionReply();
    },
    () => {
      diagnostics += 1;
    },
  );
  try {
    h.receive({
      id: "-1",
      speaker: "10001",
      text: "看图说话",
      image: "focus-image",
      groupCard: "阿林",
    });
    h.advance(31);
    // 整轮失败沿既有语义如实报错，不静默降级、不吞错。
    await expect(h.activate("chiming_in")).rejects.toBeTruthy();
    // 非 unsupported 绝不发起 description 读取（no degrade）。
    expect(descriptionReads.count).toBe(0);
    const modes = mediaModeSpans(h).filter((entry) => entry.why === "model_image_unsupported");
    expect(modes).toHaveLength(0);
    expect(diagnostics).toBeGreaterThanOrEqual(0);
  } finally {
    closeHarnesses();
  }
});

it("decision-phase first HTTP unsupported rejects then description retry supplies the same phase once", async () => {
  let telemetry: RuntimeTelemetry | null = null;
  const decisionAttempts: { hasImage: boolean }[] = [];
  let resolvedDecisionModel = "";
  let scored = 0;
  const { harness: h, descriptionReads } = fallbackHarness(
    async (request) => {
      const resolved = request.model ?? "judge-model";
      request.onModelResolved?.(resolved);
      const kind = classifySchema(request);
      if (kind === "decision" || kind === "decision-envelope") resolvedDecisionModel = resolved;
      if (kind === "decision" || kind === "decision-envelope") {
        decisionAttempts.push({ hasImage: hasImagePart(request) });
        if (decisionAttempts.length === 1) {
          // 首次决策 HTTP 带原生图 → 服务精确拒绝（真实 unsupported，非 imagesAllowed 预声明）。
          expect(hasImagePart(request)).toBe(true);
          throw new ModelUnavailableError("MODEL_IMAGE_UNSUPPORTED", "不支持图片");
        }
        // 重备后重试：同相、无 image part。
        expect(hasImagePart(request)).toBe(false);
        if (kind === "decision-envelope") {
          return JSON.stringify({
            decision: {
              kind: "final",
              outputs: [{ kind: "generate", targetId: "10001", instructions: "reply" }],
            },
            media: [],
          });
        }
        return decisionReply();
      }
      if (kind === "score") {
        scored += 1;
        // 评分相在未知图在位时走 envelope（scoreResult）；描述重备后走 plain score schema。
        const raw = JSON.stringify(request.responseSchema ?? {});
        return raw.includes('"scoreResult"')
          ? JSON.stringify({ scoreResult: { score: 6 }, media: [] })
          : JSON.stringify({ score: 6 });
      }
      if (kind === "text-envelope") return JSON.stringify({ text: "主动回复正文", media: [] });
      return decisionReply();
    },
    (event) => {
      if (!telemetry) return;
      const mapped = mapBotHostDiagnosticTelemetry(event);
      telemetry.record(mapped.name, mapped.metadata);
    },
  );
  try {
    telemetry = new RuntimeTelemetry(h.db);
    h.receive({
      id: "-1",
      speaker: "10001",
      text: "看图说话",
      image: "focus-image",
      groupCard: "阿林",
    });
    h.advance(31);
    await h.activate("chiming_in");
    await h.deliver();

    expect(descriptionReads.count).toBe(1);
    expect(decisionAttempts).toHaveLength(2);
    expect(scored).toBeGreaterThanOrEqual(1);
    expect(h.sent).toHaveLength(1);
    const fallbackSpans = mediaModeSpans(h).filter(
      (entry) => entry.phase === "decision" && entry.why === "model_image_unsupported",
    );
    expect(fallbackSpans).toHaveLength(1);
    expect(fallbackSpans[0]?.resolvedModel).toBe(resolvedDecisionModel);
  } finally {
    if (telemetry) await telemetry.close();
    closeHarnesses();
  }
});

it("generation-phase first HTTP unsupported rejects then description retry supplies the same phase once", async () => {
  let telemetry: RuntimeTelemetry | null = null;
  const generateAttempts: { hasImage: boolean }[] = [];
  let resolvedGenerationModel = "";
  let decisionDone = false;
  const { harness: h, descriptionReads } = fallbackHarness(
    async (request) => {
      const resolved = request.model ?? "judge-model";
      request.onModelResolved?.(resolved);
      const kind = classifySchema(request);
      if (kind === "text-envelope") resolvedGenerationModel = resolved;
      if (kind === "text-envelope") {
        generateAttempts.push({ hasImage: hasImagePart(request) });
        if (generateAttempts.length === 1) {
          expect(hasImagePart(request)).toBe(true);
          throw new ModelUnavailableError("MODEL_IMAGE_UNSUPPORTED", "不支持图片");
        }
        expect(hasImagePart(request)).toBe(false);
        return JSON.stringify({ text: "主动回复正文", media: [] });
      }
      if (kind === "score") {
        // 未知图在位＝envelope schema；重备后＝plain score schema。
        const raw = JSON.stringify(request.responseSchema ?? {});
        return raw.includes('"scoreResult"')
          ? JSON.stringify({ scoreResult: { score: 6 }, media: [] })
          : JSON.stringify({ score: 6 });
      }
      decisionDone = true;
      return JSON.stringify({
        decision: {
          kind: "final",
          outputs: [{ kind: "generate", targetId: "10001", instructions: "reply" }],
        },
        media: [],
      });
    },
    (event) => {
      if (!telemetry) return;
      const mapped = mapBotHostDiagnosticTelemetry(event);
      telemetry.record(mapped.name, mapped.metadata);
    },
  );
  try {
    telemetry = new RuntimeTelemetry(h.db);
    h.receive({
      id: "-1",
      speaker: "10001",
      text: "看图说话",
      image: "focus-image",
      groupCard: "阿林",
    });
    h.advance(31);
    await h.activate("chiming_in");
    await h.deliver();

    expect(decisionDone).toBe(true);
    expect(descriptionReads.count).toBe(1);
    expect(generateAttempts).toHaveLength(2);
    expect(h.sent).toHaveLength(1);
    const fallbackSpans = mediaModeSpans(h).filter(
      (entry) => entry.phase === "generation" && entry.why === "model_image_unsupported",
    );
    expect(fallbackSpans).toHaveLength(1);
    expect(fallbackSpans[0]?.resolvedModel).toBe(resolvedGenerationModel);
  } finally {
    if (telemetry) await telemetry.close();
    closeHarnesses();
  }
});
