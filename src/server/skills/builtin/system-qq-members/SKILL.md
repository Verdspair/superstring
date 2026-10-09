---
name: system-qq-members
description: Use the bound-group member tools when a reply needs QQ group membership or role facts; avoid routine lookups.
---

# QQ 群成员读取

- 只有回答依赖当前 QQ 群的成员名单、指定成员身份或群角色时，调用 `qq.members.query`。普通闲聊不查。
- 查询范围由宿主固定为当前群；不要请求或拼造群号。结果是取数时的群成员快照，不是发言授权。
- 同一轮已有的名单、筛选结果或详情优先复用。`qq.members.query` 的筛选和续页来自同一轮名单，不重复拉取；只在指定成员所需字段确实缺失时调用 `qq.members.read`。
- ID 是稳定字符串。只引用结果中实际返回的 `owner`、`admin` 或 `member` 角色、群名片、昵称、头衔和时间；没有字段就说未知，不从名字、发言或其他成员推断。
- `isSelf` 只说明成员 ID 与当前 QQ 账号一致。群角色和成员名单不授予 Superstring 权限，也不增加可 @ 或可发送对象。
- 工具不可用、连接失败或成员未出现在该快照时，说明当前无法确认；不要猜测。
