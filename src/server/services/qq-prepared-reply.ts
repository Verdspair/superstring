import type { QqTaskSnapshot } from "./qq-binding-contract";
import type { QqContextSelection } from "./qq-context-contract";
import type { QqSpeechKind } from "./qq-speaking-contract";

/** Draft material for deterministic output/sticker assembly, independent of any model pipeline. */
export interface QqPreparedReply {
  readonly text: string | null;
  readonly snapshot: QqTaskSnapshot;
  readonly schemeRevision: number;
  readonly agentConfigVersion: number;
  readonly path: QqSpeechKind;
  readonly nowSeconds: number;
  readonly selection: QqContextSelection;
  readonly stickerId: string | null | undefined;
  readonly targetSpeakerId: string | null;
}
