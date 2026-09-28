import { z } from "zod";

export interface ActionDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  capability: string;
  /**
   * 有没有副作用。**默认 `write`（保守）**：没声明的一律串行执行，只有明确声明 `read` 的动作
   * 才允许同批并行——一个动作"看起来只读"不是理由。
   */
  effect?: "read" | "write";
}
export interface LeafAgentSpec {
  id: string;
  version?: string;
  instructions?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  /** Existing task-specific budgets; omitted means the gateway's existing limit applies. */
  limits?: { inputUnits?: number; deadlineMs?: number };
}
export interface AgentGenerationConfig {
  /** Channel reply instructions may differ from decision/review instructions. */
  instructions?: string;
  /** Some channels may complete an empty body with a non-text output, e.g. a sticker. */
  allowEmpty?: boolean;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  inputUnits?: number;
}

export interface AgentSpec extends LeafAgentSpec {
  context: "conversation";
  availableActions: readonly ActionDescription[];
  /** Different routes may decide and write; hosts can specialize each output. */
  generation?: AgentGenerationConfig;
  limits: { inputUnits?: number; outputTokens?: number; steps: number; deadlineMs?: number };
}

const outputBase = {
  targetId: z.string().min(1),
  stickerIds: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .describe(
      "Both output kinds: null/omitted=auto; []=no sticker; [id]=select a disclosed sticker.search/pending_plan ID.",
    ),
};
export const OutputDraftSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...outputBase,
    kind: z.literal("inline"),
    text: z.string(),
  }),
  z.strictObject({ ...outputBase, kind: z.literal("generate"), instructions: z.string() }),
]);
export type OutputDraft = z.infer<typeof OutputDraftSchema>;
/**
 * 一次工具调用。`effect` 由**动作自己**声明（不写在协议里）：只读的可以并行，有副作用的必须串行
 * 且按模型给的顺序——调度只认这一处声明，不在执行器里按名字硬编码。
 */
export const InvokeCallSchema = z.strictObject({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
export type InvokeCall = z.infer<typeof InvokeCallSchema>;
/** 一批调用最多几条：再多也不是"这一步需要"，而是模型在扫射。 */
export const INVOKE_BATCH_LIMIT = 4;
export const AgentDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("invoke"),
    calls: z.array(InvokeCallSchema).min(1).max(INVOKE_BATCH_LIMIT),
  }),
  z.strictObject({ kind: z.literal("final"), outputs: z.array(OutputDraftSchema).min(1) }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

/**
 * 混排的原生调用标记（issue #10，2026-09-26）：带原生工具调用训练的服务/模型会在正确的决策 JSON
 * 之后追加一段调用标记（已观测到 DeepSeek 系的 `<｜DSML｜｜invoke name=…>`），整段不再可解析。
 * 标记属于传输层噪音，不是决策内容——从第一个标记起截掉。截不截都读不出时照旧失败（不猜内容）。
 */
function stripToolCallMarkup(text: string): string {
  const marker = text.search(/<[｜|]{0,2}DSML/i);
  return marker === -1 ? text : text.slice(0, marker).trim();
}

/**
 * 模型"接着说下去"的续写（实测：带工具调用训练的外部模型会在合法决策 JSON 之后自己编一串
 * `<system>{"evaluations":…}</system>` 假结果）。与 DSML 标记同类——都是决策之后的传输层噪音，
 * 所以只认**开头那个完整的 JSON 对象**，后面只允许空白、或从那以后的 `<` 标记；**其余一律照旧失败**
 * （第二个对象、散文都不认，不做正文抽取、不猜内容）。
 */
function decisionBody(body: string): string {
  const object = leadingJsonObject(body);
  if (object === null) return body;
  const tail = body.slice(object.length);
  const markup = tail.indexOf("<");
  const prose = markup === -1 ? tail : tail.slice(0, markup);
  return prose.trim() === "" ? object : body;
}

function leadingJsonObject(text: string): string | null {
  if (!text.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return null;
}

/**
 * 模型正文的读取（决策与叶子解析器共用）：允许一条完整的 ``` 围栏——外部模型（实测 gemini 系）
 * 会把 JSON 包在围栏里，围栏是传输层包装、不是内容；其余照旧严格：只认开头那个完整 JSON 对象，
 * 尾部只放过空白与 `<` 标记，散文与第二个对象都不猜。
 */
export function readJsonBody(raw: string): string {
  const text = raw.trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  return decisionBody((fence?.[1] ?? text).trim());
}

/**
 * 单调用写法 → 批量写法。老的正文形状（`{kind:"invoke", name, arguments}`）在模型与历史提示词里
 * 都存在，所以在这里归一，而不是让协议同时容忍两种形状——执行器与遥测只见一种。
 */
function normalizeInvoke(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.kind !== "invoke" || Array.isArray(record.calls)) return value;
  const name = record.name;
  if (typeof name !== "string" || name.length === 0) return value;
  const args = record.arguments;
  return {
    kind: "invoke",
    calls: [
      {
        name,
        arguments: args !== null && typeof args === "object" && !Array.isArray(args) ? args : {},
      },
    ],
  };
}

/** Transport wrappers are not decisions: accept one complete JSON fence, never prose extraction. */
export function parseAgentDecision(raw: string): AgentDecision {
  return AgentDecisionSchema.parse(
    normalizeInvoke(JSON.parse(readJsonBody(stripToolCallMarkup(raw.trim())))),
  );
}

// Ask structured-output models to emit null for auto. The parser also accepts omitted
// fields from providers using JSON-object/plain-text mode or older pending plans.
export const AGENT_DECISION_JSON_SCHEMA = z.toJSONSchema(AgentDecisionSchema, {
  override({ zodSchema, jsonSchema }) {
    if (OutputDraftSchema.options.some((option) => option === zodSchema))
      jsonSchema.required = [...(jsonSchema.required ?? []), "stickerIds"];
  },
}) as Record<string, unknown>;

export function leafSpec(id: string, options: Omit<LeafAgentSpec, "id"> = {}): LeafAgentSpec {
  return { id, ...options };
}
