// OneBot 夹具真实观测能力（容量 / 真实 span / 视觉叶子）最小接口测试。
//
// 本文件只钉 `tests/harness/onebot.ts` 这三个新挂点的**契约面**，不重复生产语义：
//   1) capacityGateway —— 真实容量 getter 注入，宿主与生产同一条 `loadedContextCapacity`；
//      不给＝维持既有行为（不发 HTTP）。
//   2) telemetry —— 同库同 `RuntimeTelemetry` + 生产 `mapBotHostDiagnosticTelemetry`，
//      宿主诊断与 AgentRuntime 的 span 落同一 `runtime_spans`，按 run/owner 读回。
//      默认关＝旧夹具零 span。
//   3) completeMultimodal 视觉叶子 —— native/description 的真实读取经
//      createQqMediaAdapter → completeVisionLeaf → 端口；用户自带端口优先。
//
// 全部走既有业务库与既有观测表：不新增 API、不新增权限、不手插 span、不碰真实模型服务
// 或外网（容量 getter 与视觉都是夹具注入的受控实现）。

import { afterEach, describe, expect, it } from "bun:test";
import type { ModelPort, MultimodalRequest } from "../../src/server/agent/model-port";
import { saveQqConversationSummary } from "../../src/server/db/qq-summary-repository";
import { DEFAULT_AGENT_ID, DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  batchScore,
  decideGenerate,
  decideInline,
  decideInvoke,
  decideNone,
  type ModelStep,
  say,
  scriptedModel,
} from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";
import { driveToolFirst } from "../harness/scenarios";

afterEach(closeHarnesses);

/**
 * 一个**不含** `completeMultimodal` 的端口：文字调用照常走脚本，视觉方法缺席，
 * 于是运行时那份默认视觉桩（`tests/harness/onebot.ts`）真正生效——这正是
 * 「默认桩的计数与 fail-closed」需要验的面。脚本端口自带 completeMultimodal，
 * 直接用脚本数组会把它顶掉、验不到默认桩。
 */
function portWithoutVision(steps: readonly ModelStep[]): Partial<ModelPort> {
  const scripted = scriptedModel(steps);
  return {
    complete: (request) => scripted.port.complete(request),
    streamText: (request) => scripted.port.streamText(request),
  };
}

/** 压缩叶子（`facts` 摘要 schema）的真实答复：按本批事件的真实 id 与说话人产出事实。 */
function compressAwarePort(steps: readonly ModelStep[]): Partial<ModelPort> {
  const scripted = scriptedModel(steps);
  const base = scripted.port;
  return {
    ...base,
    async complete(request) {
      const schema = JSON.stringify(request.responseSchema ?? {});
      if (!schema.includes('"facts"')) return base.complete(request);
      // 事件块是 contextDumps 的 JSON 串（键已排序）：按 JSON 解析取真实 id 与说话人，
      // 不用正则——事件 id 内含转义引号，正则会在中途截断。
      const block = request.messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          message.content.filter((part) => part.kind === "text").map((part) => part.text),
        )
        .join("");
      const events =
        (JSON.parse(block) as { events?: { id: string; speaker: string }[] }).events ?? [];
      // 说话人必须取自本 call 的真实枚举（生产按记录里的 speaker 收紧 schema），
      // 写死一个枚举值会在 speakers 不同的链路上被拒。
      const allowed =
        ((
          request.responseSchema as {
            $defs?: { SummaryFact?: { properties?: { speaker?: { enum?: string[] } } } };
          }
        ).$defs?.SummaryFact?.properties?.speaker?.enum ?? ["user", "assistant", "both"])[0] ??
        "user";
      return JSON.stringify({
        facts: events.map((event) => ({
          kind: "fact",
          speaker: allowed,
          text: `压缩事实${event.id.slice(0, 8)}`,
          source_ids: [event.id],
        })),
      });
    },
  };
}

const png = () => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);

interface SpanRow {
  name: string;
  runId: string | null;
  conversationId: string | null;
  status: string;
  code: string | null;
  details: Record<string, unknown>;
}

type RawSpanRow = Omit<SpanRow, "details"> & { details: string | null };

