// 外部模型 API 的结构化输出适配（0032 后续，）。
//
// Why this exists: the project's own response schemas mark genuinely optional fields as optional
// (`required` lists only what must always come back). OpenAI's strict structured-output mode — and
// providers that proxy it, like the relay the user registered — refuses that shape: its rule is
// "`required` must be an array including every key in properties", which showed up as
// `invalid_json_schema` / "Missing 'reason'" and made every judgement call fail.
//
// The semantics do not change. An optional field becomes REQUIRED-but-NULLABLE on the wire, and the
// parsers on this side already read "null" and "absent" the same way. Only the external route uses
// this: the local model service keeps the exact frozen schema, so nothing about the local path's
// behaviour (or its tests) moves.

/** A JSON-schema-ish node. Kept structural rather than typed: the callers own their real shapes. */
type SchemaNode = Record<string, unknown>;

function nullable(type: unknown): unknown {
  if (typeof type === "string") return type === "null" ? type : [type, "null"];
  if (Array.isArray(type)) return type.includes("null") ? type : [...type, "null"];
  // No `type` (an enum, a $ref, a nested union): leave it alone rather than invent a shape.
  return type;
}

/**
 * Rewrite one schema so every property is required, turning the previously optional ones nullable.
 *
 * Recurses through `properties` and `items`, because a nested object has the same rule applied to
 * it. Arrays and scalars pass through untouched.
 */
export function toStrictRequiredSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const node = schema as SchemaNode;
  const next: SchemaNode = { ...node };
  const properties = node.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    const required = new Set(
      Array.isArray(node.required)
        ? node.required.filter((key): key is string => typeof key === "string")
        : [],
    );
    const rewritten: SchemaNode = {};
    for (const [key, value] of Object.entries(properties as SchemaNode)) {
      const child = toStrictRequiredSchema(value);
      rewritten[key] = required.has(key) ? child : withNullableType(child, value);
    }
    next.properties = rewritten;
    next.required = Object.keys(rewritten);
  }
  if (node.items !== undefined) next.items = toStrictRequiredSchema(node.items);
  return next;
}

/** The rewritten child plus a nullable type, unless the rewrite produced something untyped. */
function withNullableType(rewritten: unknown, original: unknown): unknown {
  if (rewritten === null || typeof rewritten !== "object" || Array.isArray(rewritten))
    return rewritten;
  const source = (
    original !== null && typeof original === "object" && !Array.isArray(original) ? original : {}
  ) as SchemaNode;
  if (source.type === undefined) return rewritten;
  return { ...(rewritten as SchemaNode), type: nullable(source.type) };
}

// ---- 结构化输出的降级链----------------------------------------------------------
//
// 现实：不是每个 OpenAI 兼容的服务都接受 `response_format: {type:"json_schema", strict:true}`——
// 有的只支持 `json_object`，有的一见这个字段就 4xx。而本项目的解析**本来就是严格的**：约束少给
// 一点不会让答案被读错，只会让"读不出"的概率高一点（读不出仍然等于沉默，绝不猜）。
//
// 所以降级是安全的，而且是自动的：严格 json_schema → json_object → 不带 response_format。
// 只在**客户端错误**（4xx，且不是 401/403 鉴权失败）时降级；5xx、超时、网络中断不是形状的问题，
// 原样抛出。某一档一旦成功就记住"这个服务+模型要从这一档起"，后续调用不再白撞一次。

// ---- 与严格模式不兼容的 schema 形状-------------------------------------
//
// 用户的云端 provider 按 OpenAI 严格模式校验 response_format：`oneOf` 一律不收，整单 400
// （"Invalid schema for response_format 'superstring_result': In context=(), 'oneOf' is not
// permitted." 正是它）。而本项目的 Agent 决策 schema 就是一个判别联合（invoke/final/none），
// 于是每次都注定被拒：先是 400，再由降级链退回 json_object——控制台上每次重启都多一条错误。
//
// 所以形状注定被拒的 schema 不再去白撞：直接从 `json_object` 起步。语义没有变化——本项目的解析
// 本来就是严格的，provider 端的约束少给一点只会让"读不出"的概率高一点（读不出仍然等于沉默）。
// 只对外部路由生效：本地模型服务继续收到那份冻结的原文。

