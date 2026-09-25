-- P5t: two follow-ups that both needed a schema step.
--
-- 1. Per-conversation module switches (§0.6 / F05: 群允许独立模块开关、不允许详细参数逐群覆盖).
--    The four speech triggers live on the SCHEME, which every conversation bound to it shares —
--    so until now the only per-group control was "pause the whole conversation". These columns add
--    a tri-state per trigger: NULL follows the scheme, 0 and 1 override it for this conversation
--    only. Detailed parameters stay out: a group may switch a module off, not re-tune the scheme.
ALTER TABLE qq_bindings ADD COLUMN trigger_direct_reply INTEGER CHECK (trigger_direct_reply IN (0, 1));
ALTER TABLE qq_bindings ADD COLUMN trigger_follow_up INTEGER CHECK (trigger_follow_up IN (0, 1));
ALTER TABLE qq_bindings ADD COLUMN trigger_chiming_in INTEGER CHECK (trigger_chiming_in IN (0, 1));
ALTER TABLE qq_bindings ADD COLUMN trigger_idle_topic INTEGER CHECK (trigger_idle_topic IN (0, 1));

-- 2. The media sampling parameters (§7.1: 帧数、尺寸可改).
--    Reading a picture or an animation sampled a fixed 3 frames at a 512-long-edge until now, in
--    one constant per number because there was no surface for either. They now live on the scheme
--    beside the other numeric limits, with the same defaults, so an installation that changes
--    nothing behaves exactly as before. The third "可改" item from the plan — a token budget for
--    images — is deliberately NOT here: P4d recorded that an image's token count has no basis, so
--    the reader reports pixels and lets the capacity gate decide.
ALTER TABLE qq_schemes ADD COLUMN media_frame_count INTEGER NOT NULL DEFAULT 3 CHECK (media_frame_count >= 1 AND media_frame_count <= 10);
ALTER TABLE qq_schemes ADD COLUMN media_max_dimension INTEGER NOT NULL DEFAULT 512 CHECK (media_max_dimension >= 64 AND media_max_dimension <= 2048);
