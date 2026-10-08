# v0.4.0-alpha-2

[简体中文](#简体中文) · [English](#english)

## 简体中文

本次预发布版本引入 QQ 自主接话分批评估与预算开销修正、会话新消息即时呈现、群聊模型任务可视化观测、QQ 原生提及与引用段投递、方案与群配置界面整合，以及桌面端退出生命周期明确。以下变更直接对比已发布的 **v0.4.0-alpha-1**。

### QQ 自主接话分批与预算估算修正

- 新增自主接话分批计数控制（目标步长默认为 15，随机扰动量默认为 5，约束扰动量小于目标数）及忙时排队开关（默认开启），避免群聊高频触发无效评估。
- 修正批量判断估算上下文窗口时的预算过估与重复开销：由统一的批量消息构造器统一计算窗口拟合与实际发送请求，完整冻结来源列表全批共享一次，避免重复复制。
- 评分专属信息与回复运行解耦，回复子运行仅继承 reply 视图，避免批量评估裁剪影响回复工具预算；保留容量限制与原有裁剪顺序，超限时在模型调用前明确拒绝，不增加总容量配额，不引入自动重试或额外压缩。

### 会话新消息实时到达与任务可视化观测

- 旧历史读取期间，新到达的消息无需等待更早历史加载完成即可即时显示，无需手动刷新页面，已加载的内容与用户当前滚动位置保持不变。
- 群聊消息记录上方直观展示正在进行中的模型父任务状态（任一子任务处于运行状态即保持活跃指示）；点击父任务可打开详情，点击某个子任务查看该项详情，并在其结束时更新一次，不会预先拉取所有子任务正文。

### QQ 原生提及与引用段投递

- 用户提及与回复引用原生转换为 OneBot 协议的 `at` 与 `reply` 消息段投递。
- 提及与引用相互独立，支持仅提及回复；元数据挂载于首个实际投递部件（支持纯表情或纯提及回复），媒体段需经授权方案允许。
- 随包提供内置的 `speech.reply` 技能规范，明确回复中引用、提及与表情字段的交互约定（声明不越权授予外部工具）。
- 优化并发投递时的事务提交与状态恢复逻辑。

### 桌面端退出生命周期与运行查询优化

- 关闭桌面窗口直接结束程序自有进程树；常规服务停机仍先取消任务、处理在途写入并安全关闭数据库。
- 优化消息历史、任务与追踪读取，减少重复查询，加载更及时；优化早期工作区加载可用性。

### 方案与群配置界面整合

- 将本群专属覆盖设置融入方案工作流中，统一群绑定与方案管理入口，直观查看群专属覆盖项与继承状态。
- 改善方案与群配置保存时的状态与草稿处理，发生冲突时不会意外覆盖。

### 升级说明

升级前请完整退出程序并备份整个数据目录。业务数据库从结构版本 **53 升级至 54**（新增迁移 `0054_qq_initiative_batches.sql`）。回退需要旧版程序与**同一套匹配的升级前结构版本 53 数据与密钥备份**。详见 [UPGRADING.md](UPGRADING.md)。

---

## English

This release introduces batched QQ spontaneous participation with corrected budget estimation, immediate live message presentation, group chat model task observability, native QQ mention and reply quote delivery, integrated scheme and group directory configuration, and clear desktop lifecycle boundaries. Changes below compare directly with published **v0.4.0-alpha-1**.

### QQ Spontaneous Participation Batching and Corrected Budget Estimation

- Add configurable batch count controls (target count defaults to 15, jitter count defaults to 5 with jitter constrained below target) and a queue-on-busy switch (enabled by default), avoiding redundant evaluations in active group chats.
- Correct budget overestimation and repeated source overhead during batch judgement: unified batch constructor calculates both window fitting and actual requests, sharing the frozen context source list once across all targets instead of duplicating it.
- Decouple evaluation-specific context from reply runs so child reply runs inherit only the reply view, protecting reply tool budgets. Preserves capacity limits and original trimming order, explicitly rejecting requests before model calls when exceeding limits, without inflating total capacity, adding automatic retries, or extra compression.

### Real-time Live Messages and Conversation Task Observability

- Freshly arrived messages appear immediately without waiting for older history pagination to complete, leaving loaded rows and scroll position undisturbed.
- Surface active model parent tasks directly above message history in group chats whenever any child task is running; selecting the parent task opens the task chain, while selecting a child task inspects its detail and refreshes upon completion, without eagerly prefetching all child payloads.

### Native QQ Mention and Reply Quote Delivery

- Map user mentions and reply quotes natively to OneBot `at` and `reply` message segments.
- Keep mentions and quotes mutually independent (supporting mention-only replies); metadata attaches strictly to the first delivered carrier part (supporting sticker-only or mention-only replies), and media segments require authorization from the chat scheme.
- Bundle the built-in `speech.reply` skill specification, defining clear contracts for quotes, mentions, and stickers without escalating tool permissions.
- Refine transactional commit and state recovery during concurrent delivery.

### Desktop Lifecycle and Runtime Query Optimization

- Closing the desktop window directly terminates the application-owned process tree; standard service stops continue to cancel active tasks, settle in-flight writes, and close the database safely.
- Optimize message history, task, and trace reads, reducing redundant queries and improving load responsiveness; improve early workspace responsiveness.

### Integrated Schemes and Group Directory UI

- Incorporate per-group overrides into the scheme workflow, consolidating group binding management and clarifying override inheritance.
- Improve state and draft handling during scheme and group editing, preventing accidental overwrites when editing across tabs.

### Upgrading

Fully exit the application and back up your complete data directory before upgrading. Known databases migrate from schema **53 to 54** (via migration `0054_qq_initiative_batches.sql`). Rolling back requires the older application and a **matching pre-upgrade schema 53 data and key backup**. See [UPGRADING.md](UPGRADING.md).

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
