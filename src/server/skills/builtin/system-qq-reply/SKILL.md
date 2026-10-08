---
name: system-qq-reply
description: Guidance for QQ reply turns. Finish with one speech.reply call; each target may independently include plain text, a disclosed message replyToMessageId, mentionIds, and stickerIds. The host validates and submits native QQ segments through its normal output path.
license: MIT
compatibility: Uses only the speech.reply action already declared in this conversation.
allowed-tools: "speech.reply"
---

# Replying in QQ conversations

End the turn with one `speech.reply` call. It is terminal: the host submits
the output through the normal delivery path; there is no second model
confirmation or separate send action.

1. Give each logical target its own output with its authorized `targetId`.
2. Choose the output parts independently. Use plain `text` for ordinary
   speech; add `replyToMessageId` only to quote a real message disclosed in
   this conversation; add `mentionIds` only for members you choose to notify;
   use `stickerIds` only for the sticker choice. A quote does not automatically
   mention its author, and a mention does not automatically quote a message.
3. Valid combinations include plain text, mention-only, quote plus text, and
   quote plus mention plus text. Do not submit an empty quote-only or otherwise
   empty body. Use only currently available message references and member IDs
   observed in this conversation. Unknown, expired, mismatched, or unauthorized
   references are errors; do not guess or silently omit them.
4. When the same logical reply is split into multiple delivery parts, the host
   places its quote and mentions on the first actual part only.

## Text and CQ codes

Write plain text. CQ codes in the text stay literal and are never
re-interpreted; the host encodes native `reply` and `at` segments from the
explicit fields, so never write CQ codes into the text. `replyToMessageId` is
a platform message ID, not a UUID; copy it exactly from the current conversation.

## Boundaries

- Whether silence is allowed or a reply is required is the host's contract,
  not a grant of this skill.
- `allowed-tools` only names the action this guidance describes; it grants no
  permission. Availability follows the actions advertised this turn.
