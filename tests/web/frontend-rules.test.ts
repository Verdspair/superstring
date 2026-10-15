import { describe, expect, it } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import { toDraft } from "../../src/web/features/agents/draft";
import {
  buildSectionPayload,
  mergeSavedSection,
} from "../../src/web/features/agents/section-rules";
import { createOptimisticMessages } from "../../src/web/features/chat/message-rules";

const NOW = "2026-09-17T12:00:00.000Z";
const agent = () =>
  AgentResponseSchema.parse({
    id: "agent",
    name: "saved",
    model_name: "model",
    config_version: 4,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
  });
function fixtures() {
  const saved = agent();
  const draft = structuredClone(toDraft(saved));
  draft.name = "draft";
  draft.memory_retrieval_prompt = "draft retrieval";
  draft.p5_config.retrieval_mode = "broad";
  draft.p5_config.context_window = 8192;
  return { saved, draft };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

describe("分区纯规则", () => {
  it("A只提交基本字段与版本，不提交B/C/D", () => {
    const { saved, draft } = fixtures();
    const payload = buildSectionPayload("A", freeze(draft), freeze(saved));
    expect(Object.keys(payload).sort()).toEqual(
      [
        "name",
        "description",
        "additional_instructions",
        "model_name",
        "temperature",
        "is_active",
        "expected_version",
      ].sort(),
    );
    expect(payload).toMatchObject({ name: "draft", expected_version: 4 });
  });
  it("B只更新检索预算，保留服务端上下文配置且不修改输入", () => {
    const { saved, draft } = fixtures();
    const before = structuredClone({ saved, draft });
    const payload = buildSectionPayload("B", freeze(draft), freeze(saved));
    expect(payload.p5_config?.retrieval_mode).toBe("broad");
    expect(payload.p5_config?.context_window).toBe(saved.p5_config.context_window);
    expect({ saved, draft }).toEqual(before);
  });
  it("C只更新上下文，保留服务端检索配置", () => {
    const { saved, draft } = fixtures();
    const payload = buildSectionPayload("C", freeze(draft), freeze(saved));
    expect(payload.p5_config?.context_window).toBe(8192);
    expect(payload.p5_config?.retrieval_mode).toBe(saved.p5_config.retrieval_mode);
    expect(payload.p5_config?.retrieval_presets).toEqual(saved.p5_config.retrieval_presets);
  });
  it.each(["A", "B", "C"] as const)("%s保存合并只覆盖所属分区与配置版本", (section) => {
    const { saved, draft } = fixtures();
    saved.config_version = 5;
    const before = structuredClone(draft);
    const result = mergeSavedSection(section, freeze(draft), freeze(saved), false);
    expect(result.config_version).toBe(5);
    expect(result.name).toBe(section === "A" ? "saved" : "draft");
    expect(result.memory_retrieval_prompt).toBe(
      section === "B" ? saved.memory_retrieval_prompt : "draft retrieval",
    );
    expect(result.p5_config.context_window).toBe(
      section === "C" ? saved.p5_config.context_window : 8192,
    );
    expect(result.p5_config.retrieval_mode).toBe(
      section === "B" ? saved.p5_config.retrieval_mode : "broad",
    );
    expect(draft).toEqual(before);
  });
  it("创建成功或空草稿完整采用服务端结果", () => {
    const { saved, draft } = fixtures();
    expect(mergeSavedSection("A", draft, saved, true)).toEqual(toDraft(saved));
    expect(mergeSavedSection("B", null, saved, false)).toEqual(toDraft(saved));
  });
});

describe("消息纯规则", () => {
  it("乐观消息只依赖显式的文本、ID和时间", () => {
    expect(createOptimisticMessages("你好", "request", NOW)).toEqual(
      createOptimisticMessages("你好", "request", NOW),
    );
    const rows = createOptimisticMessages("你好", "request", NOW);
    expect(rows.map((row) => [row.id, row.role, row.status])).toEqual([
      ["optimistic-user-request", "user", "completed"],
      ["optimistic-assistant-request", "assistant", "pending"],
    ]);
  });
});
