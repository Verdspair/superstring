# Superstring v0.2.0-alpha

[English](#english) · [简体中文](#简体中文)

## English

### Added

- English and Simplified Chinese in General settings. The language choice is saved and shared across tabs; chat content stays in its original language.
- A bottom status bar showing the operating mode and local workspace.
- A sidebar context menu for renaming, refreshing, and deleting conversations without switching chats. Press Enter to save a name or Escape to cancel.
- `start.sh` for running the browser app from source on macOS and Linux.

### Changed

- Settings are split into General, Operating mode, and Assistant settings. Language and appearance are under General.
- Settings pages use the same back icon, with tooltips, keyboard access, and a prompt for unsaved changes.
- Operating modes are listed vertically and marked as active or unavailable.
- Assistant settings are ordered as Name and model, Personality and persona, Emotion, User profile, Memory, Knowledge base, Context, External software, and Other. Existing save behavior is unchanged.
- Message menus open at the pointer, stay within the window, and support keyboard navigation.
- Removed the chat header's duplicate conversation controls and configuration-version hint.
- Confirmation dialogs handle keyboard focus and block repeated submissions. Failed rename or delete requests leave the editor or dialog open; switching languages preserves drafts.
- Split frontend views and state into feature modules, added regression tests, and removed redundant comments.

### Fixed

- The desktop self-test now checks `package.json` instead of requiring a specific project folder name.
- Migration-resource tests now resolve macOS temporary-directory symlinks before comparing paths.

### Updating

Close the Windows app, then run `superstring-setup-0.2.0-alpha.exe` and select the existing installation folder. File checksums are in `SHA256SUMS.txt`. macOS and Linux users run from source.

The database schema and existing conversation, assistant, and memory data formats are unchanged.

---

## 简体中文

### 新增

- 通用设置支持切换简体中文和 English，自动保存并同步到其他标签页；聊天内容保持原文。
- 底部状态栏显示运行模式和本地工作空间。
- 侧栏会话右键菜单支持重命名、刷新和删除，无需切换会话。重命名时按 Enter 保存、Escape 取消。
- 新增 `start.sh`，支持在 macOS 和 Linux 上从源码启动网页版。

### 调整

- 设置分为通用、运行模式和助手设置；语言与外观放在通用设置中。
- 设置页统一使用返回图标，支持悬停提示、键盘操作和未保存提醒。
- 运行模式改为纵向列表，标注“使用中”或“未开放”。
- 助手设置依次排列为名称与模型、性格与人设、情绪、用户画像、记忆管理、知识库、上下文、外部软件、其他，原有保存方式不变。
- 消息菜单在鼠标位置打开，避让窗口边缘，支持键盘操作。
- 移除聊天页头部重复的会话操作和配置版本提示。
- 确认弹窗支持焦点管理并阻止重复提交。重命名或删除失败时保留编辑框或弹窗；切换语言不清空草稿。
- 按功能拆分前端视图和状态，补充回归测试，清理冗余注释。

### 修复

- 桌面自测改为检查 `package.json`，不再要求项目文件夹使用特定名称。
- 迁移资源测试先解析 macOS 临时目录的软链接，再比较路径。

### 升级

Windows 用户先关闭应用，再运行 `superstring-setup-0.2.0-alpha.exe`，选择原安装目录。文件校验值见 `SHA256SUMS.txt`。macOS 和 Linux 用户从源码运行。

本次未修改数据库结构，聊天、助手和记忆的数据格式不变。

---

## Thanks / 致谢

Thanks to @nkanf-dev for the macOS and Linux source launcher in [#1](https://github.com/Verdspair/superstring/pull/1).

感谢 @nkanf-dev 在 [#1](https://github.com/Verdspair/superstring/pull/1) 中贡献 macOS 和 Linux 源码启动支持。
