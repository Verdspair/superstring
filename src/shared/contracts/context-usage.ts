import { z } from "zod";

const units = z.number().int().nonnegative();
/**
 * 图片成本的计量状态（0052）：
 * - `unknown`：没有可核实的模型估算配置，视觉成本**未知**——未知不是 0，也不是"还能装几张"
 *   的依据（规格 §11）。
 * - `estimated`：按已批准的估算规则给了估算值；仍是估算，不冒充真实计费。
 * - `reported`：服务实际报告了 usage；保留实际报告，不回写猜测。
 */
export const VisionCostStateSchema = z.enum(["unknown", "estimated", "reported"]);
export type VisionCostState = z.infer<typeof VisionCostStateSchema>;

/**
 * 图片输入的计量（0052/T09 Step7）：`unknown` 不是 0——没有可核实的估算配置时，视觉成本未知，
 * 不能据此推导「还能装多少」；无图请求是精确的 `estimated` 0。`reported` 只在服务实际报告
 * usage 后出现，不回写猜测。
 */
export const VisionCostSchema = z.strictObject({
  state: VisionCostStateSchema,
  images: z.number().int().nonnegative().optional(),
  pixels: z.number().int().nonnegative().optional(),
});
export type VisionCost = z.infer<typeof VisionCostSchema>;

/** Metadata only: never carries prompts, retrieved documents or summary text. */
export const ContextUsageSchema = z.strictObject({
  session_id: z.string(),
  turn_id: z.string(),
  model: z.string(),
  estimator: z.literal("utf8_bytes_plus_message_overhead"),
  capacity: z.number().int().positive(),
  input_units: units,
  input_limit: units,
  output_reserved: units,
  safety_reserved: units,
  remaining: units,
  components: z.strictObject({
    instructions: units,
    recent_history: units,
    summaries: units,
    long_term_memory: units,
    knowledge: units,
    current_question: units,
    protocol: units,
  }),
  /**
   * 图片输入的计量透传（T14/规格 §11）：可选——Web builder 在渲染前组装，无渲染上下文
   * 可数时缺省＝未计量（不是 0）。字段内容只有计量状态与图数/像素计数（准备尺寸的安全
   * 边界值，不是模型 token），不参与 input_units/remaining/容量推导；unknown 不能被任何
   * 消费点合并成"全量精确剩余"。`reported` 枚举合法但目前无产出方（网关解析 provider
   * usage 属未来能力），不得把本字段的存在当成 reported 已产出。
   */
  vision_cost: VisionCostSchema.optional(),
  /**
   * 模型 token 计量（可选，与上面的字节口径**并存且不同域**）。上面的
   * `input_units`/`components` 保持 `utf8_bytes_plus_message_overhead` 的字节近似，
   * `capacity` 与输出预留仍来自模型配置；旧剩余额度是保守近似，不作精确 token 声明。
   * 本字段是同一个决策请求在描述符
   * 声明的编码下、用 `measureContextTokens` 对**整条序列化请求**（含本次响应 schema）测出的
   * 估算，是本轮 token 域的权威值。缺席＝本次没有声明编码的计数器，仍走旧字节口径，
   * 不是 0，也不是"没有成本"。
   */
  model_tokens: z
    .strictObject({
      method: z.literal("serialized_chat_token_estimate"),
      /** 只取路由显式声明的编码，不按模型名/provider 名猜。 */
      encoding: z.enum(["cl100k_base", "o200k_base"]),
      input_tokens: units,
      /** 容量减回复预留与安全余量后的输入上限，与 capacity/output_reserved 同源。 */
      input_limit: units,
      /** 无图为 `none`；有图而未计价为 `unknown`（不是 0）。 */
      media_state: z.enum(["none", "unknown"]),
    })
    .optional(),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
