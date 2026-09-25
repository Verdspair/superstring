-- P5i: the media purpose models (global) and a tag draft for sticker annotations.
--
-- The two purposes sit on the SHARED settings row, not per assistant: annotating a sticker is a
-- QQ-wide operation that belongs to no assistant (the library does not follow the assistant being
-- configured), and reading media inside QQ uses the same pair. P4b decided what happens when they
-- are unset: unconfigured means "cannot understand" — never a fallback to the conversation model,
-- because a text model describing a picture writes fiction.
ALTER TABLE organization_settings ADD COLUMN vision_model_name TEXT;
ALTER TABLE organization_settings ADD COLUMN transcription_model_name TEXT;

-- The model's tag suggestions need somewhere to wait for review, just like its description: §9.2
-- says the model only produces drafts and the user saves what they approve, and the description
-- draft column already keeps that promise for one half of "生成说明和标签".
ALTER TABLE qq_sticker_assets ADD COLUMN tags_draft TEXT;
