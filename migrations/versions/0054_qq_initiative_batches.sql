-- 自主接话的计数区间为[X-Y,X+Y]，要求Y<X；到达上界仍无模型名额时保留一个合并机会或跳过。
-- chiming_in_observed_seq 是自主接话自己的观察边界，不与直接回应的 consumed_seq 混用。
ALTER TABLE qq_schemes ADD COLUMN initiative_batch_target_count INTEGER NOT NULL DEFAULT 15 CHECK (initiative_batch_target_count >= 1);
ALTER TABLE qq_schemes ADD COLUMN initiative_batch_jitter_count INTEGER NOT NULL DEFAULT 5 CHECK (initiative_batch_jitter_count >= 0 AND initiative_batch_jitter_count < initiative_batch_target_count);
ALTER TABLE qq_schemes ADD COLUMN initiative_queue_on_busy INTEGER NOT NULL DEFAULT 1 CHECK (initiative_queue_on_busy IN (0, 1));
ALTER TABLE conversations ADD COLUMN chiming_in_observed_seq INTEGER NOT NULL DEFAULT 0;
