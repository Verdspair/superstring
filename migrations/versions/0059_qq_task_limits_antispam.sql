-- Per-scheme QQ task limits and the independent input anti-spam switch.
ALTER TABLE qq_schemes ADD COLUMN mention_task_limit INTEGER NOT NULL DEFAULT 4 CHECK (mention_task_limit >= 1 AND mention_task_limit <= 64);
ALTER TABLE qq_schemes ADD COLUMN ordinary_task_limit INTEGER NOT NULL DEFAULT 1 CHECK (ordinary_task_limit >= 1 AND ordinary_task_limit <= 64);
ALTER TABLE qq_schemes ADD COLUMN input_anti_spam_enabled INTEGER NOT NULL DEFAULT 0 CHECK (input_anti_spam_enabled IN (0, 1));
ALTER TABLE qq_bindings ADD COLUMN mention_task_limit INTEGER CHECK (mention_task_limit IS NULL OR (mention_task_limit >= 1 AND mention_task_limit <= 64));
ALTER TABLE qq_bindings ADD COLUMN ordinary_task_limit INTEGER CHECK (ordinary_task_limit IS NULL OR (ordinary_task_limit >= 1 AND ordinary_task_limit <= 64));
ALTER TABLE qq_bindings ADD COLUMN input_anti_spam_enabled INTEGER CHECK (input_anti_spam_enabled IS NULL OR input_anti_spam_enabled IN (0, 1));
