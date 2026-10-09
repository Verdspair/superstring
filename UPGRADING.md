# v0.4.0-alpha-2 — 升级说明 / Upgrade Guide

[简体中文](#简体中文) · [English](#english)

## 简体中文

**版本：** `0.4.0-alpha-2`。**对比基线：** 已发布的 `v0.4.0-alpha-1`。

### 相对 v0.4.0-alpha-1 的变化

| 领域 | v0.4.0-alpha-1 | 0.4.0-alpha-2 |
|---|---|---|
| QQ 自主接话控制 | 缺少触发间隔与排队控制 | 新增触发消息数（默认 15）与扰动量（默认 5）控制，支持忙时排队；可选用连续交谈或自主接话（两者互斥） |
| 聊天记录与任务展示 | 加载旧记录时新消息需等待 | 新消息即时显示不等待旧历史；群聊顶部显示进行中的模型任务，任务结束后更新最终结果 |
| QQ 引用与 @ 成员 | 引用与 @ 依赖兼容处理 | 原生支持消息引用与 @ 成员，两者相互独立，并支持搭配已授权表情 |
| 方案与群配置界面 | 群配置与方案设置入口相对分离 | 整合至方案工作流中，直观管理群专属覆盖项；修复保存状态与草稿处理问题，冲突时保留未保存内容 |
| 桌面应用退出 | 关闭窗口可能残留后台进程 | 关闭桌面主窗口后，Superstring 自行启动的服务与相关进程一起退出 |
| 运行追踪与历史读取 | 存在重复查询 | 优化消息历史、任务与追踪读取，减少重复查询，早期工作区加载更顺畅 |
| 数据库结构 | 结构版本 53 | 结构版本 54（新增接话设置等字段，保持已有数据完整） |

### 升级前准备

1. **完全退出程序**：关闭桌面窗口，并确认退出系统托盘或后台常驻进程。切勿在服务运行时复制或移动数据库文件。
2. **完整备份数据目录**：
   - Windows 安装版：备份安装目录下的整个 `userdata` 文件夹（包含数据库、WAL 文件、加密密钥与配置文件）。
   - macOS / Linux：备份系统应用数据目录。
   - 注意：加密保存的模型与服务凭据依赖同一套密钥文件，备份时必须连同密钥文件一起保存。
3. **保留回退环境**：若需保留回退可能，请妥善保存原 v0.4.0-alpha-1 安装包与升级前的 53 版数据备份。新版数据库无法直接由旧版程序读取。
4. **核对安装包**：下载安装包后，建议使用随发布提供的校验清单（`SHA256SUMS`）核对文件完整性。

### 安装或更新

#### Windows x64

运行对应版本的安装程序，选择现有的安装目录。安装器会识别现有安装，在升级过程中保留 `userdata` 中的用户数据，然后替换程序文件。

#### macOS 与 Linux

0.4.0-alpha-2 随本次 Release 提供各系统架构安装包（Windows 安装程序、macOS DMG/ZIP 与 Linux DEB/AppImage 及校验清单 `SHA256SUMS`）。替换应用前请先完全退出旧版本。原生配置文件保存在系统应用数据目录。macOS 安装包为临时签名（ad-hoc signed，未公证），首次运行请右键选择「打开」；详情见[跨平台桌面打包](tools/desktop/build/cross-platform/README.md)。

#### 源码启动

更新源码后，运行 `npm ci` 安装锁定版本的依赖，然后运行 `start.cmd`（Windows）或 `./start.sh`（macOS/Linux）。请保留既有数据路径，不要同时启动多个进程使用同一数据目录。

### 数据库结构与回退

已发布的 v0.4.0-alpha-1 业务结构版本为 **53**，本版本为 **54**。程序启动时会自动执行新增迁移 `0054_qq_initiative_batches.sql`：
- 为自主接话新增触发间隔消息数（默认 15）、扰动量（默认 5）以及忙时排队开关（默认开启）等配置字段；
- 记录自主接话专属的观察进度序号，避免高频群聊频繁发起无效评估；
- 迁移为增量写入，新增接话设置字段，已有聊天记录和配置保留；仍建议先备份。

遇到未知结构或降级尝试时，程序会拒绝启动以保护数据安全。如需回退，必须先完全退出程序，恢复升级前备份的 53 版数据与匹配密钥，再启动 v0.4.0-alpha-1 程序。

### 建议检查的配置

- **QQ 方案自主接话**：在方案设置中复查自主接话配置。若群聊消息频繁，可根据活跃度调整触发消息数与扰动量，确认忙时排队是否符合预期。
- **群聊消息与进行中任务**：在群聊中确认新消息到达时是否平滑显示，检查顶部模型任务指示与详情展开是否正常。
- **模型服务与图片支持**：复查模型服务配置。使用原生图片输入需确认模型实际支持视觉输入；对于不支持图片输入的模型，请选用文本描述模式或关闭视觉能力。

---

## English

**Version:** `0.4.0-alpha-2`. **Comparison baseline:** published `v0.4.0-alpha-1`.

### What changes from v0.4.0-alpha-1

| Area | v0.4.0-alpha-1 | 0.4.0-alpha-2 |
|---|---|---|
| QQ Autonomous Participation | Lacked batch triggers and queue controls | Adds trigger message counts (default 15) and jitter (default 5), supports queue-on-busy; choose continuous conversation or autonomous participation (mutually exclusive) |
| Chat History & In-flight Tasks | Incoming messages waited while older history loaded | Fresh messages appear immediately without waiting for older history; running model tasks appear at the top of group chats and update final results upon completion |
| QQ Quotes & Mentions | Handled via compatibility logic | Native message quotes and member mentions, fully independent, with authorized sticker support |
| Scheme & Group Settings | Group settings and schemes accessed separately | Integrated into scheme workflows with clear override tracking; fixed save state and draft handling to keep unsaved changes during conflicts |
| Desktop Application Exit | Closing window could leave lingering background processes | Closing the main desktop window exits background services and processes started by Superstring |
| Runtime Traces & History Reads | Contained redundant queries | Optimized message history, task, and trace reads, reducing redundant queries for smoother workspace loading |
| Database Schema | Schema version 53 | Schema version 54 (adds initiative batch settings while preserving existing data integrity) |

### Before Upgrading

1. **Fully exit the application**: Close the desktop window and ensure system tray icons and background processes are closed. Never copy or move database files while services are running.
2. **Back up your complete data directory**:
   - Windows installer: Back up the entire `userdata` folder under the installation directory (including database, WAL files, encryption keys, and configurations).
   - macOS / Linux: Back up the system application data directory.
   - Note: Encrypted model credentials depend on matching key files; always back up encryption keys together with data files.
3. **Keep rollback assets**: If you wish to retain rollback capability, keep your v0.4.0-alpha-1 installer and a pre-upgrade backup of your schema 53 database and keys. Migrated databases cannot be read by older versions.
4. **Verify installers**: After downloading, verify package integrity against the published checksum list (`SHA256SUMS`).

### Installation and Updates

#### Windows x64

Run the installer for this release and select your existing installation directory. The installer preserves user data in `userdata` while replacing application files.

#### macOS and Linux

0.4.0-alpha-2 packages are provided across architectures (Windows installer, macOS DMG/ZIP, and Linux DEB/AppImage with checksum list `SHA256SUMS`). Fully exit older versions before replacing the application. Profiles reside in system application data directories. macOS packages are ad-hoc signed and not notarized (right-click Open on first launch); see [Desktop packaging](tools/desktop/build/cross-platform/README.md) for details.

#### Source Launch

Update the source code, run `npm ci` to install pinned dependencies, and launch with `start.cmd` (Windows) or `./start.sh` (macOS/Linux). Retain existing data paths and avoid starting multiple instances against the same data directory.

### Database Schema and Rollback

Known v0.4.0-alpha-1 databases run on schema **53**; this release runs on schema **54**. The application executes additive migration `0054_qq_initiative_batches.sql`:
- Adds configuration fields for autonomous participation: trigger message count (default 15), jitter (default 5), and queue-on-busy (enabled by default);
- Adds an autonomous observation sequence cursor to avoid frequent unnecessary evaluations in busy chats;
- The migration is additive, adding initiative setting fields while preserving existing chat records and configuration; backing up beforehand is still recommended.

Unknown schemas or downgrade attempts are rejected to protect data safety. Rolling back requires fully exiting the application, restoring your matching pre-upgrade schema 53 data and key backup, and launching the v0.4.0-alpha-1 executable.

### Configuration Checklist

- **QQ Scheme Autonomous Participation**: Review autonomous participation settings in schemes. If group messages are frequent, adjust trigger counts and jitter, and confirm that queue-on-busy behavior matches your preferences.
- **Group Chats & In-flight Tasks**: Verify smooth updates as new messages arrive and inspect active parent/child tasks in group conversations.
- **Model Services & Vision Support**: Review configured model endpoints. Ensure models used with native image mode genuinely support visual inputs; switch to description mode or disable vision for text-only models.

---

## 致谢 / Thanks

感谢 [nkanf-dev](https://github.com/nkanf-dev)：在保留原有功能的前提下，重构并优化了前后端流程与界面，贡献了多平台支持（macOS/Linux 源码启动与原生桌面分发），并在项目早期及后续开发中共同讨论、确定了项目的发展方向（详见 [PR 记录](https://github.com/Verdspair/superstring/pulls)）。

Thanks to [nkanf-dev](https://github.com/nkanf-dev) for refactoring and optimizing the front-end and back-end workflows and interface while preserving existing functionality, for his multi-platform support (macOS/Linux source launch and native desktop distributions), and for the early and ongoing discussions that shaped the project's direction — see the [pull request history](https://github.com/Verdspair/superstring/pulls).
