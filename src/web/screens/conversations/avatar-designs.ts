import { AVATAR_STYLES, type GeneratedAvatar } from "../../../shared/contracts/conversation-avatar";

export { AVATAR_STYLES, type GeneratedAvatar } from "../../../shared/contracts/conversation-avatar";

export type AvatarStyle = GeneratedAvatar["style"];
export type AvatarSelection = GeneratedAvatar | File | null;
export type AvatarIdentity = { id: string; title: string; topology: "direct" | "shared" };
/** The full conversation id is DiceBear's seed; titles and participant names never affect identity. */
export function defaultConversationAvatar(conversation: AvatarIdentity): GeneratedAvatar {
  const styleIndex =
    Array.from(conversation.id).reduce((index, character) => index + character.charCodeAt(0), 0) %
    AVATAR_STYLES.length;
  return { kind: "generated", style: AVATAR_STYLES[styleIndex], seed: conversation.id };
}
