import { beforeEach, describe, expect, it, vi } from "vitest";
import { P5ConfigSchema } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { formatMessage } from "../../src/web/i18n";
import en from "../../src/web/i18n/locales/en/translation.json";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { useSuperstringStore } from "../../src/web/store";

const enCatalog = en as Record<string, string>;
const zhCatalog = zh as Record<string, string>;

function fakeClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return overrides as SuperstringApi;
}

// Numbers come from src/shared/contracts/permissions.ts (execution limits) and mcp.ts (MCP
// service). This table pins the rendered copy to the contracts so a drifted default fails loudly.
const EXECUTION_DEFAULTS: ReadonlyArray<[string, string, string, string, string]> = [
  ["tasksConcurrencyHint", "1–8", "1–8", "default 2;", "默认 2；"],
  [
    "tasksRetentionHoursHint",
    "1 minute–24 hours",
    "1 分钟–24 小时",
    "default 24 hours;",
    "默认 24 小时；",
  ],
  ["tasksLeaseSecondsHint", "5–120", "5–120", "default 30;", "默认 30；"],
  ["tasksPollMsHint", "100–5000", "100–5000", "default 500;", "默认 500；"],
  ["researchMaxPerRunHint", "1–2", "1–2", "default 2;", "默认 2；"],
  ["researchMaxStepsHint", "1–6", "1–6", "default 6;", "默认 6；"],
  ["researchDeadlineMsHint", "1000–120000", "1000–120000", "default 60000", "默认 60000"],
  ["researchMaxConclusionCharsHint", "1–4000", "1–4000", "default 4000;", "默认 4000；"],
  ["codeTimeoutMsHint", "1000–120000", "1000–120000", "default 20000", "默认 20000"],
  ["codeMaxCallsHint", "1–128", "1–128", "default 32", "默认 32"],
  ["codeConcurrencyHint", "1–8", "1–8", "default 3;", "默认 3；"],
  ["codeMemoryMiBHint", "8–128", "8–128", "default 32;", "默认 32；"],
  ["codeTransferKiBHint", "64–8192", "64–8192", "default 1024", "默认 1024"],
  ["codeMaxConclusionCharsHint", "1–16000", "1–16000", "default 4000", "默认 4000"],
  ["loopMaxStepsHint", "1–64", "1–64", "default 16;", "默认 16；"],
  ["loopReadBatchHint", "1–3", "1–3", "default 3;", "默认 3；"],
  ["loopNoProgressHint", "3–10", "3–10", "default 3;", "默认 3；"],
  ["loopConcurrencyHint", "1–16", "1–16", "default 4;", "默认 4；"],
  ["loopModelConcurrencyHint", "1–16", "1–16", "default 1;", "默认 1；"],
  ["loopProviderConcurrencyHint", "1–16", "1–16", "default 1;", "默认 1；"],
  ["qqRetryDelayMsHint", "1000–300000", "1000–300000", "default 15000", "默认 15000"],
  ["qqMaxAttemptsHint", "1–10", "1–10", "default 3;", "默认 3；"],
  ["qqDeliveryTtlSecondsHint", "10–3600", "10–3600", "default 120", "默认 120"],
  ["memoryTimeoutSecondsHint", "60–86400", "60–86400", "Default 3600", "默认 3600"],
  ["knowledgeTimeoutSecondsHint", "60–86400", "60–86400", "Default 3600", "默认 3600"],
];

