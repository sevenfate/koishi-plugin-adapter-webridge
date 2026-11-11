# 更新日志

## 2.0.0 — 2026-11-11

适配 WeBridge 8.0.80（WebSocket 协议 v8.0.80）。本版本依据插件作者提供的 v8.0.80 WebSocket 协议说明；文档说明业务接口沿用 8079。原生接口有不兼容变更，因此使用主版本号 2.0.0。**自动化测试使用模拟设备，新增能力的真机表现仍需按开发文档复验。**

新增：

- 群操作：`bot.internal.createGroup()`（`create_group`）与 `addGroupMember()`（`add_group_member`），群 ID、成员 ID 在本地先按协议校验，返回值保留 `status`、`member_results`、`invite_required_member_ids` 等业务字段。
- 转账：`bot.internal.refundTransfer()`（`refund_transfer`）与 `getTransferStatus()`（`get_transfer_status`）。只有 `status='refunded'` 且 `native_status=2002` 才表示已退还，`refund_pending` / `refund_unknown` 不能重提。
- 事件：新增 `webridge/transfer-refund-result`（协议 `transfer_refund_result`），按完整 `event_id`（`transfer_refund:<refund_result_id>`）去重，不按 `transfer_id` 去重。
- `supportsCommand()` 处理协议第 13 节的能力清单缺口：`favorites_list` 等命令可执行但未声明在 `capabilities` 里，清单缺省不等于不支持。

变更与破坏性变更：

- **收款判定（破坏性）**：`receiveTransfer()` 改为返回 `TransferOutcome`（命令信封的 `ok`／`error` 与业务 `result` 合并），不再因业务失败抛异常。只有 `confirmed=true` 才算确认收款；`status='confirm_invoked'`（`confirmed=false`）是等待超时，必须再查 `getTransferStatus()`，不能认定到账。
- **已读接口移除（破坏性）**：`mark_session_read` 已从协议 v8.0.80 移除，`internal.markSessionRead()` 方法删除，调试插件 `wb.read` 一并移除；调用方需删除该调用。
- **邀请接口返回值（破坏性）**：`inviteGuildMember(guildId, userId)` 保留两个参数，内部改为 `inviteGroupMembers()` 并下发 `member_ids` 数组，返回值由 `Promise<void>` 改为 `Promise<GroupOperationOutcome>`，业务失败不再抛异常；必须检查 `ok` 与 `status`，邀请成功仅代表已发出。

未在真机验证：建群、直接加人、转账退还/查询的实际微信侧表现，以及设备回包字段完整性；当前仅由模拟设备测试覆盖命令名、参数、结果合并与事件派发。

## 1.0.0 — 2026-10-26

首次发布，包含以下能力：

- WebSocket 接入、事件去重、迟到消息过滤、连接替换与命令超时处理。
- 文本、引用、@、@所有人，以及图片、表情、语音、视频和文件接收；媒体以标准 Koishi 元素提供。
- 文本与 HTTP(S) 媒体发送、引用及撤回；可靠匹配自发回推时返回真实文本消息 ID。
- 群与联系人查询、群成员目录缓存、群名和成员昵称补齐。
- 可选数据库归档，保存消息、群资料与成员变动，提供过滤范围、保留期限和管理指令。
- 群成员及好友申请标准事件、平台扩展事件，以及类型化原生接口。
- 自动生成并持久化连接地址；支持多份适配器配置。
- ESM / CommonJS 入口和 TypeScript 声明。

归档默认关闭，不自动保存媒体文件本体；出站媒体需要手机可下载的 HTTP(S) URL。