/** 读回既有 `runtime_spans` 表（无新 API、无手插 span）。 */
const spans = (h: OneBotHarness, name?: string): SpanRow[] =>
  (
    h.db
      .query(
        name === undefined
          ? "SELECT name,run_id AS runId,conversation_id AS conversationId,status,code,details FROM runtime_spans ORDER BY id"
          : `SELECT name,run_id AS runId,conversation_id AS conversationId,status,code,details FROM runtime_spans WHERE name='${name}' ORDER BY id`,
      )
      .all() as RawSpanRow[]
  ).map((row) => ({
    ...row,
    details: JSON.parse(row.details ?? "{}") as Record<string, unknown>,
  }));

describe("harness capacity getter", () => {
  it("uses the injected real capacity getter and keeps the old option when it is absent", async () => {
    const asked: string[] = [];
    const h = createOneBotHarness({
      capacityGateway: {
        async loadedContextCapacity(model: string) {
          asked.push(model);
          return 4096;
        },
      },
      // 一次真实装配（收到消息并激活）才会走到容量取值；空脚本步会在激活里失败，
      // 容量已在失败之前取过——用 catch 吸收，不把本用例变成轮次行为测试。
      model: [decideGenerate("20002", "回应", []), say("容量用例正文")],
    });
    h.receive({ id: "-1", speaker: "20002", addressed: true, text: "在吗" });
    await h.activate("direct_reply").catch(() => undefined);
    // 前置事实：容量真的取过（否则下面「拿到注入的容量」没有对照面）。
    expect(asked.length).toBeGreaterThan(0);
    // 被问的是会话模型名，不是夹具硬编码的字符串。
    expect(new Set(asked)).toEqual(new Set(["reply-model"]));
  });

  it("falls back to the legacy capacity number when no gateway is injected", async () => {
    const h = createOneBotHarness({ capacity: 8192, model: [decideNone()] });
    await h.activate("direct_reply").catch(() => undefined);
    expect(h.sent).toHaveLength(0);
  });
});

describe("harness real telemetry", () => {
  it("persists host diagnostics and agent spans through the production mapper", async () => {
    const seen: string[] = [];
    const h = createOneBotHarness({
      telemetry: true,
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaInput: { mode: "native" },
      imageBytes: { "obs-image": png() },
      vision: ["观测用合成描述"],
      onDiagnostic: (event) => {
        seen.push(`${event.stage}/${event.status}`);
      },
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: [
        batchScore([{ targetId: "10001", score: 6, intent: "回答图片问题", sourceSeqs: [] }]),
        decideGenerate("10001", "回答图片问题", []),
        say("观测回复正文"),
      ],
    });
    try {
      expect(h.telemetry).not.toBeNull();
      h.receive({
        id: "-1",
        speaker: "10001",
        text: "这张图里有什么",
        groupCard: "阿林",
        image: "obs-image",
      });
      h.advance(31);
      const result = await h.activate("chiming_in");
      await h.deliver();
      expect(result).toMatchObject({ status: "completed" });

      // 读回走同一业务库的既有观测表（无新 API、无手插 span）。
      const all = spans(h);
      const agentRun = all.find((row) => row.name === "agent.run");
      expect(agentRun).toBeDefined();
      // 强负：这不是「造一行 span」——是同一 runId 下的真实因果链，owner 归属同一合成身份。
      expect(agentRun?.conversationId).toBe(h.conversationId);
      expect(agentRun?.details).toMatchObject({
        ownerKind: "conversation",
        ownerId: h.conversationId,
      });
      expect(spans(h, "agent.run").filter((row) => row.runId === agentRun?.runId).length).toBe(1);

      const feedback = all.filter((row) => row.name === "bot.host.feedback");
      expect(feedback.length).toBeGreaterThan(0);
      // 生产 mapper 的固定形状：诊断字段原样进 details，附带 feedbackStatus。
      expect(feedback.some((row) => row.details.feedbackStatus !== undefined)).toBe(true);

      // 同一实例：辅助订阅者与落库链同时收到诊断（订阅者不代持久化）。
      expect(seen.length).toBe(feedback.length);
      // 强负：观测面不泄漏原始字节/正文/路径（details 只含 scalar 安全值）。
      const persisted = JSON.stringify(all);
      expect(persisted).not.toContain("base64");
      expect(persisted).not.toContain("观测用合成描述");
      // user 归属是既有合成身份，不新造 principal。
      const users = new Set(
        (
          h.db.query("SELECT DISTINCT user_id AS u FROM runtime_spans").all() as { u: string }[]
        ).map((row) => row.u),
      );
      expect([...users]).toEqual([DEFAULT_USER_ID]);
    } finally {
      closeHarnesses();
    }
  }, 60_000);

  it("writes zero spans when telemetry is not requested", async () => {
    const h = createOneBotHarness({ model: [decideNone()], vision: ["unused"] });
    await h.activate("direct_reply").catch(() => undefined);
    expect(h.telemetry).toBeNull();
    expect(spans(h)).toHaveLength(0);
  });
});

