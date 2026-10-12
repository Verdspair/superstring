ALTER TABLE qq_schemes
  ADD COLUMN burst_min_messages INTEGER NOT NULL DEFAULT 3
  CHECK (burst_min_messages >= 2 AND burst_min_messages <= 20);

ALTER TABLE qq_schemes
  ADD COLUMN burst_window_seconds INTEGER NOT NULL DEFAULT 3
  CHECK (burst_window_seconds >= 1 AND burst_window_seconds <= 30);

ALTER TABLE qq_bindings
  ADD COLUMN burst_min_messages INTEGER
  CHECK (burst_min_messages IS NULL OR (burst_min_messages >= 2 AND burst_min_messages <= 20));

ALTER TABLE qq_bindings
  ADD COLUMN burst_window_seconds INTEGER
  CHECK (burst_window_seconds IS NULL OR (burst_window_seconds >= 1 AND burst_window_seconds <= 30));
