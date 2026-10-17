ALTER TABLE qq_schemes ADD COLUMN participation_timing TEXT NOT NULL DEFAULT 'resource_window'
  CHECK (participation_timing IN ('resource_window', 'quiet_preferred'));