describe("harness vision leaf", () => {
  it("serves the native description through the real vision leaf and records the call", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaInput: { mode: "description" },
      imageBytes: { "leaf-image": png() },
      vision: ["视觉叶子合成描述"],
      // 视觉由夹具**默认桩**服务（端口刻意不含 completeMultimodal，见 portWithoutVision）。
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: portWithoutVision([
        batchScore([{ targetId: "10001", score: 6, intent: "回答图片问题", sourceSeqs: [] }]),
        decideGenerate("10001", "回答图片问题", []),
        say("描述链回复正文"),
      ]),
    });
    try {
      h.receive({ id: "-1", speaker: "10001", text: "看图", image: "leaf-image" });
      h.advance(31);
      await h.activate("chiming_in");
      await h.deliver();

      // 描述真的读出来了（不是空正文、不是编造的 unavailable）。
      const tasks = h.db.query("SELECT status,note FROM qq_media_read_tasks").all() as {
        status: string;
        note: string | null;
      }[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.status).toBe("succeeded");
      expect(tasks[0]?.note).toBe("视觉叶子合成描述");
      // 视觉叶子这一次真实调用记进同一个账（与显式 media adapter 共用），模型名与
      // 提示词取自真实叶子请求，不是夹具另造的字符串。
      expect(h.visionCalls).toHaveLength(1);
      expect(h.visionCalls[0]?.model).toBe("vision-stub");
      // 提示词取自方案「媒体」槽的**真实**指令（不是夹具另造的字符串）。
      expect(h.visionCalls[0]?.prompt).toContain("媒体内容");
      // 强负：视觉确实经真实叶子跑过一次（真实 vision step，非夹具自述）：模型名来自
      // 组织设置的登记值，phase 是叶子自己的 vision，不是主轮的一次 next。
      const leafSteps = h.db
        .query("SELECT model,phase,status FROM agent_steps WHERE phase='vision'")
        .all() as { model: string; phase: string; status: string }[];
      expect(leafSteps).toEqual([{ model: "vision-stub", phase: "vision", status: "completed" }]);
      // 视觉叶子是一次独立运行（与主轮 run 分开），不是主轮里的一次普通调用。
      const mainRun = h.db
        .query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'")
        .get() as { n: number };
      expect(mainRun.n).toBe(1);
    } finally {
      closeHarnesses();
    }
  }, 60_000);

  it("keeps a caller-provided completeMultimodal ahead of the harness stub", async () => {
    const used: MultimodalRequest[] = [];
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaInput: { mode: "description" },
      imageBytes: { "leaf-image": png() },
      // 端口自带 completeMultimodal（既有写法）：必须优先于夹具默认桩。
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: {
        complete: async (request) =>
          JSON.stringify(request.responseSchema ?? {}).includes("evaluations")
            ? JSON.stringify({
                evaluations: [{ targetId: "10001", score: 6, intent: "看图", sourceSeqs: [] }],
              })
            : "",
        async *streamText() {
          yield "";
        },
        async completeMultimodal(request: MultimodalRequest) {
          used.push(request);
          return "用户端口的描述";
        },
      } as Partial<ModelPort>,
      vision: ["夹具桩不应被使用"],
    });
    try {
      h.receive({ id: "-1", speaker: "10001", text: "看图", image: "leaf-image" });
      h.advance(31);
      await h.activate("chiming_in").catch(() => undefined);
      await h.deliver();

      expect(used.length).toBeGreaterThan(0);
      // 强负：夹具桩没有取代用户端口（桩的答复一个都没落库）。
      const notes = h.db
        .query("SELECT note FROM qq_media_read_tasks WHERE note IS NOT NULL")
        .all() as { note: string }[];
      expect(notes.map((row) => row.note)).toEqual(["用户端口的描述"]);
      // 模型名/提示词与 production 同一来源（不是夹具另造的字符串）。
      expect(used[0]?.model).toBe("vision-stub");
      expect(used[0]?.images.length).toBeGreaterThan(0);
    } finally {
      closeHarnesses();
    }
  }, 60_000);

  it("keeps a pure native image at zero vision leaf calls while a description leaf counts once", async () => {
    // 对照面：同一条 native 图链，模式是 native —— native 把画面直接发给决策/评分/生成，
    // 从不经由视觉叶子，所以这里必须是 0（与上面的 description 恰好一次互为对照）。
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mergeWindowSeconds: 0,
      mediaInput: { mode: "native" },
      imageBytes: { "leaf-image": png() },
      vision: ["原生不该用到"],
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: [
        batchScore([{ targetId: "10001", score: 6, intent: "回答图片问题", sourceSeqs: [] }]),
        decideGenerate("10001", "回答图片问题", []),
        say("原生回复正文"),
      ],
    });
    try {
      h.receive({ id: "-1", speaker: "10001", text: "看图", image: "leaf-image" });
      h.advance(31);
      await h.activate("chiming_in");
      await h.deliver();
      // 前置事实：图真的进了链路（否则"零叶子调用"是恒真的空断言）。
      expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_variants").get()).toEqual({ n: 1 });
      expect(h.visionCalls).toHaveLength(0);
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM agent_steps WHERE phase='vision'").get(),
      ).toEqual({ n: 0 });
    } finally {
      closeHarnesses();
    }
  }, 60_000);

  it("advances the shared vision outcome cursor exactly once per read", async () => {
    // 共享游标不被二次消费：两次真实读取各消费恰好一个 outcome，按序拿到 A、B。
    // 若一次 read 吃掉两个（或一个都没吃），落库的 note 就会错位或重复。
    const first = "第一条视觉描述A";
    const second = "第二条视觉描述B";
    const h = createOneBotHarness({
      kind: "private",
      vision: [first, second],
      model: [],
    });
    // driveToolFirst 只装一次（重复调用会二次包裹 complete）。
    const disclosed: { id?: string } = {};
    driveToolFirst(h, (observation) => {
      if (observation?.name === "media.list") {
        const listed = observation.value?.items?.[0]?.id;
        if (!listed) throw new Error("Missing listed image");
        return [decideInvoke("media.describe", { id: disclosed.id ?? listed })];
      }
      if (observation?.name === "media.describe") {
        // 第二条消息是新载体，第一次 describe 后把目标切到它（否则命中缓存零视觉）。
        if (disclosed.id === undefined) disclosed.id = undefined;
        return [decideInline("20002", "图片已读", [])];
      }
      return null;
    });
    const notes = () =>
      (
        h.db
          .query("SELECT note FROM qq_media_read_tasks WHERE note IS NOT NULL ORDER BY attempts")
          .all() as {
          note: string;
        }[]
      ).map((row) => row.note);
    try {
      h.model?.push([decideInvoke("media.list", {})]);
      h.receive({ id: "1", image: "cursor-image", text: "看图" });
      await h.activate("direct_reply").catch(() => undefined);
      // 第一次读：记一次账、恰好消费 outcomes[0]。
      expect(h.visionCalls).toHaveLength(1);
      expect(h.visionCalls[0]?.model).toBe("vision-stub");
      expect(notes()).toEqual([first]);

      // 第二次读（新图＝新载体）：恰好消费 outcomes[1]，不是重复 A、也不是跳过。
      h.model?.push([decideInvoke("media.list", {})]);
      h.receive({ id: "2", image: "cursor-image-2", text: "再看一张" });
      await h.activate("direct_reply").catch(() => undefined);
      expect(h.visionCalls).toHaveLength(2);
      expect(notes()).toEqual([first, second]);
    } finally {
      closeHarnesses();
    }
  }, 60_000);
});