describe("配置文案语义对应", () => {
  it("表情偏好说明主 Agent 的 stickerIds 协议并指出旧编号格式不适用", () => {
    expect(enCatalog["connections.stickerTask"]).toBe("Sticker preference");
    expect(zhCatalog["connections.stickerTask"]).toBe("表情偏好");
    const enHint = enCatalog["connections.pickOneStickerFromTheCandidatesOutputOnlyIts"];
    const zhHint = zhCatalog["connections.pickOneStickerFromTheCandidatesOutputOnlyIts"];
    for (const hint of [enHint, zhHint]) {
      expect(hint).toContain("sticker.search");
      expect(hint).toContain("stickerIds");
      expect(hint).toContain("[]");
    }
    expect(enHint).toMatch(/numbered format does not apply/);
    expect(zhHint).toContain("旧编号格式不适用");
    expect(enHint).not.toMatch(/pick one sticker from the candidates/i);
    expect(enHint).not.toMatch(/output only its number/i);
    expect(zhHint).not.toContain("从候选表情里挑一张");
    expect(zhHint).not.toContain("只输出编号");
  });

  it("媒体说明按需描述图片与动图，语音与视频标记不可用", () => {
    const enHint = enCatalog["connections.describeWhatThePictureOrVoiceActuallyContains"];
    const zhHint = zhCatalog["connections.describeWhatThePictureOrVoiceActuallyContains"];
    expect(enHint).toMatch(/images or animated frames/i);
    expect(enHint).toMatch(/voice and video are unavailable/i);
    expect(zhHint).toContain("图片或动图");
    expect(zhHint).toContain("语音与视频不可用");
    expect(enHint).not.toMatch(/picture or voice/i);
    expect(zhHint).not.toContain("语音里有什么");
  });

  it("跨页提示引用助手侧的实际标签：保留近期轮数 / 长对话维护", () => {
    const zhHint = zhCatalog["connections.followsTheBoundAssistantRecentTurns"];
    const enHint = enCatalog["connections.followsTheBoundAssistantRecentTurns"];
    expect(zhCatalog["library.recent.turns.to.retain"]).toBe("保留近期轮数");
    expect(zhCatalog["library.long.conversation.management"]).toBe("长对话维护");
    expect(zhHint).toContain(zhCatalog["library.recent.turns.to.retain"]);
    expect(zhHint).toContain(zhCatalog["library.long.conversation.management"]);
    expect(enHint).toContain(enCatalog["library.recent.turns.to.retain"]);
    expect(enHint).toContain(enCatalog["library.long.conversation.management"]);
    expect(zhHint).not.toContain("保留最近轮数");
    expect(zhHint).not.toContain("长对话管理");
    expect(enHint).not.toContain('"recent turns to retain"');
    expect(enHint).not.toContain("long-conversation management");
  });

  it("上下文窗口提示说明提供方声明与本地估算的边界", () => {
    const enHint = enCatalog["models.windowHint"];
    const zhHint = zhCatalog["models.windowHint"];
    expect(enHint).toMatch(/provider declares \(usually in tokens\)/);
    expect(enHint).toMatch(/UTF-8 bytes/);
    expect(enHint).toMatch(/not exact model tokens/);
    expect(enHint).not.toMatch(/its actual context window/);
    expect(zhHint).toContain("提供方声明的上下文窗口");
    expect(zhHint).toContain("通常以 Token 计");
    expect(zhHint).toContain("UTF-8");
    expect(zhHint).toContain("不是模型的精确 Token 数");
    expect(zhHint).not.toContain("真实上下文窗口");
  });

  it("MCP 超时与结果上限标注契约默认值且范围不变", () => {
    expect(enCatalog["connections.mcp.timeoutMs"]).toContain("default 15000");
    expect(enCatalog["connections.mcp.timeoutMs"]).toContain("100–120000");
    expect(zhCatalog["connections.mcp.timeoutMs"]).toContain("默认 15000");
    expect(zhCatalog["connections.mcp.timeoutMs"]).toContain("100–120000");
    expect(enCatalog["connections.mcp.maxResultChars"]).toContain("default 8000");
    expect(enCatalog["connections.mcp.maxResultChars"]).toContain("1–200000");
    expect(zhCatalog["connections.mcp.maxResultChars"]).toContain("默认 8000");
    expect(zhCatalog["connections.mcp.maxResultChars"]).toContain("1–200000");
  });

  it.each(EXECUTION_DEFAULTS)(
    "connections.execution.%s 标注默认值并保持范围",
    (hint, enRange, zhRange, enDefault, zhDefault) => {
      const key = `connections.execution.${hint}`;
      const enHint = enCatalog[key];
      const zhHint = zhCatalog[key];
      expect(enHint).toBeTruthy();
      expect(zhHint).toBeTruthy();
      expect(enHint).toContain(enRange);
      expect(zhHint).toContain(zhRange);
      expect(enHint).toContain(enDefault);
      expect(zhHint).toContain(zhDefault);
    },
  );

  it("并行 TaskLedger 新键在两种语言里成对存在且旧键保留", () => {
    const rows: ReadonlyArray<[string, string, string]> = [
      ["connections.tasks.allAgents", "All Agents", "全部助手"],
      ["connections.tasks.allConversations", "All Conversations", "全部会话"],
      ["connections.tasks.applyFilters", "Apply filters", "应用筛选"],
      ["connections.tasks.clearFilters", "Clear filters", "清除筛选"],
      ["connections.tasks.filterAgent", "Agent", "助手"],
      ["connections.tasks.filterConversation", "Conversation", "会话"],
      ["connections.tasks.filterOriginRun", "Source run ID", "来源 Run ID"],
      [
        "connections.tasks.approvalUnavailable",
        "Approval ticket is unavailable. Refresh task details; no approval can be submitted.",
        "批准票据不可用。请刷新任务详情；无法提交批准。",
      ],
    ];
    for (const [key, english, chinese] of rows) {
      expect(enCatalog[key]).toBe(english);
      expect(zhCatalog[key]).toBe(chinese);
    }
    for (const legacy of [
      "connections.tasks.allStatuses",
      "connections.tasks.filterStatus",
      "connections.tasks.conversation",
    ]) {
      expect(enCatalog[legacy]).toBeTruthy();
      expect(zhCatalog[legacy]).toBeTruthy();
    }
  });
});