/** Schema 节点里可能出现子 schema 的关键字；遍历它们才不会被嵌套的联合漏过去。 */
const CHILD_SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions"] as const;
const CHILD_SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
const CHILD_SCHEMA_NODES = ["items", "additionalProperties", "contains", "not"] as const;

/**
 * 严格模式能原样收下这个 schema 吗？（目前被证伪的构造是 `oneOf`。）
 *
 * `properties` 里恰好有个键叫 "oneOf" 不算——那是属性名，不是关键字，所以按结构走而不是按名字扫。
 */
export function strictSchemaAccepted(schema: unknown): boolean {
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== "object") return true;
    if (Array.isArray(node)) return node.every(visit);
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.oneOf)) return false;
    for (const key of CHILD_SCHEMA_MAPS) {
      const map = record[key];
      if (map === null || typeof map !== "object" || Array.isArray(map)) continue;
      if (!Object.values(map as Record<string, unknown>).every(visit)) return false;
    }
    for (const key of CHILD_SCHEMA_LISTS) {
      const list = record[key];
      if (Array.isArray(list) && !list.every(visit)) return false;
    }
    for (const key of CHILD_SCHEMA_NODES) if (!visit(record[key])) return false;
    return true;
  };
  return visit(schema);
}

const announcedSkips = new Set<string>();

/** 每个服务+模型只提示一次：这条 schema 的形状严格模式不收，本进程直接走 json_object。 */
export function announceStrictSchemaSkip(key: string, model: string): void {
  if (announcedSkips.has(key)) return;
  announcedSkips.add(key);
  console.warn(
    `[model-structured] ${model} 的响应 schema 含严格模式不收的构造（如 oneOf），直接使用 json_object`,
  );
}

export type StructuredOutputLevel = "json_schema" | "json_object" | "none";

/** 从最严到最松。只允许往后走。 */
export const STRUCTURED_OUTPUT_LEVELS: readonly StructuredOutputLevel[] = Object.freeze([
  "json_schema",
  "json_object",
  "none",
]);

/** key = 服务地址 + 模型：同一台服务换模型可能支持程度不同，所以两者都算进身份。 */
const degraded = new Map<string, StructuredOutputLevel>();

