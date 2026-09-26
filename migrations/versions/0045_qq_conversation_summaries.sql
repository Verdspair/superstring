-- QQ 会话的滚动摘要（用户 2026-09-26）：窗口/条数之外的老消息不再直接消失，而是压成事实存在这里。
--
-- 与网页的 session_summaries 是同一套事实契约（conversation_summary 证据：kind/lossy/coverage/facts），
-- 但会话维度不同——QQ 没有 session，所以**按 conversation 存一行**，窗口滑动时续写同一行
-- （through_seq 往后推），而不是像网页那样一段一行。
--
-- 压缩开关与预算仍取助手「长对话管理」里的设置（compression_enabled / summary_*），QQ 侧不新增设置。
CREATE TABLE qq_conversation_summaries (
  conversation_id TEXT NOT NULL PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- 已经压进 content 的最大事件序号；下一轮只把 seq 更大的老消息送去续写。
  through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
  content TEXT NOT NULL CHECK (json_valid(content)),
  model_name TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
