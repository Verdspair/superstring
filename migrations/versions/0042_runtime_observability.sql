-- Local execution metadata. Prompt/response/media content remains in source-owned stores.
CREATE TABLE runtime_spans (
 id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
 trace_id TEXT NOT NULL,
 span_id TEXT NOT NULL UNIQUE,
 parent_span_id TEXT,
 name TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
 conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
 run_id TEXT REFERENCES agent_runs(run_id) ON DELETE CASCADE,
 wake_id TEXT,
 output_id TEXT,
 source_seq INTEGER,
 channel TEXT NOT NULL,
 stage TEXT NOT NULL,
 status TEXT NOT NULL,
 code TEXT NOT NULL,
 model TEXT,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 duration_ms REAL,
 expires_at TEXT NOT NULL,
 details TEXT NOT NULL CHECK (json_valid(details))
);
CREATE INDEX idx_runtime_spans_trace ON runtime_spans(trace_id, id);
CREATE INDEX idx_runtime_spans_scope ON runtime_spans(user_id, conversation_id, id);
CREATE INDEX idx_runtime_spans_filter ON runtime_spans(channel, stage, status, id);
CREATE INDEX idx_runtime_spans_expiry ON runtime_spans(expires_at);
CREATE INDEX idx_runtime_spans_run ON runtime_spans(run_id);
