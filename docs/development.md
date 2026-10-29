# 插件开发

[返回首页](../readme.md)

普通业务优先使用 Koishi 标准会话、消息元素和 Bot API。需要平台特有能力时，再使用 `WebridgeBot.internal`。

## 最小插件

下面的 TypeScript 插件注册一条指令，回复当前群名片或用户名称：

```ts
import type { Context } from 'koishi'

export const name = 'webridge-example'

export function apply(ctx: Context) {
  ctx.platform('webridge')
    .command('问候', '查看当前昵称')
    .action(({ session }) => {
      if (!session) return
      const name = session.event.member?.nick || session.username || session.userId
      return `你好，${name}`
    })
}
```

在 Koishi 中加载并启用后，私聊发送 `问候`，或群里发送 `@机器人 问候`。指令遵守 Koishi 过滤器、前缀和权限配置。

## 消息元素

接收时从 `session.elements` 读取标准元素：

| 内容 | 元素 |
| --- | --- |
| 文字 | `text` |
| @ | `at` |
| 引用 | `quote`，同时提供 `session.quote` |
| 图片、表情 | `img` |
| 语音 | `audio`，成功解码后为 WAV |
| 视频 | `video` |
| 文件 | `file`，保留安全化后的文件名 |

媒体取件成功后，默认 `src` 为包含真实字节的 `data:` URL。开启 `inboundMediaRelay` 后，同一份字节改由 Koishi 的 server 短期提供，`src` 变为带路径令牌的 http(s) 地址，业务插件把元素原样转发即可；手机按出站命令下载该地址。令牌等同于访问凭证，不要写入日志。关闭时不注册托管路由，`src` 仍是 `data:` URL。失败时保留文字说明，不生成空资源元素。处理内容的业务插件无需解析微信 XML 或私有原始字段。
诊断时可读取 `session.webridge.media`，包含种类、状态、原因、MIME、大小和转换信息；可用字段以导出的 `InboundMediaContent` 类型为准。

发送时使用 Koishi 元素，例如在插件中调用：

```ts
import { h } from 'koishi'

await session.send('收到')
await session.send([h.at(session.userId), ' 收到你的消息'])
await session.send(h.image('https://files.example.com/example.png'))
await session.send(h('audio', { src: 'https://files.example.com/example.wav' }))
await session.send(h('video', { src: 'https://files.example.com/example.mp4' }))
await session.send(h('file', { src: 'https://files.example.com/example.zip' }))
```

示例域名需替换为真实文件地址。所有出站媒体 URL 必须能被手机直接下载，本地路径和 `data:` 不支持直接发送。
未开启入站托管时，转发收到的媒体或发送动态生成的图片，需要业务插件或资产服务先提供手机可下载的 HTTP(S) URL。开启 `inboundMediaRelay` 后，收到的媒体元素可以在有效期内直接转发；过期或超出条数、总字节上限时，该条仍是 `data:` URL。动态生成的图片不会自动托管。

文字回复默认引用当前会话消息；关闭 `quoteOnReply` 取消默认行为，显式 `h('quote', { id })` 优先。
消息链发送时文字在前、媒体在后，媒体分别形成独立消息；不支持的段会警告并尽量保留其子文本，不保证原始排版。

## 标准 Bot API

| 方法 | 说明 |
| --- | --- |
| `getGuildList()` | 返回群列表 `{ data }` |
| `getGuild(guildId)` | 群资料，复用通讯录缓存 |
| `getGuildMemberList(guildId)` | 返回成员列表 `{ data }` |
| `getGuildMember(guildId, userId)` | 单个成员，找不到时抛错 |
| `getFriendList(next?)` | 好友分页 `{ data, next? }`，下页传入返回的 `next` |
| `getUser(userId, guildId?)` | 用户资料，可提供群上下文 |
| `sendMessage(channelId, content)` | 发送消息，返回可靠取得的消息 ID 列表 |
| `deleteMessage(channelId, messageId)` | 撤回消息 |
| `kickGuildMember(guildId, userId)` | 移出群成员，受账号权限限制 |
| `deleteFriend(userId)` | 删除好友 |
| `handleFriendRequest(messageId, true)` | 同意已收到的好友申请 |

真实设备账号通过 `WebridgeBot.deviceAccountId` 获取，与配置的 `selfId` 不同。平台名为 `webridge`，群 ID 通常以 `@chatroom` 结尾。
当前资料查询无需归档；接口失败抛异常，不以空列表伪装成功。

### 消息 ID、引用和撤回

