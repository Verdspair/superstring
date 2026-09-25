# Pre-cutover behavior oracle

These fixed QQ pipeline modules are test-only snapshots from the PR2 cutover. Existing regression assertions remain executable against them as behavioral references. They are not production implementations, are not imported by src, and are not evidence that the new host itself passes those behaviors.

Production tests are `onebot-private-host`, `onebot-shared-host`, `bot-context-source`, `bot-wake-scheduler`, `bot-worker`, `runtime-onebot-direct`, `conversation-journal`, and generic AgentRuntime/source/lifecycle tests. The common production path is BotWorker → WakeScheduler → OneBotHost → ConversationHost → AgentRuntime, then OutboundDelivery. Source ingestion, prompts, rhythm, authority and output encoding retain their domain helpers.