describe("模型容量标签", () => {
  beforeEach(() => useSuperstringStore.getState().resetForTests(fakeClient()));

  it("notices 词条把上下文压缩映射为英文容量标签，旧摘要词条保留", () => {
    expect(formatMessage("zh-CN", "上下文压缩")).toBe("上下文压缩");
    expect(formatMessage("en", "上下文压缩")).toBe("Context compression");
    expect(formatMessage("zh-CN", "聊天")).toBe("聊天");
    expect(formatMessage("en", "聊天")).toBe("Chat");
    expect(formatMessage("zh-CN", "摘要")).toBe("摘要");
    expect(formatMessage("en", "摘要")).toBe("Summary");
  });

  it("容量预览显示上下文压缩标签，探测槽位不变且不新增记忆整理探测", async () => {
    const getModelCapacity = vi.fn().mockResolvedValue({
      model: "qwen/a",
      status: "loaded",
      context_length: 32768,
      error_code: null,
    });
    useSuperstringStore.setState({
      editorDraft: {
        name: "助手",
        description: "",
        additional_instructions: "",
        model_name: "qwen/a",
        temperature: 0.7,
        memory_consolidation_model_name: null,
        memory_consolidation_prompt: "整理",
        memory_consolidation_additional_instructions: "",
        memory_retrieval_model_name: "legacy-retrieval",
        memory_retrieval_prompt: "检索",
        context_compression_model_name: null,
        p5_config: P5ConfigSchema.parse({}),
        is_active: true,
        config_version: 1,
        persona_intensity: 60,
      },
      apiClient: fakeClient({ getModelCapacity }),
    });

    await useSuperstringStore.getState().refreshCapacityPreview();

    const preview = useSuperstringStore.getState().capacityPreview;
    expect(preview).toContain("聊天：实际 32768");
    expect(preview).toContain("上下文压缩：实际 32768");
    expect(preview).not.toContain("摘要：实际");

    getModelCapacity.mockClear();
    await useSuperstringStore
      .getState()
      .refreshCapacityPreview(["chat", "ignored-retrieval", "compress"]);
    expect(getModelCapacity.mock.calls.map(([name]) => name)).toEqual(["chat", "compress"]);
  });
});
