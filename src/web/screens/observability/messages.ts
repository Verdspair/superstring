export const resources = {
  "observability.sourceSequence": { zh: "来源序号", en: "Source sequence" },
  "observability.operationName": { zh: "操作名称", en: "Operation" },
  "observability.reasonCode": { zh: "原因代码", en: "Reason code" },
  "observability.startedAt": { zh: "开始时间", en: "Started at" },
  "observability.finishedAt": { zh: "完成时间", en: "Finished at" },
  "observability.compareTraces": {
    zh: "链路比较",
    en: "Compare traces",
  },
  "observability.selectACallOnEachSideContentIsAuthorizedIndependently": {
    zh: "分别选择两侧调用；正文各自核权，不自动推断对应关系。",
    en: "Select a call on each side. Content is authorized independently; matching is not inferred.",
  },
  "observability.backToExecutions": {
    zh: "返回执行记录",
    en: "Back to executions",
  },
  "observability.loadingRuns": {
    zh: "正在读取运行记录…",
    en: "Loading runs…",
  },
  "observability.selectACallToInspectItsEvidence": {
    zh: "选择一次调用，核对它的证据。",
    en: "Select a call to inspect its evidence.",
  },
  "observability.traceDetails": {
    zh: "追踪链路",
    en: "Trace details",
  },
  "observability.triggerNotRecorded": {
    zh: "触发类型未记录",
    en: "Trigger not recorded",
  },
  "observability.valueSteps": {
    zh: "{0} 个步骤",
    en: "{0} steps",
  },
  "observability.copied": {
    zh: "已复制",
    en: "Copied",
  },
  "observability.copyTraceId": {
    zh: "复制 Trace ID",
    en: "Copy Trace ID",
  },
  "observability.refreshThisTrace": {
    zh: "刷新当前链路",
    en: "Refresh this trace",
  },
  "observability.conversationIsNotLoadedInTheDirectory": {
    zh: "会话尚未载入目录",
    en: "Conversation is not loaded in the directory",
  },
  "observability.thisChainNoLongerMatchesTheFiltersTheFullChain": {
    zh: "当前链路已不匹配筛选；仍保留完整链路供核对。",
    en: "This chain no longer matches the filters; the full chain remains open for inspection.",
  },
  "observability.locateEvidence": {
    zh: "证据定位",
    en: "Locate evidence",
  },
  "observability.nextMatch": {
    zh: "下一个命中",
    en: "Next match",
  },
  "observability.investigationViews": {
    zh: "调查视图",
    en: "Investigation views",
  },
  "observability.fullTimeline": {
    zh: "全部时序",
    en: "Full timeline",
  },
  "observability.modelInvocation": {
    zh: "模型调用",
    en: "Model invocation",
  },
  "observability.outputsAndDelivery": {
    zh: "输出与送达",
    en: "Outputs and delivery",
  },
  "observability.thisTraceHasNoExternalDeliveryRecords": {
    zh: "此链路没有外部投递记录。",
    en: "This trace has no external delivery records.",
  },
  "observability.resizeTimelineAndInspector": {
    zh: "调整时间线与检查器大小",
    en: "Resize timeline and inspector",
  },
  "observability.evidenceWorkbench": {
    zh: "证据工作台",
    en: "Evidence workbench",
  },
  "observability.restoreLayout": {
    zh: "恢复布局",
    en: "Restore layout",
  },
  "observability.expandReader": {
    zh: "展开阅读",
    en: "Expand reader",
  },
  "observability.inputsAndOutputsAreLoadedOnlyWhenYouInspectThem": {
    zh: "输入与输出仅在你请求查看时读取。",
    en: "Inputs and outputs are loaded only when you inspect them.",
  },
  "observability.modelEvidence": {
    zh: "模型证据",
    en: "Model evidence",
  },
  "observability.recheckActualInputAndOutput": {
    zh: "重新核对实际输入与输出",
    en: "Recheck actual input and output",
  },
  "observability.inspectActualInputAndOutput": {
    zh: "查看实际输入与输出",
    en: "Inspect actual input and output",
  },
  "observability.hideActualInputAndOutput": {
    zh: "收起实际输入与输出",
    en: "Hide actual input and output",
  },
  "observability.checkingSourceAccessAndRetention": {
    zh: "正在核对来源权限与保留状态…",
    en: "Checking source access and retention…",
  },
  "observability.theExactTextInputIsAvailable": {
    zh: "可查看当时的精确文本输入。",
    en: "The exact text input is available.",
  },
  "observability.textIsAvailableSomeOriginalImageBytesCannotBeRetrieved": {
    zh: "文本可查看；部分图片原始字节不可重取，来源与校验值仍可核对。",
    en: "Text is available. Some original image bytes cannot be retrieved; source references and hashes remain available.",
  },
  "observability.sourceRetentionHasExpiredActualInputWasRemovedOnlyLayout": {
    zh: "来源保留期已结束，实际输入已清除；仅保留布局元数据。",
    en: "Source retention has expired. Actual input was removed; only layout metadata remains.",
  },
  "observability.sourcesWereRevokedOrDeletedActualInputIsUnavailableOnly": {
    zh: "来源已撤权或删除，实际输入不可查看；仅保留允许的元数据。",
    en: "Sources were revoked or deleted. Actual input is unavailable; only permitted metadata remains.",
  },
  "observability.sourceRetentionHasEndedModelOutputHasBeenCleared": {
    zh: "来源保留期已结束，模型输出已清除。",
    en: "Source retention has ended; model output has been cleared.",
  },
  "observability.sourceAccessWasRevokedOrDeletedModelOutputIsUnavailable": {
    zh: "来源已撤权或删除，模型输出不可查看。",
    en: "Source access was revoked or deleted; model output is unavailable.",
  },
  "observability.thisIsPartialModelOutputRetainedBeforeInterruption": {
    zh: "这是中断前保留的部分模型输出。",
    en: "This is partial model output retained before interruption.",
  },
  "observability.theModelCallHasNotFinished": {
    zh: "模型调用尚未结束。",
    en: "The model call has not finished.",
  },
  "observability.theModelReturnedNoPreservableText": {
    zh: "模型未返回可保留的正文。",
    en: "The model returned no preservable text.",
  },
  "observability.noModelOutputWasRetainedForThisStep": {
    zh: "此步骤没有保留模型输出。",
    en: "No model output was retained for this step.",
  },
  "observability.originalModelOutput": {
    zh: "模型返回的原始输出。",
    en: "Original model output.",
  },
  "observability.modelInputOutputAndSources": {
    zh: "模型输入输出与来源",
    en: "Model input, output, and sources",
  },
  "observability.modelInput": {
    zh: "模型输入",
    en: "Model input",
  },
  "observability.modelOutput": {
    zh: "模型输出",
    en: "Model output",
  },
  "observability.sourcesAndRevisions": {
    zh: "来源与版本",
    en: "Sources and revisions",
  },
  "observability.valueUnitsValueSources": {
    zh: "{0} 单位 · {1} 个来源",
    en: "{0} units · {1} sources",
  },
  "observability.messageValue": {
    zh: "消息 {0}",
    en: "Message {0}",
  },
  "observability.messageValueValue": {
    zh: "消息 {0} · {1}",
    en: "Message {0} · {1}",
  },
  "observability.imageSource": {
    zh: "图片来源",
    en: "Image source",
  },
  "observability.sourceRevision": {
    zh: "来源版本",
    en: "Source revision",
  },
  "observability.originalMediaBytesAreUnavailable": {
    zh: "媒体原始字节不可重取",
    en: "Original media bytes are unavailable",
  },
  "observability.sourceId": {
    zh: "来源 ID",
    en: "Source ID",
  },
  "observability.noAssociatedSourcesAreRecorded": {
    zh: "没有关联来源记录。",
    en: "No associated sources are recorded.",
  },
  "observability.actionDecision": {
    zh: "行动判断",
    en: "Action decision",
  },
  "observability.generateReply": {
    zh: "生成回复",
    en: "Generate reply",
  },
  "observability.singleTurnTask": {
    zh: "单轮任务",
    en: "Single-turn task",
  },
  "observability.imageUnderstanding": {
    zh: "图片理解",
    en: "Image understanding",
  },
  "observability.selectForComparison": {
    zh: "选择比较",
    en: "Select for comparison",
  },
  "observability.compareValue": {
    zh: "比较 {0}",
    en: "Compare {0}",
  },
  "observability.started": {
    zh: "开始时间",
    en: "Started",
  },
  "observability.taskAndTrigger": {
    zh: "任务与触发",
    en: "Task and trigger",
  },
  "observability.channel": {
    zh: "来源通道",
    en: "Channel",
  },
  "observability.status": {
    zh: "处理状态",
    en: "Status",
  },
  "observability.duration": {
    zh: "耗时",
    en: "Duration",
  },
  "observability.recordedModels": {
    zh: "记录模型",
    en: "Recorded models",
  },
  "observability.matchesSteps": {
    zh: "命中 / 步骤",
    en: "Matches / steps",
  },
  "observability.columns": {
    zh: "显示列",
    en: "Columns",
  },
  "observability.executions": {
    zh: "执行记录",
    en: "Executions",
  },
  "observability.parentSpanId": {
    zh: "父 Span ID",
    en: "Parent span ID",
  },
  "observability.conversationId": {
    zh: "会话 ID",
    en: "Conversation ID",
  },
  "observability.backToStepDetails": {
    zh: "返回步骤详情",
    en: "Back to step details",
  },
  "observability.stepInspector": {
    zh: "步骤检查器",
    en: "Step inspector",
  },
  "observability.actualRequestedModel": {
    zh: "实际请求模型",
    en: "Actual requested model",
  },
  "observability.requestedModel": {
    zh: "请求模型",
    en: "Requested model",
  },
  "observability.recordedModelUnverified": {
    zh: "记录模型（未验证）",
    en: "Recorded model (unverified)",
  },
  "observability.fallbackUsedRequestedModelValue": {
    zh: "已使用替补模型；请求模型：{0}",
    en: "Fallback used; requested model: {0}",
  },
  "observability.parentRun": {
    zh: "所属运行",
    en: "Parent run",
  },
  "observability.theOutcomeIsUnconfirmedNotFailedFollowTheTraceTo": {
    zh: "结果尚未确认，不等同于失败；请沿追踪链路核对后续结果。",
    en: "The outcome is unconfirmed, not failed. Follow the trace to check subsequent results.",
  },
  "observability.evidenceType": {
    zh: "证据类型",
    en: "Evidence type",
  },
  "observability.runAndMetadata": {
    zh: "运行与元数据",
    en: "Run and metadata",
  },
  "observability.deliveryDetails": {
    zh: "送达详情",
    en: "Delivery details",
  },
  "observability.connectionNotStarted": {
    zh: "连接未启动",
    en: "Connection not started",
  },
  "observability.connecting": {
    zh: "正在连接",
    en: "Connecting",
  },
  "observability.verifyingConnection": {
    zh: "正在验证连接",
    en: "Verifying connection",
  },
  "observability.connectionReady": {
    zh: "连接已就绪",
    en: "Connection ready",
  },
  "observability.connectionClosed": {
    zh: "连接已断开",
    en: "Connection closed",
  },
  "observability.connectionStatusUnavailable": {
    zh: "连接状态不可用",
    en: "Connection status unavailable",
  },
  "observability.connectionStatusUnknown": {
    zh: "连接状态未知",
    en: "Connection status unknown",
  },
  "observability.investigateConversationExecutions": {
    zh: "调查此会话的执行记录",
    en: "Investigate conversation executions",
  },
  "observability.currentProcessingState": {
    zh: "当前处理状态",
    en: "Current processing state",
  },
  "observability.valueActiveValueQueued": {
    zh: "进行中 {0} · 排队 {1}",
    en: "{0} active · {1} queued",
  },
  "observability.waitingWindowUntil": {
    zh: "等待窗口至",
    en: "Waiting window until",
  },
  "observability.earliestQueuedTime": {
    zh: "最早待处理时间",
    en: "Earliest queued time",
  },
  "observability.loadingProcessingState": {
    zh: "正在读取处理状态…",
    en: "Loading processing state…",
  },
  "observability.refreshProcessingState": {
    zh: "刷新处理状态",
    en: "Refresh processing state",
  },
  "observability.failedWakes": {
    zh: "处理失败的唤醒",
    en: "Failed wakes",
  },
  "observability.unconfirmedDeliveries": {
    zh: "结果待确认的投递",
    en: "Unconfirmed deliveries",
  },
  "observability.latestActivity": {
    zh: "最近活动",
    en: "Latest activity",
  },
  "observability.sampledAt": {
    zh: "刷新时间",
    en: "Sampled at",
  },
  "observability.executionWorkspace": {
    zh: "执行工作区",
    en: "Execution workspace",
  },
  "observability.observability": {
    zh: "运行观察",
    en: "Observability",
  },
  "observability.followAnActivityThroughEveryModelCallAndDelivery": {
    zh: "从一次活动，追到每次模型调用与送达。",
    en: "Follow an activity through every model call and delivery.",
  },
  "observability.resumeAutoRefresh": {
    zh: "恢复自动刷新",
    en: "Resume auto-refresh",
  },
  "observability.pauseAutoRefresh": {
    zh: "暂停自动刷新",
    en: "Pause auto-refresh",
  },
  "observability.refreshRuns": {
    zh: "刷新运行记录",
    en: "Refresh runs",
  },
  "observability.exportLoadedMetadata": {
    zh: "导出已加载元数据",
    en: "Export loaded metadata",
  },
  "observability.valueTraces": {
    zh: "共 {0} 条链路",
    en: "{0} traces",
  },
  "observability.valueActive": {
    zh: "活跃 {0}",
    en: "{0} active",
  },
  "observability.valueWithFailures": {
    zh: "含失败 {0}",
    en: "{0} with failures",
  },
  "observability.valueMatchingSpans": {
    zh: "{0} 个阶段命中",
    en: "{0} matching spans",
  },
  "observability.updatedAtValue": {
    zh: "刷新于 {0}",
    en: "Updated at {0}",
  },
  "observability.compareValueSelected": {
    zh: "比较已选 {0} 条",
    en: "Compare {0} selected",
  },
  "observability.noMatchingExecutions": {
    zh: "没有匹配的执行记录",
    en: "No matching executions",
  },
  "observability.noMatchingRecordsActivityBeforeTelemetryWasEnabledMayNot": {
    zh: "暂无匹配的运行记录；启用观测前的活动可能没有记录。",
    en: "No matching records. Activity before telemetry was enabled may not be recorded.",
  },
  "observability.valueTracesLoaded": {
    zh: "已加载 {0} 条链路",
    en: "{0} traces loaded",
  },
  "observability.onlyAffectsThisViewTheAgentContinuesRunning": {
    zh: "仅影响此视图，不暂停 Agent。",
    en: "Only affects this view; the Agent continues running.",
  },
  "observability.loadEarlierRuntimeRecords": {
    zh: "加载更早运行记录",
    en: "Load earlier runtime records",
  },
  "observability.expandChildrenOfValue": {
    zh: "展开 {0} 的子步骤",
    en: "Expand children of {0}",
  },
  "observability.collapseChildrenOfValue": {
    zh: "折叠 {0} 的子步骤",
    en: "Collapse children of {0}",
  },
  "observability.viewInputOutputAndDetails": {
    zh: "查看输入、输出与详情",
    en: "View input, output and details",
  },
  "observability.viewStepDetails": {
    zh: "查看步骤详情",
    en: "View step details",
  },
  "observability.parentStepIsNotRetainedOrAccessible": {
    zh: "父步骤未保留或不可访问",
    en: "Parent step is not retained or accessible",
  },
  "observability.expandAllSteps": {
    zh: "展开全部步骤",
    en: "Expand all steps",
  },
  "observability.collapseAllSteps": {
    zh: "折叠全部步骤",
    en: "Collapse all steps",
  },
  "observability.parentAndChildTiming": {
    zh: "父子时序图",
    en: "Parent and child timing",
  },
  "observability.findInThisContent": {
    zh: "查找当前正文",
    en: "Find in this content",
  },
  "observability.nextMatch_223fc": {
    zh: "下一处",
    en: "Next match",
  },
  "observability.wrapLines": {
    zh: "自动换行",
    en: "Wrap lines",
  },
  "observability.copyOriginal": {
    zh: "复制原文",
    en: "Copy original",
  },
  "observability.valueMatches": {
    zh: "{0} 处匹配",
    en: "{0} matches",
  },
  "observability.couldNotCopySelectTheContentToCopyIt": {
    zh: "复制失败，请选择正文复制。",
    en: "Could not copy. Select the content to copy it.",
  },
  "observability.contentReader": {
    zh: "正文阅读区",
    en: "Content reader",
  },
  "observability.task": {
    zh: "任务",
    en: "Task",
  },
  "observability.runPhase": {
    zh: "运行阶段",
    en: "Run phase",
  },
  "observability.model": {
    zh: "模型",
    en: "Model",
  },
  "observability.inspectCall": {
    zh: "检查调用",
    en: "Inspect call",
  },
  "observability.messageIntake": {
    zh: "消息接入",
    en: "Message intake",
  },
  "observability.wakeScheduling": {
    zh: "唤醒调度",
    en: "Wake scheduling",
  },
  "observability.contextRetrieval": {
    zh: "上下文读取",
    en: "Context retrieval",
  },
  "observability.agentAction": {
    zh: "Agent 行动",
    en: "Agent action",
  },
  "observability.stickerSelection": {
    zh: "表情选择",
    en: "Sticker selection",
  },
  "observability.messageDelivery": {
    zh: "消息投递",
    en: "Message delivery",
  },
  "observability.agentRun": {
    zh: "Agent 运行",
    en: "Agent run",
  },
  "observability.backgroundMaintenance": {
    zh: "后台维护",
    en: "Background maintenance",
  },
  "observability.observed": {
    zh: "已观察",
    en: "Observed",
  },
  "observability.scheduled": {
    zh: "已排期",
    en: "Scheduled",
  },
  "observability.deferred": {
    zh: "延后处理",
    en: "Deferred",
  },
  "observability.skipped": {
    zh: "本次跳过",
    en: "Skipped",
  },
  "observability.inProgress": {
    zh: "进行中",
    en: "In progress",
  },
  "observability.completed": {
    zh: "已完成",
    en: "Completed",
  },
  "observability.noResponseThisTime": {
    zh: "本次未发言",
    en: "No response this time",
  },
  "observability.processingFailed": {
    zh: "处理失败",
    en: "Processing failed",
  },
  "observability.cancelled": {
    zh: "已取消",
    en: "Cancelled",
  },
  "observability.resultUnconfirmed": {
    zh: "结果待确认",
    en: "Result unconfirmed",
  },
  "observability.webChat": {
    zh: "网页对话",
    en: "Web chat",
  },
  "observability.memoryTask": {
    zh: "记忆任务",
    en: "Memory task",
  },
  "observability.knowledgeTask": {
    zh: "知识任务",
    en: "Knowledge task",
  },
  "observability.systemTask": {
    zh: "系统任务",
    en: "System task",
  },
  "observability.actualModelConfirmed": {
    zh: "已确认实际模型",
    en: "Actual model confirmed",
  },
  "observability.durationMs": {
    zh: "耗时（毫秒）",
    en: "Duration (ms)",
  },
  "observability.attempt": {
    zh: "尝试次数",
    en: "Attempt",
  },
  "observability.recipient": {
    zh: "回应对象",
    en: "Recipient",
  },
  "observability.selectedCount": {
    zh: "已选数量",
    en: "Selected count",
  },
  "observability.candidateCount": {
    zh: "候选数量",
    en: "Candidate count",
  },
  "observability.reason": {
    zh: "原因",
    en: "Reason",
  },
  "observability.scheduledProcessingTime": {
    zh: "计划处理时间",
    en: "Scheduled processing time",
  },
  "observability.processedThroughSequence": {
    zh: "处理至事件序号",
    en: "Processed through sequence",
  },
  "observability.nextAttemptAt": {
    zh: "下次尝试时间",
    en: "Next attempt at",
  },
  "observability.webMainAgent": {
    zh: "网页主 Agent",
    en: "Web main Agent",
  },
  "observability.onebotMainAgent": {
    zh: "OneBot 主 Agent",
    en: "OneBot main Agent",
  },
  "observability.memorySelection": {
    zh: "记忆筛选",
    en: "Memory selection",
  },
  "observability.memoryOrganising": {
    zh: "记忆整理",
    en: "Memory organising",
  },
  "observability.memorySuppressionEvaluation": {
    zh: "记忆抑制判断",
    en: "Memory suppression evaluation",
  },
  "observability.knowledgeSelection": {
    zh: "知识筛选",
    en: "Knowledge selection",
  },
  "observability.knowledgeOrganization": {
    zh: "知识整理",
    en: "Knowledge organization",
  },
  "observability.contextCompression": {
    zh: "上下文压缩",
    en: "Context compression",
  },
  "observability.initiativeEvaluation": {
    zh: "主动发言判断",
    en: "Initiative evaluation",
  },
  "observability.directReplies": {
    zh: "直接回应",
    en: "Direct replies",
  },
  "observability.ongoingConversation": {
    zh: "连续交谈",
    en: "Ongoing conversation",
  },
  "observability.chimingIn": {
    zh: "自主接话",
    en: "Chiming in",
  },
  "observability.openingAQuietRoom": {
    zh: "冷场发起",
    en: "Opening a quiet room",
  },
  "observability.webRequest": {
    zh: "网页请求",
    en: "Web request",
  },
  "observability.conversationActivation": {
    zh: "会话激活",
    en: "Conversation activation",
  },
  "observability.replyPreparation": {
    zh: "回复准备",
    en: "Reply preparation",
  },
  "observability.agentCheckpoint": {
    zh: "Agent 检查点",
    en: "Agent checkpoint",
  },
  "observability.replyCommit": {
    zh: "回复提交",
    en: "Reply commit",
  },
  "observability.mediaUnderstandingIntake": {
    zh: "媒体理解接入",
    en: "Media understanding intake",
  },
  "observability.wakeOpportunityRegistration": {
    zh: "唤醒机会登记",
    en: "Wake opportunity registration",
  },
  "observability.wakeExecution": {
    zh: "唤醒执行",
    en: "Wake execution",
  },
  "observability.wakeLeaseRecovery": {
    zh: "唤醒租约恢复",
    en: "Wake lease recovery",
  },
  "observability.wakeRecordRecovery": {
    zh: "唤醒记录恢复",
    en: "Wake record recovery",
  },
  "observability.agentReconsiderationFeedback": {
    zh: "Agent 复核反馈",
    en: "Agent reconsideration feedback",
  },
  "observability.partDelivery": {
    zh: "分段投递",
    en: "Part delivery",
  },
  "observability.memoryTaskRecovery": {
    zh: "记忆任务恢复",
    en: "Memory task recovery",
  },
  "observability.memoryTaskClaim": {
    zh: "记忆任务领取",
    en: "Memory task claim",
  },
  "observability.memoryMaintenance": {
    zh: "记忆维护",
    en: "Memory maintenance",
  },
  "observability.memorySourceReading": {
    zh: "记忆来源读取",
    en: "Memory source reading",
  },
  "observability.memoryResultPublication": {
    zh: "记忆结果入库",
    en: "Memory result publication",
  },
  "observability.knowledgeTaskRecovery": {
    zh: "知识任务恢复",
    en: "Knowledge task recovery",
  },
  "observability.knowledgeTaskInvalidation": {
    zh: "知识任务失效",
    en: "Knowledge task invalidation",
  },
  "observability.knowledgeTaskWaiting": {
    zh: "知识任务等待",
    en: "Knowledge task waiting",
  },
  "observability.knowledgeMaintenance": {
    zh: "知识维护",
    en: "Knowledge maintenance",
  },
  "observability.knowledgeSourceReading": {
    zh: "知识来源读取",
    en: "Knowledge source reading",
  },
  "observability.knowledgeResultPublication": {
    zh: "知识结果入库",
    en: "Knowledge result publication",
  },
  "observability.wakeScheduled": {
    zh: "唤醒排期",
    en: "Wake scheduled",
  },
  "observability.thisTriggerIsDisabled": {
    zh: "该触发方式已关闭",
    en: "This trigger is disabled",
  },
  "observability.theProcessingWindowHasNotStarted": {
    zh: "尚未到处理窗口",
    en: "The processing window has not started",
  },
  "observability.processInterruptedOutcomeNeedsConfirmation": {
    zh: "进程中断，结果待核对",
    en: "Process interrupted; outcome needs confirmation",
  },
  "observability.operationDidNotCompleteInspectRelatedSteps": {
    zh: "操作未完成，查看关联步骤",
    en: "Operation did not complete; inspect related steps",
  },
  "observability.invalidFiltersCheckValueLengthCorrelationIdsAndTimestamps": {
    zh: "筛选值无效，请检查长度、关联 ID 或时间。",
    en: "Invalid filters. Check value length, correlation IDs and timestamps.",
  },
  "observability.all": {
    zh: "全部",
    en: "All",
  },
  "observability.searchRuntimeRecords": {
    zh: "搜索运行记录",
    en: "Search runtime records",
  },
  "observability.reasonNameCorrelationIdOrMetadataKeyword": {
    zh: "原因、名称、关联 ID 或元数据关键词",
    en: "Reason, name, correlation ID or metadata keyword",
  },
  "observability.addFilter": {
    zh: "添加筛选",
    en: "Add filter",
  },
  "observability.stage": {
    zh: "处理阶段",
    en: "Stage",
  },
  "observability.modelExactMatch": {
    zh: "模型（精确匹配）",
    en: "Model (exact match)",
  },
  "observability.startTimeLocal": {
    zh: "开始时间（本地）",
    en: "Start time (local)",
  },
  "observability.endTimeLocal": {
    zh: "结束时间（本地）",
    en: "End time (local)",
  },
  "observability.currentTimeZoneValue": {
    zh: "当前时区：{0}",
    en: "Current time zone: {0}",
  },
  "observability.last15Minutes": {
    zh: "最近 15 分钟",
    en: "Last 15 minutes",
  },
  "observability.lastHour": {
    zh: "最近 1 小时",
    en: "Last hour",
  },
  "observability.last24Hours": {
    zh: "最近 24 小时",
    en: "Last 24 hours",
  },
  "observability.applyFilters": {
    zh: "应用筛选",
    en: "Apply filters",
  },
  "observability.search": {
    zh: "搜索",
    en: "Search",
  },
  "observability.appliedFilters": {
    zh: "已应用筛选",
    en: "Applied filters",
  },
  "observability.allActivity": {
    zh: "全部活动",
    en: "All activity",
  },
  "observability.removeFilterValue": {
    zh: "移除筛选 {0}",
    en: "Remove filter {0}",
  },
  "observability.clearFilters": {
    zh: "清除筛选",
    en: "Clear filters",
  },
  "observability.searchAllRecordedRuntimeMetadataExcludingMessageAndPromptContents": {
    zh: "搜索全部已记录的运行元数据，不搜索消息或提示词正文。",
    en: "Search all recorded runtime metadata, excluding message and prompt contents.",
  },
  "observability.waiting": {
    zh: "等待处理",
    en: "Waiting",
  },
  "observability.preparing": {
    zh: "正在准备",
    en: "Preparing",
  },
  "observability.readingSources": {
    zh: "正在读取资料",
    en: "Reading sources",
  },
  "observability.replying": {
    zh: "正在回复",
    en: "Replying",
  },
  "observability.runCompleted": {
    zh: "运行已完成",
    en: "Run completed",
  },
  "observability.runFailed": {
    zh: "运行失败",
    en: "Run failed",
  },
  "observability.runCancelled": {
    zh: "运行已取消",
    en: "Run cancelled",
  },
  "observability.processing": {
    zh: "正在处理",
    en: "Processing",
  },
  "observability.understandingImages": {
    zh: "正在理解图片",
    en: "Understanding images",
  },
  "observability.runDetails": {
    zh: "运行详情",
    en: "Run details",
  },
  "observability.inspectModelBehaviorByAttemptAndCall": {
    zh: "按尝试与调用核对模型行为。",
    en: "Inspect model behavior by attempt and call.",
  },
  "observability.closeRunDetails": {
    zh: "关闭运行详情",
    en: "Close run details",
  },
  "observability.close": {
    zh: "关闭",
    en: "Close",
  },
  "observability.runAttempt": {
    zh: "运行尝试",
    en: "Run attempt",
  },
  "observability.noRecordedRunsYetQueuedTasksAndTasksBeforeMigration": {
    zh: "此任务暂无运行记录；排队任务与迁移前任务可能尚未留下记录。",
    en: "No recorded runs yet. Queued tasks and tasks before migration may have no run record.",
  },
  "observability.selectedRunDetails": {
    zh: "选中运行的详情",
    en: "Selected run details",
  },
  "observability.runCompletionMeansTheModelTaskFinishedExternalMessageDelivery": {
    zh: "运行完成表示模型任务已完成；外部消息的送达结果单独记录。",
    en: "Run completion means the model task finished. External message delivery is recorded separately.",
  },
  "observability.modelSteps": {
    zh: "模型步骤",
    en: "Model steps",
  },
  "observability.stepValueValue": {
    zh: "步骤 {0} · {1}",
    en: "Step {0} · {1}",
  },
  "observability.running": {
    zh: "执行中",
    en: "Running",
  },
  "observability.noModelStepHasStartedYet": {
    zh: "尚未开始模型步骤。",
    en: "No model step has started yet.",
  },
  "observability.waitingToSend": {
    zh: "等待发送",
    en: "Waiting to send",
  },
  "observability.delivering": {
    zh: "正在送达",
    en: "Delivering",
  },
  "observability.delivered": {
    zh: "已送达",
    en: "Delivered",
  },
  "observability.deliveryFailed": {
    zh: "发送失败",
    en: "Delivery failed",
  },
  "observability.deliveryOutcomeUnconfirmed": {
    zh: "发送结果待确认",
    en: "Delivery outcome unconfirmed",
  },
  "observability.replyExpired": {
    zh: "回复已过期",
    en: "Reply expired",
  },
  "observability.notSent": {
    zh: "尚未发送",
    en: "Not sent",
  },
  "observability.deliveryResults": {
    zh: "送达结果",
    en: "Delivery results",
  },
  "observability.somePartsWereDeliveredCheckEachPartSOutcome": {
    zh: "部分内容已送达，请查看各部分结果。",
    en: "Some parts were delivered. Check each part's outcome.",
  },
  "observability.refreshDeliveryResult": {
    zh: "刷新送达结果",
    en: "Refresh delivery result",
  },
  "observability.loadingDeliveryResult": {
    zh: "正在读取送达结果…",
    en: "Loading delivery result…",
  },
  "observability.destinationConversation": {
    zh: "送达会话",
    en: "Destination conversation",
  },
  "observability.recipientInformationWasNotRecorded": {
    zh: "目标信息未记录",
    en: "Recipient information was not recorded",
  },
  "observability.recipient_138f8": {
    zh: "回应成员",
    en: "Recipient",
  },
  "observability.deliveryDeadline": {
    zh: "发送时限",
    en: "Delivery deadline",
  },
  "observability.contentType": {
    zh: "内容类型",
    en: "Content type",
  },
  "observability.platformMessageId": {
    zh: "平台消息 ID",
    en: "Platform message ID",
  },
  "observability.text": {
    zh: "文本",
    en: "Text",
  },
  "observability.sticker": {
    zh: "表情",
    en: "Sticker",
  },
  "observability.thePlatformReceiptIsUnconfirmedThisViewOnlyChecksIts": {
    zh: "尚未确认外部平台是否已收到；此处仅核对结果。",
    en: "The platform receipt is unconfirmed. This view only checks its status.",
  },
  "observability.traceId": {
    zh: "Trace ID",
    en: "Trace ID",
  },
  "observability.spanId": {
    zh: "Span ID",
    en: "Span ID",
  },
  "observability.runId": {
    zh: "Run ID",
    en: "Run ID",
  },
  "observability.wakeId": {
    zh: "Wake ID",
    en: "Wake ID",
  },
  "observability.outputId": {
    zh: "Output ID",
    en: "Output ID",
  },
  "observability.agentId": {
    zh: "Agent ID",
    en: "Agent ID",
  },
} as const;
