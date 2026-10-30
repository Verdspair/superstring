// Media facts after canonical intake. Scheduling belongs to the injected conversation ingress.
import { readBindingByConversation } from "../db/qq-binding-repository";
import { readEffectiveQqScheme } from "../db/qq-group-config-repository";
import { mediaSegmentsForEvent } from "../db/qq-media-repository";
import type { Orm } from "../db/repositories";
import type { QqObservation } from "./onebot-protocol";

export interface QqEventPathOutcome {
  readonly dispatch: { readonly kind: "not_scheduled"; readonly reason: string };
  readonly media: { readonly hasMedia: boolean; readonly own: null; readonly supplement: null };
}

export async function handleQqRecordedMessage(
  orm: Orm,
  input: { readonly observation: QqObservation; readonly nowSeconds: number },
): Promise<QqEventPathOutcome> {
  const { observation } = input;
  const binding = readBindingByConversation(orm, {
    accountId: observation.accountId,
    kind: observation.conversation.kind,
    peerId: observation.conversation.peerId,
  });
  const reason = !binding
    ? "binding_missing"
    : !readEffectiveQqScheme(orm, binding)
      ? "scheme_missing"
      : "conversation_ingress";
  return {
    dispatch: { kind: "not_scheduled", reason },
    media: {
      hasMedia:
        reason === "conversation_ingress" &&
        mediaSegmentsForEvent(orm, observation.eventKey).length > 0,
      own: null,
      supplement: null,
    },
  };
}
