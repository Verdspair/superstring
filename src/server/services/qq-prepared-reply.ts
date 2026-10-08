import type { QqTaskSnapshot } from "./qq-binding-contract";
import type { QqContextSelection } from "./qq-context-contract";
import type { QqSpeechKind } from "./qq-speaking-contract";

/** Draft material for deterministic output/sticker assembly, independent of any model pipeline. */
export interface QqPreparedReply {
  readonly text: string | null;
  /** 同会话已观察且在提交边界复验通过的引用消息 ID。 */
  readonly replyToMessageId?: string;
  readonly snapshot: QqTaskSnapshot;
  readonly schemeRevision: number;
  readonly agentConfigVersion: number;
  readonly path: QqSpeechKind;
  readonly nowSeconds: number;
  readonly selection: QqContextSelection;
  readonly stickerId: string | null | undefined;
  readonly targetSpeakerId: string | null;
  /** 正文要显式 @ 的成员 ID（结构化）；宿主已按真实合法成员校验，正文 CQ 不再作为编码来源。 */
  readonly mentionIds: readonly string[];
}
