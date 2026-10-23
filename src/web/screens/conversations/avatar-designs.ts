import { AVATAR_STYLES, type GeneratedAvatar } from "../../../shared/contracts/conversation-avatar";

export { AVATAR_STYLES, type GeneratedAvatar } from "../../../shared/contracts/conversation-avatar";

export type AvatarStyle = GeneratedAvatar["style"];
export type AvatarSelection = GeneratedAvatar | File | null;
export type AvatarIdentity = {
  id: string;
  title: string;
  topology: "direct" | "shared";
  channel?: "web" | "onebot11";
  qqGroup?: { number: string };
};
/**
 * Default QQ group picture CDN URL: only onebot11 + shared + a valid numeric group number; null keeps the local icon.
 * The host and path are fixed, only the verified numeric group number is interpolated.
 */
export function defaultGroupAvatarUrl(conversation: AvatarIdentity): string | null {
  const number = conversation.qqGroup?.number;
  return conversation.channel === "onebot11" &&
    conversation.topology === "shared" &&
    number &&
    /^\d+$/.test(number)
    ? `https://p.qlogo.cn/gh/${number}/${number}/100`
    : null;
}
/** The full conversation id is DiceBear's seed; titles and participant names never affect identity. */
export function defaultConversationAvatar(conversation: AvatarIdentity): GeneratedAvatar {
  const styleIndex =
    Array.from(conversation.id).reduce((index, character) => index + character.charCodeAt(0), 0) %
    AVATAR_STYLES.length;
  return { kind: "generated", style: AVATAR_STYLES[styleIndex], seed: conversation.id };
}
