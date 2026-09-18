# Superstring v0.2.0-alpha

[English](#english) · [简体中文](#简体中文)

## English

This update adds a bilingual interface, reorganized settings, and easier conversation management, alongside a modular frontend refactor.

### Added

- **English and Simplified Chinese:** switch languages instantly in General settings. The choice is saved and synchronized across tabs; conversation text, assistant names, and personas stay unchanged.
- **Bottom status bar:** see the current operating mode and local workspace information in one place.
- **Conversation context menu:** rename, refresh, or delete a conversation from the sidebar without switching the active chat. Press Enter to save a name or Escape to cancel.
- **macOS / Linux source launcher:** run the browser app from source with `start.sh`. Thanks to @nkanf-dev for the contribution in #1.

### Improved

- **Settings navigation:** General, Operating mode, and Assistant settings now have separate pages. Language and appearance live together in General.
- **Consistent back navigation:** settings pages use a compact back icon with keyboard support, tooltips, and protection for unsaved edits.
- **Operating mode list:** vertical rows clearly show the active mode and options not yet available.
- **Assistant sections:** settings are arranged as Name and model, Personality and persona, Emotion, User profile, Memory, Knowledge base, Context, External software, and Other. Saving behavior for existing features is unchanged.
- **Message menus:** open near the pointer, stay inside the window, and support keyboard navigation.
- **Cleaner chat header:** conversation actions now live in the sidebar, removing duplicate controls and configuration-version hints.
- **Consistent confirmation dialogs:** improved focus handling, keyboard navigation, and protection against repeated submissions.
- **Editing feedback:** failed rename or delete requests retain the editor or confirmation dialog. Language changes preserve input and unsaved drafts.

### Fixed

- Removed the desktop self-test's incorrect requirement for a particular project directory name. It now checks the project identity in `package.json`.
- Fixed migration-resource test path comparisons when the macOS temporary directory is a symbolic link.

### Under the hood

- Split frontend views, state, and workflows into feature modules, with focused state subscriptions.
- Extracted pure configuration and message rules and expanded interaction and regression tests.
- Removed redundant comments, corrected outdated explanations, and standardized formatting.

### Updating

- No database schema changes. Existing conversation, assistant, and memory data formats are unchanged.
- Windows desktop users update with the full installer. macOS / Linux users run the browser app from source.
- Close the application before updating, then select the existing installation directory.
- Download `superstring-setup-0.2.0-alpha.exe`; verify it against `SHA256SUMS.txt` if needed.

---

## 简体中文

本次更新带来中英文界面、重新整理的设置中心和更方便的会话操作，同时完成前端模块化重构。

### 新增

- **中英文界面切换**：在通用设置中选择简体中文或 English，即时生效，自动保存并同步到其他标签页。聊天内容、助手名称和人设保持原文。
- **底部状态栏**：集中显示运行模式与本地工作空间信息。
- **会话右键菜单**：在侧栏直接重命名、刷新或删除会话，无需先切换到该会话。重命名支持 Enter 保存、Escape 取消。
- **macOS / Linux 源码启动支持**：新增 `start.sh`，可从源码启动网页版。感谢 @nkanf-dev 的贡献（#1）。

### 改进

- **设置中心重新分组**：通用、运行模式、助手设置各自独立；语言与外观统一放入通用设置。
- **统一设置页导航**：各子页使用简洁的返回图标，保留键盘操作、悬停提示和未保存内容保护。
- **运行模式展示更清晰**：采用纵向列表，直接标明“使用中”或“未开放”。
- **助手设置分区重新整理**：按名称与模型、性格与人设、情绪、用户画像、记忆管理、知识库、上下文、外部软件、其他排列；已开放功能的保存方式不变。
- **消息菜单更顺手**：在鼠标附近打开，自动避让窗口边缘，支持键盘导航。
- **精简聊天页头部**：会话管理集中到侧栏，移除重复操作和配置版本提示。
- **统一确认弹窗**：完善焦点管理、键盘导航和请求期间的重复提交保护。
- **改善操作反馈**：重命名或删除失败时保留编辑内容与确认窗口；语言切换不清空输入和未保存草稿。

### 修复

- 修正桌面自测对项目目录名称的错误限制，改为核对 `package.json` 中的项目标识。
- 修正 macOS 临时目录软链接导致的迁移资源测试路径比较问题。

### 内部调整

- 按功能拆分前端视图、状态和业务流程，减少组件对无关状态变化的订阅。
- 提取配置与消息处理的纯函数，补充交互和回归测试。
- 清理冗余注释、修正过期说明并统一代码格式。

### 升级说明

- 本次没有数据库结构变更，沿用现有聊天、助手配置和记忆数据格式。
- Windows 桌面版使用完整安装包更新；macOS / Linux 使用源码运行网页版。
- 更新前关闭应用，使用新安装包选择原安装目录。
- 下载 `superstring-setup-0.2.0-alpha.exe`，可使用 `SHA256SUMS.txt` 核验文件。
