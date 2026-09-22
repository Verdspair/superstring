# v0.2.1

[English](#english) · [简体中文](#简体中文)

## English

Changes relative to the published `v0.2.0-alpha`. Full before/after tables and upgrade steps: [UPGRADING.md](UPGRADING.md).

### New

- **Knowledge library:** import text/Markdown or paste text, edit originals, organize by category, and authorize assistants individually or in batches. Imports are not authorized by default.
- **Knowledge organization and reading:** generate drafts with linked source passages, then let each assistant use original or organized content, all authorized documents or a subset, and its own budget. Retries recheck access after revocation.
- **Memory correction:** edit remembered content and view its sources without deleting the original conversation.
- **Context usage:** the ring beside the chat input shows estimated usage, model capacity, and the input breakdown; unknown capacity stays unknown.
- **Shared organization model:** one default for memory and knowledge organization, with separate overrides.

### Improved

- Settings use left navigation and top tabs with expanded parameter groups, jump links, and per-page saving that keeps drafts across pages without carrying other pages' unsaved edits.
- Conversation, retrieval, organization, and compression models are selected in one place; assistant and long-term memory management are consolidated on their own pages.
- Selection states, spacing, panels, and labels are more consistent across settings and management views.
- Defaults rise across the board — recent turns 6 → 10, summary 1024 → 2048, memory target 300 → 1200 characters, recall presets raised to 30/6/2048, 60/10/4096 and 120/16/8192, auxiliary timeout 300 → 900 s, model-call timeout 60 → 1200 s, organization budget 600 → 3600 s and idle limit 10 → 120 s — and the new knowledge library starts at a 16384-unit context budget, while existing values are kept.

### Fixed

- Fixed long replies and memory organization being cut off at 60 seconds, and connections dropping before the first token arrived.
- Fixed cases where an occupied port made the app unusable.
- Fixed LM Studio authentication failing entirely and authorization errors being reported as a disconnected service.
- Fixed failure messages covering the retry button.
- Fixed delayed memory responses overwriting a newer view, and memory source, list, and pagination state going out of sync.
- Fixed budget edits not refreshing the capacity preview, and malformed stored configuration silently falling back to defaults.

### Upgrading

Close the app, back up `userdata`, and install the new package into the same directory. Known schema-1 databases migrate to schema 4, keeping conversations, memories, and settings; unsupported structures and downgrades are rejected. Review model settings and authorize imported documents. Set `LM_STUDIO_API_KEY` if your LM Studio requires a token.

---

## 简体中文

相对已发布 `v0.2.0-alpha` 的更新。完整前后对照表和升级步骤见 [UPGRADING.md](UPGRADING.md)。

### 新增

- **知识库：** 导入文本、Markdown 或粘贴内容，编辑原文、分类管理，并按助手逐份或批量授权；导入不会自动授权。
- **资料整理与读取：** 生成带原文来源的整理稿，助手可选择原文或整理内容、全部授权资料或指定子集，并使用独立预算；撤权后重试重新检查权限。
- **记忆内容纠正：** 修改记错的内容并查看来源，无需删除原聊天记录。
- **上下文用量：** 输入框旁的圆环展示估算用量、模型容量和输入组成，未知容量显示为未知。
- **共同默认整理模型：** 记忆与知识库共用一个默认模型，也可分别覆盖。

### 改进

- 设置改为左侧导航与顶部页签，参数分组展开、长页面提供锚点；按页保存，跨页保留草稿，且不夹带其他页未保存的修改。
- 对话、读取、整理、压缩模型集中一处选择；助手管理和长期记忆管理各自集中到对应页面。
- 统一设置与管理页的选中状态、间距、面板和说明文字。
- 默认参数整体上调——近期原文 6 → 10 轮、摘要 1024 → 2048、记忆整理 300 → 1200 字、检索预设调整为 30/6/2048、60/10/4096、120/16/8192、辅助调用超时 300 → 900 秒、模型调用超时 60 → 1200 秒、整理任务预算 600 → 3600 秒、空闲上限 10 → 120 秒——新增知识库默认上下文预算 16384 单位，已有数值保持不变。

### 修复

- 修复了长回答和记忆整理在 60 秒后被截断、以及模型尚未输出首字就断开连接的问题。
- 修复了部分情况下端口被占用导致软件无法使用的问题。
- 修复了 LM Studio 鉴权无法使用、以及鉴权失败被误报为服务未连接的问题。
- 修复了失败提示遮挡“重试原请求”按钮的问题。
- 修复了迟到的记忆响应覆盖新页面，以及记忆来源、列表与分页状态不同步的问题。
- 修复了修改预算不刷新容量预览，以及损坏的已存配置静默改用默认值的问题。

### 升级

关闭应用、备份 `userdata`，将新版安装包安装到原目录。已知结构版本 1 的数据库迁移到 4，保留会话、记忆和设置；不支持的结构与降级会被拒绝。检查模型设置并授权已导入的资料；LM Studio 需要 token 时设置 `LM_STUDIO_API_KEY`。

---

## Thanks / 致谢

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for continued support, the macOS/Linux source launcher contributed in [#1](https://github.com/Verdspair/superstring/pull/1), and for reporting that an occupied port could make the app unusable in some cases.

感谢 [nkanf-dev](https://github.com/nkanf-dev) 的持续支持，以及在 [#1](https://github.com/Verdspair/superstring/pull/1) 中贡献 macOS/Linux 源码启动入口；也感谢他发现部分情况下端口被占用导致软件无法使用的问题。
