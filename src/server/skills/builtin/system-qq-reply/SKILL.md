---
name: system-qq-reply
description: Guidance for QQ reply turns. Finish with a single speech.reply call carrying the reply text plus the authorized targets, optional mentionIds and stickerIds; the host encodes at segments and submits through its normal output path.
license: MIT
compatibility: Uses only the speech.reply action already declared in this conversation.
allowed-tools: "speech.reply"
---

# Replying in QQ conversations

End the turn with one `speech.reply` call. It is terminal: the host submits
the text and no second model confirmation or review round follows.

1. Give each logical target its own output: `targetId`, the reply `text`, and
   optional `mentionIds` and `stickerIds`.
2. Use only target IDs authorized for this turn and member IDs already
   observed in the conversation; an unknown ID is an error, never a guess.
3. `mentionIds` are optional and per target: mention a member only when the
   reply addresses them; mentions are not required for every target, and this
   batch has no @all.

## Text and CQ codes

Write plain text. CQ codes in the text stay literal and are never
re-interpreted; the host encodes at segments from `mentionIds`, so never write
`[CQ:at,...]` into the text.

## Boundaries

- Whether silence is allowed or a reply is required is the host's contract,
  not a grant of this skill.
- `allowed-tools` only names the action this guidance describes; it grants no
  permission. Availability follows the actions advertised this turn.