export function structuredOutputKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${model}`;
}

/**
 * 这个服务+模型从哪一档开始试（第一次是 json_schema；形状注定被拒的 schema 从 json_object 起，
 * 见 `strictSchemaAccepted`）。已经记住的档优先——那是实测过的结论。
 */
export function structuredOutputStart(key: string, strictAccepted = true): StructuredOutputLevel {
  const remembered = degraded.get(key);
  if (remembered !== undefined) return remembered;
  return strictAccepted ? "json_schema" : "json_object";
}

/** 记住它从哪一档起可用，后续调用直接跳过会失败的那档。 */
export function rememberStructuredOutput(key: string, level: StructuredOutputLevel): void {
  if (level === "json_schema") return;
  degraded.set(key, level);
}

/** 下一档；已经是最后一档就返回 null（没有可再降的，调用方应把原错误抛出）。 */
export function nextStructuredOutputLevel(
  level: StructuredOutputLevel,
): StructuredOutputLevel | null {
  const index = STRUCTURED_OUTPUT_LEVELS.indexOf(level);
  if (index < 0 || index + 1 >= STRUCTURED_OUTPUT_LEVELS.length) return null;
  return STRUCTURED_OUTPUT_LEVELS[index + 1] ?? null;
}

/**
 * 「请求**内容**被拒」的内部标记：网关在 HTTP 边界认出图片格式/尺寸/URL/schema/解码这类
 * 内容层面错误时打上（见 model-gateway 的分类器）。它不是错误码，不进信封；唯一读者是
 * `structuredOutputRejected`——内容问题没有形状降级资格，降级只会原样重传图字节并把该服务
 * 误记成"不支持 tools/schema"。
 */
const IMAGE_CONTENT_REJECTED: unique symbol = Symbol("model.imageContentRejected");

interface ContentMarkedError {
  [IMAGE_CONTENT_REJECTED]?: boolean;
}

/** 打标记；非 Error 原样返回（无状态可标，调用方按原路径抛出）。 */
export function markImageContentRejection(error: unknown): unknown {
  if (error instanceof Error) (error as Error & ContentMarkedError)[IMAGE_CONTENT_REJECTED] = true;
  return error;
}

/** 这个错误被 HTTP 边界标成内容拒绝了吗？ */
export function imageContentRejection(error: unknown): boolean {
  return (error as ContentMarkedError | null)?.[IMAGE_CONTENT_REJECTED] === true;
}

/**
 * 这个失败值得降级吗？只有"请求形状被服务端拒绝"才算。
 *
 * 看 HTTP 状态而不是错误文字：4xx 是服务端在说"这个请求我不接受"，其中 401/403 是凭据问题
 * （降级只会掩盖真正的配置错误）。408（请求超时）与 429（限流）是暂时状态：误当形状拒绝降级，
 * 还会把该服务永久记成"不支持 tools"。413（输入超长）是请求体的问题，不是 schema/tools 的
 * 形状问题：降级只会把全部图字节最多重传 5 次、再把该服务记成"不支持 tools"——输入超长故障
 * 如实一次报错（规格 §9），修请求体或换容量，不靠降级重试。
 * 被网关标成内容拒绝的错误（`markImageContentRejection`）一律没有降级资格：内容问题换一张
 * 合法图片就该能发，重发同内容只会重传图字节、还会污染 tools/schema 档位。
 */
export function structuredOutputRejected(error: unknown): boolean {
  if (imageContentRejection(error)) return false;
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 413 &&
    status !== 429
  );
}

export interface StructuredOutputChainOptions<T> {
  /** 服务+模型身份，见 `structuredOutputKey`。 */
  readonly key: string;
  /** 日志里显示的模型名。 */
  readonly model: string;
  /** 有响应 schema 才走降级链；没有就直接发 "none"。 */
  readonly hasSchema: boolean;
  /** 形状是否被严格模式接受；由调用方判定（本地路由不参与这个判断）。 */
  readonly strictAccepted: boolean;
  readonly send: (level: StructuredOutputLevel) => Promise<T>;
  /** 降级日志尾部的失败详情；不提供则不加。 */
  readonly rejectionDetail?: (error: unknown) => string;
}

/**
 * 降级链的驱动：严格 json_schema → json_object → 不带该字段。网关的文本调用与视觉调用共用它，
 * 差别只在发送层（网关还叠了 tools 重试）、日志里的模型名与降级日志是否附失败详情。
 */
export async function withStructuredOutputChain<T>(
  options: StructuredOutputChainOptions<T>,
): Promise<T> {
  const { key, model, hasSchema, strictAccepted, send, rejectionDetail } = options;
  if (!hasSchema) return send("none");
  if (!strictAccepted) announceStrictSchemaSkip(key, model);
  let level = structuredOutputStart(key, strictAccepted);
  // 只有"这一轮真的撞过更严的档"才值得记住并提示；直接跳过不算。
  const attemptedStrict = level === "json_schema";
  for (;;) {
    try {
      const payload = await send(level);
      if (level !== "json_schema" && attemptedStrict) {
        rememberStructuredOutput(key, level);
        console.warn(`[model-structured] ${model} 本进程起改用 ${level}（该服务不接受更严的档）`);
      }
      return payload;
    } catch (error) {
      if (!structuredOutputRejected(error)) throw error;
      const next = nextStructuredOutputLevel(level);
      if (next === null) throw error;
      const status = (error as { status?: number }).status;
      const detail = rejectionDetail === undefined ? "" : `：${rejectionDetail(error)}`;
      console.warn(
        `[model-structured] ${model} 拒绝 ${level}（HTTP ${status ?? "?"}），降级到 ${next}${detail}`,
      );
      level = next;
    }
  }
}
