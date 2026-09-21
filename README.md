# superstring · 超弦 — Update guide / 升级说明

[English](#english) · [简体中文](#简体中文)

## English

**Comparison baseline:** the published `v0.2.0-alpha` release. This guide describes changes in the current development source relative to that release.

**Version:** `0.2.1`.

The main additions are a permission-controlled knowledge library, editable long-term memories, and a context-usage panel. Settings and model selection have been reorganized, with fixes for interrupted generation, model authentication, and memory-page state.

### 1. New features

| Feature | Previous release | This update |
|---|---|---|
| Knowledge library | No document library | Import UTF-8 `.txt` / `.md` files or paste text; retain and edit originals; organize documents into categories |
| Document permissions | No per-document assistant access | Grant or revoke access per assistant, individually or in batches; importing does not automatically grant access |
| Knowledge organization and retrieval | No knowledge-library retrieval pipeline | Generate organized drafts, inspect linked source passages, and choose original or organized content; use original passages when no valid draft exists |
| Assistant-specific knowledge reading | Not available | Enable or disable reading, use all authorized documents or a selected subset, and override the context budget per assistant |
| Memory correction | Memory management without a content-correction workflow | Edit incorrect memory content and inspect its sources, without deleting the original conversation |
| Context-usage panel | No usage ring beside the chat input | Open the ring to inspect estimated usage, loaded model capacity, and the input breakdown; unknown capacity is shown as unknown |
| Shared organization model | No shared default across memory and knowledge organization | Set one common default, with separate assistant and knowledge-library overrides |

**Where to find them:** Knowledge library → **Settings → Memory → Knowledge settings**; memory correction → **Memory → Long-term memory**; model selection → **Quick management → Default models**.

Knowledge access is checked again on retry. If a referenced document has been revoked or deleted, send a new request using current permissions.

### 2. Improvements to existing features

| Area | Previous release | This update |
|---|---|---|
| Settings navigation | Assistant configuration spread across lettered sections and detailed settings | Left-side categories and top tabs; grouped parameters stay expanded, with jump links for long pages |
| Model selection | Conversation, memory-reading, organization, and compression models configured in separate places | Select all model roles on the Default models page; feature pages retain their rules and budgets |
| Assistant management | Assistant identity and configuration controls split across views | Select the editing target from a dropdown or list; manage identity, creation, deletion, and the new-conversation choice together |
| Saving settings | Configuration saved through the old section structure | Save each page's field group independently; retain drafts across pages and on conflicts; do not include another page's unsaved changes |
| Memory management | Reading rules, organization settings, and management controls spread across sections | Group reading, manual/automatic organization, and stored-memory management on the Long-term memory page |
| Appearance | Existing theme system and mixed layout density | More consistent selection states, form spacing, panel styling, and concise labels across settings and management views |

Default values are raised across the board — recent turns 6 → 10, summary target 1024 → 2048 units, memory-organization target 300 → 1200 characters, the three recall presets 15/3/1024 → 30/6/2048, 30/5/2048 → 60/10/4096 and 60/8/4096 → 120/16/8192, auxiliary-call timeout 300 → 900 seconds, model-call timeout 60 → 1200 seconds, organization-task budget 600 → 3600 seconds and server idle limit 10 → 120 seconds — the new knowledge library starts at a 16384-unit context budget, these values compare the published release directly with the current source, and existing saved settings and environment overrides are kept.

Saved assistant settings still apply to the next new turn; retrying the original request retains its original configuration. This behavior is preserved, not newly introduced.

### 3. Bug fixes

- **Long replies and memory organization stopped after 60 seconds.** The model transport timer previously ended an otherwise active request at that limit. Its default is now 1200 seconds, allowing slower generation and organization to continue. It remains a total-call limit, including the streamed response, not an unlimited wait.
- **Generation disconnected before the first text arrived.** The server previously used a 10-second idle limit, which could close a connection during model preparation. The idle limit is now 120 seconds; it is separate from the model-call timeout.
- **An occupied port could make the app unusable.** In some cases the desktop launcher could not bind its preferred port and the app failed to start. It now selects a free port and opens the matching address without stopping other software.
- **LM Studio authentication prevented normal use.** The previous gateway used a fixed token, and capacity detection omitted authentication. Set `LM_STUDIO_API_KEY` to use your token consistently for model listing, capacity detection, and generation.
- **Authentication failures looked like a disconnected model service.** HTTP 401/403 now produce token-setting guidance; the source-launch precheck distinguishes authorization failure from an unreachable server.
- **Failure messages covered the retry button.** Messages now sit above the chat input instead of floating over the retry controls.
- **Delayed memory requests could update the wrong view after switching assistants or pages.** Stale success and failure responses no longer replace the current list, details, or status message.
- **Memory source selection and displayed turns could get out of sync after leaving and returning.** Source, list, and pagination state now reset together.
- **Changing a budget did not immediately update the capacity preview.** Once capacity is known, budget edits recalculate the preview locally; switching assistants refreshes the capacity check even when the model is the same.
- **Malformed stored assistant configuration could silently fall back to defaults.** Invalid stored configurations now return a configuration error rather than producing an unintended request configuration; valid older configurations remain readable.

### 4. Changed or removed behavior

- **Removed automatic reinsertion of original conversation passages during summary reading.** Original chat history is retained; recent-turn context, summary compression, long-term memory, and knowledge retrieval remain available.
- Removed the old lettered assistant-navigation sections and duplicate configuration controls in favor of the unified settings pages.
- English and Simplified Chinese, 16 themes, conversation context menus, and macOS/Linux source launchers already existed. They remain supported and are not counted as new features here.

### 5. Upgrading and configuration

1. Fully close the application and back up `userdata`. Run the new installer against the same installation directory; do not delete the old database to create a new one.
2. The update adds knowledge and model-setting structures, migrating known databases from schema 1 to schema 4 while retaining conversations, memories, and saved settings. Unsupported structures and downgrades are rejected. Historical default values were only changed during development and never shipped, so no released version is affected.
3. Review **Quick management → Default models**, import reference material in **Memory → Knowledge settings**, and explicitly authorize the assistants that may use it. Upgrading does not overwrite existing values; to adopt the larger defaults, save the affected settings yourself.

For an LM Studio server with **Require API token** enabled, set the token before launching. PowerShell example:

```powershell
$env:LM_STUDIO_API_KEY = "your-lm-studio-token"
& "D:\superstring\superstring.exe"
```

This sets the token for that launch only. For shortcut launches, add `LM_STUDIO_API_KEY` to Windows user environment variables and sign out and back in. The default model endpoint remains `http://127.0.0.1:1234/v1`.

### Downloads and source use

Windows x64 packages are available from [Releases](https://github.com/Verdspair/superstring/releases). Installed copies include the application runtime, but not LM Studio or model weights.

For source use, install Node.js 22.12.0 or newer, run `npm ci`, then launch `start.cmd` on Windows or `./start.sh` on macOS/Linux. Source-launch processes stop with Ctrl+C in the terminal.

The project's own code uses the [MIT License](LICENSE); third-party notices are in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

---

## 简体中文

**对比基线：** 已发布的 `v0.2.0-alpha`。本文说明当前开发源码相对该版本的变化。

**版本：** `0.2.1`。

本次主要新增带授权管理的知识库、长期记忆内容纠正、上下文用量面板；重组设置和模型配置入口，并修复生成中断、模型鉴权、记忆页面状态等问题。

### 1. 新功能

| 功能 | 上一版 | 本次更新 |
|---|---|---|
| 知识库 | 没有资料库 | 导入 UTF-8 `.txt`、`.md` 文件或粘贴文本，保留和编辑原文，按分类管理资料 |
| 资料授权 | 没有按资料划分的助手权限 | 按助手逐份或批量授予、撤回访问权限；导入不等于自动授权 |
| 资料整理与检索 | 没有知识库检索流程 | 生成整理稿，查看对应原文片段，选择使用原文或整理内容；无有效整理稿时读取原文片段 |
| 助手独立读取配置 | 不支持 | 每个助手可开关知识库读取，选择全部授权资料或指定子集，并单独覆盖上下文预算 |
| 记忆内容纠正 | 可以管理记忆，但没有内容纠正流程 | 直接修改记错的内容并查看来源，不需要删除原聊天记录 |
| 上下文用量面板 | 输入框旁没有用量圆环 | 点击圆环查看估算用量、已加载模型容量及输入组成；未知容量明确显示未知 |
| 共同默认整理模型 | 没有跨记忆与知识库的共同默认值 | 设置一个共同整理模型，助手记忆整理和全局知识库整理仍可分别覆盖 |

**使用入口：** 知识库在“**设置 → 记忆 → 知识库配置**”；记忆纠正在“**记忆 → 长期记忆**”；模型选择在“**快捷管理 → 默认模型**”。

知识库资料在重试时会再次检查权限。引用资料已撤权或删除时，需要按当前权限重新发送。

### 2. 原有功能改进

| 方面 | 上一版 | 本次更新 |
|---|---|---|
| 设置导航 | 助手配置分散在字母分区和详细配置中 | 改为左侧分类、顶部页签；参数分组展开，长页面可通过锚点跳转 |
| 模型选择 | 对话、记忆读取、整理、压缩模型分散配置 | 全部集中到“默认模型”页；各功能页保留规则和预算 |
| 助手管理 | 助手身份和配置操作分散 | 下拉框与列表共同选择编辑对象，集中管理基本信息、新建、删除和新会话候选 |
| 设置保存 | 沿用旧配置分区保存 | 按页独立保存，跨页保留草稿，冲突时保留编辑内容，不夹带其他页未保存的修改 |
| 记忆管理 | 读取、整理配置与管理操作分散 | 在“长期记忆”页集中配置读取、手动整理、自动整理和已存记忆管理 |
| 界面样式 | 已有主题体系，但布局密度不统一 | 统一设置与管理页的选中状态、表单间距、面板样式，精简重复说明 |

默认参数同步整体上调——近期原文 6 → 10 轮、摘要目标 1024 → 2048 单位、记忆整理目标 300 → 1200 字、三档检索预设 15/3/1024 → 30/6/2048、30/5/2048 → 60/10/4096、60/8/4096 → 120/16/8192、辅助调用超时 300 → 900 秒、模型调用超时 60 → 1200 秒、整理任务预算 600 → 3600 秒、连接空闲上限 10 → 120 秒——新增知识库默认上下文预算 16384 单位，数值直接比较上一发布版与当前源码，已保存的设置和环境变量覆盖值保持不变。

助手配置仍在下一新轮生效，重试原请求仍使用当时的配置。这是保留的原有行为，不是本次新增功能。

### 3. 问题修复

- **长回答和记忆整理在 60 秒后被截断。** 旧版模型传输计时器会在到达上限时结束仍正常进行的请求。默认上限现为 1200 秒，为慢模型生成和整理留出时间。它仍是包含完整流式回复的单次调用总耗时上限，不是无限等待。
- **模型尚未输出首字，连接就断开。** 旧版服务器使用 10 秒空闲上限，模型准备期间可能被断开。现改为 120 秒；该限制与模型调用超时分别生效。
- **修复了部分情况下端口被占用导致软件无法使用的问题。** 桌面启动器原先可能因无法绑定首选端口而启动失败；现在会自动选择空闲端口并打开对应地址，不关闭其他软件。
- **LM Studio 开启鉴权后无法正常使用。** 旧版固定使用预设 token，容量探测还缺少鉴权信息。现在可通过 `LM_STUDIO_API_KEY` 配置自己的 token，模型列表、容量探测和生成统一携带。
- **鉴权失败被误报为模型服务未连接。** 401/403 现在明确提示配置 token；源码启动预检也区分“需要授权”和“服务不可达”。
- **失败提示遮挡“重试原请求”按钮。** 提示移到输入框上方，不再浮动覆盖重试操作。
- **切换助手或页面后，迟到的记忆请求覆盖当前界面。** 旧请求的成功和失败结果不再替换新页面的列表、详情或提示。
- **离开记忆页再返回，来源选择与显示轮次不一致。** 来源、列表和分页状态现在一起复位。
- **修改预算后，容量预览没有立即变化。** 容量已知后在本地即时重算；切换助手时，即使模型相同也重新检查容量。
- **已存助手配置损坏时，部分路径静默改用默认值。** 非法配置现在明确报配置错误，不再悄悄生成另一套请求配置；合法旧配置仍可读取。

### 4. 行为调整与移除

- **移除摘要读取中的原文自动回注。** 原始聊天记录仍保留；近期原文、摘要压缩、长期记忆读取和知识库检索继续使用。
- 移除旧字母分区导航和重复配置控件，统一从新的设置页面操作。
- 应用支持简体中文与 English、16 种主题、会话右键菜单、macOS/Linux 源码启动。这些上一版已有，本次保留，不列为新增。

### 5. 升级与配置

1. 完整退出应用并备份 `userdata`，运行新版安装包并选择原安装目录，不要删掉旧数据库重新建库。
2. 本次增加知识库和模型设置结构，将已知旧库从结构版本 1 迁移到 4，保留会话、记忆和已存配置；不支持的结构和降级会被拒绝。历史数据库默认值的调整只在开发阶段出现，未随任何已发布版本发布。
3. 到“**快捷管理 → 默认模型**”检查各用途模型；到“**记忆 → 知识库配置**”导入资料，并明确授权给需要使用的助手。升级不会覆盖已有数值，如需采用较大的新默认值，请自行检查并保存配置。

LM Studio 开启 **Require API token** 时，先设置 token 再启动。PowerShell 示例：

```powershell
$env:LM_STUDIO_API_KEY = "your-lm-studio-token"
& "D:\superstring\superstring.exe"
```

此设置仅对本次启动生效。使用快捷方式时，在 Windows 用户环境变量中添加 `LM_STUDIO_API_KEY`，再注销并重新登录。模型服务默认地址仍为 `http://127.0.0.1:1234/v1`。

### 下载与源码使用

Windows x64 安装包见[版本页面](https://github.com/Verdspair/superstring/releases)。安装版自带应用运行时，不包含 LM Studio 和模型文件。

源码运行需 Node.js 22.12.0 或更高版本，先执行 `npm ci`，Windows 启动 `start.cmd`，macOS/Linux 启动 `./start.sh`。源码入口通过终端 Ctrl+C 停止服务。

本项目自身代码采用 [MIT 开源协议](LICENSE)，第三方声明见 [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt)。

---

## Thanks / 致谢

Special thanks to my friend [nkanf-dev](https://github.com/nkanf-dev) for his support and encouragement, especially his help with hardware, for contributing macOS/Linux source-launch support in [#1](https://github.com/Verdspair/superstring/pull/1), and for reporting that an occupied port could make the app unusable in some cases.

特别感谢我的朋友 [nkanf-dev](https://github.com/nkanf-dev) 的支持与鼓励，尤其在硬件上的帮助；也感谢他在 [#1](https://github.com/Verdspair/superstring/pull/1) 中贡献 macOS/Linux 源码启动支持，以及发现部分情况下端口被占用导致软件无法使用的问题。