describe("harness compression queue consumer", () => {
  it("drains a real queued compression job through the production queue", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      peerId: "20002",
      kind: "private",
      compressionQueue: true,
      // 压缩叶子要一份真实 facts（requireFacts：空摘要不落库）。它带自己的
      // responseSchema，脚本步骤接不住，因此只在这一类调用上按真实事件产出事实，
      // 其余调用（决策/评分/生成）照旧走脚本。
      model: compressAwarePort([decideGenerate("20002", "回答", []), say("压缩用例正文")]),
    });
    try {
      // 水位触发降到 1：窗口外旧消息即足以让宿主产出真实压缩任务。
      h.db.query("UPDATE qq_schemes SET summary_watermark_trigger=1 WHERE id=?").run(h.scheme.id);
      const documentId = h.knowledge("水位包占位", "占位正文");
      const version = (
        h.db
          .query("SELECT content_version AS v FROM knowledge_documents WHERE id=?")
          .get(documentId) as { v: number }
      ).v;
      saveQqConversationSummary(h.orm, {
        conversationId: h.conversationId,
        agentId: DEFAULT_AGENT_ID,
        throughSeq: 0,
        coveredSeq: 0,
        packages: [
          {
            facts: [
              {
                kind: "fact",
                speaker: "20002",
                text: "水位包标记COMPRESS55",
                source_ids: [JSON.stringify([["knowledge_document", documentId, String(version)]])],
              },
            ],
            fromSeq: 0,
            throughSeq: 0,
            fromSeconds: 0,
            throughSeconds: 0,
            at: h.now(),
          },
        ],
        modelName: "stub",
        configSnapshot: {},
        estimatedTokens: 8,
        at: h.now(),
        expected: null,
        assertCurrent: () => {},
      });
      // 前置事实：占位摘要确实落库（否则「推进」无对照面）。
      expect(
        (h.db.query("SELECT COUNT(*) AS n FROM qq_conversation_summaries").get() as { n: number })
          .n,
      ).toBe(1);

      // 水位缓冲只收**窗口外**的旧消息：先把时钟推过整个回复窗口（默认 360 分钟），
      // 落一条旧消息，再推回窗口内落一条触发消息。推进量必须留在保留期内
      // （正文按 QQ_RETENTION_DEFAULT_DAYS=14 天过期），否则旧消息读不到、压缩无从发生。
      h.advance(24 * 60 * 60);
      h.receive({ id: "-0", text: "很久以前的一条旧消息" });
      h.advance(24 * 60 * 60);
      h.receive({ id: "-1", text: "普通聊天", addressed: true });
      await h.activate("direct_reply");
      await h.deliver();

      // 前置事实：任务确实被宿主产出并入队，消费前水位行未被推进。

      const before = h.db
        .query(
          "SELECT through_seq AS t, covered_seq AS c FROM qq_conversation_summaries WHERE conversation_id=?",
        )
        .get(h.conversationId) as { t: number; c: number };
      expect(before.t).toBe(0);
      expect(before.c).toBe(0);

      // 真实消费：同一队列实例 dequeue → job.run → 落库（不是夹具自述）。
      await h.compressionRunOnce();

      const after = h.db
        .query(
          "SELECT through_seq AS t, covered_seq AS c FROM qq_conversation_summaries WHERE conversation_id=?",
        )
        .get(h.conversationId) as { t: number; c: number };
      expect(after.t).toBeGreaterThan(0);
      // 强负：队列排空后再消费一次不再加包——真实消费过一次，且队列确实排空
      // （包与包不合并：占位包 + 本次新包 = 2；第三次消费仍是 2）。
      await h.compressionRunOnce();
      const packages = (
        JSON.parse(
          (
            h.db
              .query("SELECT content FROM qq_conversation_summaries WHERE conversation_id=?")
              .get(h.conversationId) as { content: string }
          ).content,
        ) as { packages: unknown[] }
      ).packages.length;
      expect(packages).toBe(2);
    } finally {
      h.close();
    }
  }, 60_000);
});
