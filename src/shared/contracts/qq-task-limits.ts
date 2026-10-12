/** Single source for persisted QQ task-count limits shared by scheme and task contracts. */
export const QQ_CONVERSATION_TASK_LIMIT_DEFAULTS = Object.freeze({
  mentionTaskLimit: 4,
  ordinaryTaskLimit: 1,
  min: 1,
  max: 64,
});
