---
name: system-qq-reply
description: Guidance for QQ reply turns. Choose independent text and sticker contributions per authorized target; the host validates and submits native QQ segments through its normal output path.
license: MIT
compatibility: Uses only reply.text, reply.sticker, and other actions already declared in this conversation.
allowed-tools: "reply.text reply.sticker"
---

# Replying in QQ conversations

Choose whether to reply with text, a sticker, both, or no output, according to the
conversation. There is no separate silence tool: do not call either reply tool
when there is nothing to send, or return `none` when the run protocol permits it.

1. Use `reply.text` for each authorized target that needs text. Choose `inline`
   text or `generate` instructions.
2. Use `sticker.search` when sticker candidates are needed. A sticker ID must
   come from this run's returned candidates. Use `reply.sticker` only for a
   target that should receive one disclosed sticker; each target may contribute
   at most one sticker.
3. Calling only `reply.text` means that target is text-only. Do not search or
   call `reply.sticker` just to declare that no sticker is wanted. A sticker
   contribution without `reply.text` can be a sticker-only reply; contributions
   for the same target combine into one logical reply.
4. Use `replyToMessageId` only to quote a real message disclosed in this
   conversation; use `mentionIds` only for members you choose to notify. These
   fields are independent and optional. A quote does not automatically mention
   its author, and a mention does not automatically quote a message.
5. Keep all contributions within `authorizedTargets`. Use each terminal
   contribution tool at most once per decision batch; do not mix terminal
   contributions with ordinary tools in that same batch. Search first, then
   make the reply decision in a later step if more information is needed.
6. Do not submit an empty text contribution or guess, reuse, or silently omit
   invalid references. Unknown, expired, mismatched, or unauthorized references
   are errors. The host places quote and mentions on the first actual delivery
   part only.

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