```ts
const [messageId] = await bot.sendMessage(channelId, '稍后撤回的消息')
if (messageId) await bot.deleteMessage(channelId, messageId)
```

文本回执不直接提供消息 ID，适配器按同会话、正文和引用目标匹配自发回推。可靠匹配失败时返回空数组，媒体不填 ID。
并发相同内容、人工同时发送相同内容、设备改写正文或断线可能导致无法认领。不要把空数组直接解释为发送失败，也不要构造假 ID。
撤回和引用受设备近期消息缓存及微信端实际限制影响。

## 平台原生接口

先检查平台，再使用导出的类型：

```ts
import type { WebridgeBot } from 'koishi-plugin-adapter-webridge'

if (session.platform === 'webridge') {
  const bot = session.bot as unknown as WebridgeBot
  const status = await bot.internal.getAccountStatus()
  const accounts = await bot.internal.call('official_accounts', { limit: 100 })
}
```

常用方法包括 `setGuildName()`、`setGuildSelfNickname()`、`getGuildNotice()`、`getGroupSnapshot()`、`sendLinkCard()`、`sendMusicCard()` 和设备状态查询。
`setGuildName()` 改群名，`setGuildSelfNickname()` 改自己的群名片；公告来自设备本地缓存，未命中不能证明没有公告。
完整方法和参数见 TypeScript 声明及 [internal.ts](../src/internal.ts)。

`internal.call(command, args, options?)` 提供类型化命令，涵盖公众号、联系人设置、二维码、群邀请、收藏、定位、朋友圈和媒体等。参数使用 snake_case；ID 和游标保持字符串，避免大整数精度丢失。
命令清单、参数及默认等待时间见 [native.ts](../src/native.ts)。

```ts
const operation = await bot.internal.call('moments_list', {})
const state = await bot.internal.call('moments_operation', {
  operation_id: String(operation.operation_id),
})
```

朋友圈的 `pending` 只表示受理；最终结果通过 `webridge/moments-result` 派发，按真实账号、`body.operation_id` 和 `revision` 关联。
查询保留原 `operation_id`，每次使用新的命令请求 ID。朋友圈媒体上传使用业务插件自己的接收端，不复用聊天上传路由。

超时和断线不一定意味着写操作未执行。`WebridgeCommandError` 提供 `code/result/requestId/frame`，`WebridgeTransportError` 提供传输错误码、请求 ID 和命令名；业务插件应区分失败和结果未知，不自动重发写操作。
CDN 上传要求显式保存并传入 `options.requestId`，结果未知时按原任务 ID 查询或复用；操作会产生文件传输助手消息，普通文件票据不是公开下载 URL。
领取红包、确认收款、删好友、群管理及发布内容均需业务插件显式调用，适配器不会自动执行。

## 事件

| Koishi 事件 | 用途 |
| --- | --- |
| `guild-member-added` / `guild-member-removed` / `guild-member-updated` | 群成员变化 |
| `friend-request` | 好友申请，使用 `session.messageId` 关联处理 |
| `webridge/red-packet` / `webridge/transfer` | 红包与转账原始事件 |
| `webridge/friend-request` / `webridge/system-message` | 好友申请与系统原始事件 |
| `webridge/unknown-message` / `webridge/unknown-event` | 未知内容或事件 |
| `webridge/moments-result` | 朋友圈异步结果 |

自定义事件接收 `WebridgeEventPayload`，并非普通消息 Session，不应直接作为聊天指令处理。
好友申请仅缓存当前进程内最近 200 条；缺少设备申请凭据时不能同意，不支持拒绝操作。
归档服务与历史查询见 [通讯录与归档](../ARCHIVE.md)。

## 源码验证与打包

在适配器源码目录执行：

```bash
npm install
npm run test:all
npm pack
```

`npm pack` 自动构建 JavaScript 和类型声明，生成当前版本 `.tgz`。再进入自己的 **Koishi 应用目录**安装该文件。
测试覆盖协议、WebSocket、媒体上传、入站托管、通讯录、归档及集成行为，设备端为模拟器。SQLite 默认运行；专用临时数据库环境中设置 `WECHAT_TEST_POSTGRES_CONFIG` JSON 可运行归档套件的 PostgreSQL 分支。测试会清理相关表，不能指向日常数据库。
入站托管的鉴权、有效期、容量和出站 URL 都在本地 server 上验证，GET 打到与手机相同的处理函数。CI 不启动真实手机，因此「手机能否经公网或局域网下载到托管文件」还要在部署后实际转发一条媒体验收。
本地测试通过证明代码与集成链路，不替代手机、部署网络和真实群消息验收。
