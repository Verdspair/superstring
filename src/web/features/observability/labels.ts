/** Stable codes are preserved in details; labels explain the operation to readers. */
export const stageLabels: Record<string, string> = {
  ingress: "消息接入",
  wake: "唤醒调度",
  context: "上下文读取",
  model: "模型调用",
  action: "Agent 行动",
  sticker: "表情选择",
  delivery: "消息投递",
  run: "Agent 运行",
  maintenance: "后台维护",
};
export const statusLabels: Record<string, string> = {
  observed: "已观察",
  scheduled: "已排期",
  deferred: "延后处理",
  skipped: "本次跳过",
  started: "进行中",
  completed: "已完成",
  no_output: "本次未发言",
  failed: "处理失败",
  cancelled: "已取消",
  unknown: "结果待确认",
};
export const channelLabels: Record<string, string> = {
  web: "网页对话",
  onebot11: "OneBot",
  memory: "记忆任务",
  knowledge: "知识任务",
  system: "系统任务",
};
export const detailLabels: Record<string, string> = {
  model: "模型",
  phase: "运行阶段",
  durationMs: "耗时（毫秒）",
  attempt: "尝试次数",
  target: "回应对象",
  selectedCount: "已选数量",
  candidateCount: "候选数量",
  reason: "原因",
  readyAt: "计划处理时间",
  throughSeq: "处理至事件序号",
  retryAt: "下次尝试时间",
};
export const operationLabels: Record<string, string> = {
  "agent.run": "Agent 运行",
  "agent.model": "模型调用",
  "context.read": "上下文读取",
  "agent.action": "Agent 行动",
  "onebot.ingress": "消息接入",
  "wake.scheduled": "唤醒排期",
  "wake.activate": "唤醒执行",
  "sticker.selected": "表情选择",
  "delivery.send": "消息投递",
  "memory.maintain": "记忆维护",
  "knowledge.maintain": "知识维护",
};
export const reasonLabels: Record<string, string> = {
  TRIGGER_DISABLED: "该触发方式已关闭",
  WINDOW_NOT_READY: "尚未到处理窗口",
  PROCESS_INTERRUPTED: "进程中断，结果待核对",
  OPERATION_FAILED: "操作未完成，查看关联步骤",
};
