// 同次模型响应封装的严格纯解析（规格 §7.2 / §10，T10a）：原生 decision / evaluation /
// generation 调用可以在同一次响应里附带媒体分类。这里的职责只有一条——把"决策/分数/正文"
// 本体原样交给各自已有的权威解析器，把附属分类收窄到"真实发送过、类别合法、不重复"的
// 白名单内；除此之外不做任何猜测、归一或降级。
//
// 两条权威都**不在本文件**，这里只是搬运，不复制规则：
// - `AgentDecision` / `AgentDecisionSchema` 唯一来自 `agent-specs.ts`；
// - 分数契约唯一是 `services/qq-prompt-contract.ts` 的 `qqJudgeOutcome`（`JudgementSchema`
//   是它的私有实现，这里不允许也不需要新的分数规则）。
//
// 失败方向：任何读不出、越界、伪造的输入都直接抛错（fail-closed）。分类缺省**不是**本体
// 放松的理由——decision/score/text 本体照旧按各自原契约严格验证。
import { z } from "zod";
import { type AgentDecision, AgentDecisionSchema } from "../../shared/contracts/agent-output";
import { type QqImageCategory, QqImageCategorySchema } from "../../shared/contracts/qq-media-input";
import { qqJudgeOutcome } from "../services/qq-prompt-contract";

export interface ModelMediaClassification {
  mediaId: string;
  category: QqImageCategory;
}
export interface ModelDecisionEnvelope {
  decision: AgentDecision;
  media: ModelMediaClassification[];
}
export interface ModelScoreEnvelope {
  scoreResult: { score: number; reason?: string | null };
  media: ModelMediaClassification[];
}
export interface ModelTextEnvelope {
  text: string;
  media: ModelMediaClassification[];
}

const ClassificationSchema = z.strictObject({
  mediaId: z.string().min(1),
  category: QqImageCategorySchema,
});

/**
 * 附属分类块的**宽松读取**：只取 `media` 字段本身做严格校验（条目形状、类别枚举），不在这里
 * 管顶层键——顶层严格性由各自的本体 envelope schema 负责，顺序是"先收窄分类、再验本体"。
 */
const MediaShape = z.object({ media: z.array(ClassificationSchema).optional() });

function validatedMedia(
  value: unknown,
  sentMediaIds: ReadonlySet<string>,
): ModelMediaClassification[] {
  const read = MediaShape.safeParse(value);
  const media = read.success ? (read.data.media ?? []) : [];
  const seen = new Set<string>();
  for (const item of media) {
    if (!sentMediaIds.has(item.mediaId)) {
      throw new Error("model envelope media references a mediaId that was not sent");
    }
    if (seen.has(item.mediaId)) {
      throw new Error("model envelope media repeats a mediaId");
    }
    seen.add(item.mediaId);
  }
  return media;
}

/**
 * 决策响应封装。`decision` 本体原样走 `AgentDecisionSchema`（invoke 1–4、final 输出、
 * extra 键拒绝等全部沿用原约束），`media` 为附属分类，缺省视为 `[]`。
 */
export function parseModelEnvelope(
  value: unknown,
  sentMediaIds: ReadonlySet<string>,
): ModelDecisionEnvelope {
  const media = validatedMedia(value, sentMediaIds);
  const DecisionEnvelopeSchema = z.strictObject({
    decision: AgentDecisionSchema,
    media: z.array(ClassificationSchema).optional(),
  });
  const parsed = DecisionEnvelopeSchema.parse(value);
  return { decision: parsed.decision, media };
}

/**
 * 评分响应封装。分数本体不是新规则：`scoreResult` 用未知值交给既有 `qqJudgeOutcome` 验证，
 * `unreadable` 即拒绝。返回的 `reason` 沿用其权威归一（trim 后空串 → null），所以这里的
 * `reason` 可能与原值在空串语义上不同——这是权威解析器自己的行为，不是本文件新增的放松。
 */
export function parseModelScoreEnvelope(
  value: unknown,
  sentMediaIds: ReadonlySet<string>,
): ModelScoreEnvelope {
  const media = validatedMedia(value, sentMediaIds);
  const ScoreEnvelopeSchema = z.strictObject({
    scoreResult: z.unknown(),
    media: z.array(ClassificationSchema).optional(),
  });
  const parsed = ScoreEnvelopeSchema.parse(value);
  const outcome = qqJudgeOutcome(JSON.stringify(parsed.scoreResult));
  if (outcome.kind !== "scored") {
    throw new Error("model envelope scoreResult is not a readable judgement");
  }
  return {
    scoreResult: { score: outcome.score, reason: outcome.reason },
    media,
  };
}

/**
 * 生成响应封装。空字符串是合法正文（stickerOnly 等合法性由宿主判断），这里只拒绝
 * 非字符串与多余结构；`media` 规则与另两个封装一致。
 */
export function parseModelTextEnvelope(
  value: unknown,
  sentMediaIds: ReadonlySet<string>,
): ModelTextEnvelope {
  const media = validatedMedia(value, sentMediaIds);
  const TextEnvelopeSchema = z.strictObject({
    text: z.string(),
    media: z.array(ClassificationSchema).optional(),
  });
  const parsed = TextEnvelopeSchema.parse(value);
  return { text: parsed.text, media };
}
