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
 * 这个失败值得降级吗？只有"请求形状被服务端拒绝"才算。
 *
 * 看 HTTP 状态而不是错误文字：4xx 是服务端在说"这个请求我不接受"，其中 401/403 是凭据问题
 * （降级只会掩盖真正的配置错误），其余 4xx 才可能是结构化输出字段。
 */
export function structuredOutputRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 403
  );
}
