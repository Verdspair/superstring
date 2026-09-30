-- QQ 统一保留期限（1..3650 天，默认 14）：观察正文、语音、发送、昵称与素材备注共用的过期天数，只作用于新写入的行。
ALTER TABLE qq_settings
  ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 14 CHECK (retention_days >= 1 AND retention_days <= 3650);
