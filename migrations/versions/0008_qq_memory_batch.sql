-- Per-conversation trigger for organising a QQ conversation's memory (ADR0018 P2f).
--
-- The user's decision (2026-09-22): organising is triggered by a message COUNT, the
-- number is configurable, it can be switched off, and a manual "organise now" action
-- exists alongside it.
--
-- `memory_batch_size` is therefore a per-binding nullable integer:
--   * NULL  = automatic organising is OFF for this conversation (the default, so a
--             freshly bound group never spends model calls until asked), and
--   * >= 1  = organise once this many unread observations have accumulated.
--
-- It is deliberately per binding rather than a global default: an active group and a
-- quiet one need different counts, and the pause/share switches already live here.
-- Changing it is an ordinary revision (any valid modification), NOT an authority
-- change: it does not alter which assistant owns the memory or who may share it, so
-- it must not invalidate in-flight organisation the way an authority change does.

ALTER TABLE qq_bindings ADD COLUMN memory_batch_size INTEGER
  CHECK (memory_batch_size IS NULL OR memory_batch_size >= 1);
