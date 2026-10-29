# 配置参考

[返回首页](../readme.md)

以下字段配置在 `adapter-webridge` 中。除 `dropStaleEventSeconds` 和 `archive.retentionDays` 外，时间字段均以毫秒为单位；大小字段以字节为单位。

## 连接与回复

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `address` | `''` | 完整连接地址。留空时自动生成并写回；设置后优先使用该地址 |
| `selfId` | `webridge` | Koishi 中的机器人标识，不是设备微信账号；真实账号由握手提供 |
| `commandTimeout` | `15000` | 普通命令等待回执的超时 |
| `mediaTimeout` | `120000` | 出站图片、语音、视频、文件等待回执的超时 |
| `echoTimeout` | `1000` | 文本发送成功后等待自发消息回推的时间；`0` 关闭等待，发送不返回可用 ID |
| `dropStaleEventSeconds` | `120` | 超过此秒数的迟到事件不进入普通业务处理；`0` 不按时效过滤 |
| `quoteOnReply` | `true` | 回复文字时自动引用触发回复的消息；显式 `quote` 元素优先 |

自动地址按 server 的 `selfUrl`、监听地址或局域网网卡生成。`address` 的主机和端口不会修改监听配置，具体见 [部署指南](deployment.md)。

## 入站媒体

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `acceptMedia` | `true` | 接收非文本消息并按需取件；关闭不影响发送 |
| `inboundMediaTimeout` | `200000` | 取件、上传与回执总等待，允许 1000～200000 |
| `inboundMediaMaxBytes` | `5242880` | 图片和表情默认 5 MiB，允许 1024～33554432 |
| `inboundAttachmentMaxBytes` | `20971520` | 语音、视频和文件默认 20 MiB，允许 1024～33554432；同时限制语音解码后的大小 |
| `inboundMediaRelay` | `false` | 把取件成功的媒体临时托管为带路径令牌的 http(s) 地址，便于原样转发。关闭时仍是 `data:` URL，且不注册托管路由 |
| `inboundMediaRelayTtl` | `300000` | 托管有效期，允许 1000～3600000。到期后删除字节并返回 404 |
| `inboundMediaRelayMaxItems` | `32` | 同时保留的托管条数，允许 1～256。放不下时该条仍用 `data:` URL，不删除未过期条目 |
| `inboundMediaRelayMaxBytes` | `67108864` | 托管总字节上限，默认 64 MiB，允许 1024～268435456。单条仍受上面的图片或附件上限约束 |

例如，将两类入站上限都调至 32 MiB：

```yaml
adapter-webridge:
  address: ''
  inboundMediaMaxBytes: 33554432
  inboundAttachmentMaxBytes: 33554432
```

这只修改适配器限制，代理仍需允许更大的 multipart 请求体。语音转成单声道 24 kHz WAV，最长 120 秒。

需要把收到的图片、表情、语音、视频或文件原样发出去时，打开托管。开关在适配器启动时生效，改完要重新加载：

```yaml
adapter-webridge:
  address: ''
  inboundMediaRelay: true
  inboundMediaRelayTtl: 300000
```

托管地址和 WebSocket 使用同一套对外主机（`address`、`selfUrl` 或监听地址）。路径最后一段是访问令牌，不要写进日志；查询串和请求头都不能代替它。有效期内可以多次下载，方便业务插件预览和手机重试。超期、超过条数或总字节时，这一条仍保持 `data:` URL。设备断线重连不会提前删掉尚未过期的字节；卸载适配器会关掉路由。

每个机器人最多同时处理 4 项媒体取件，等待派发的消息最多 256 条。同一会话按顺序处理，后续文字可能等待前一条媒体；不同会话独立。
取件失败时保留消息和不可用说明，不生成无法读取的空资源。手机断线、账号变化或插件卸载时取消等待。

## 通讯录

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `directoryCacheTtl` | `300000` | 群资料和成员缓存时间，允许 1000～86400000 |
| `directoryTimeout` | `1000` | 群消息等待昵称补齐的最长时间，允许 0～10000；`0` 不主动等待补齐 |
| `directoryCapacity` | `256` | 每个机器人最多缓存的群目录数，允许 1～4096 |

通讯录无需数据库，详情见 [通讯录与归档](../ARCHIVE.md)。

## 归档

`archive.enabled` 默认 `false`，其余归档参数仅在开启后使用。完整示例、参数与存储范围见 [归档配置](../ARCHIVE.md#开启归档)。

## 多账号

为每个账号添加一份适配器配置，分别使用不同的 `selfId` 和连接路径。控制台可以添加多份配置；YAML 可使用实例后缀：

```yaml
adapter-webridge:account-a:
  selfId: webridge-a
  address: ''
adapter-webridge:account-b:
  selfId: webridge-b
  address: ''
```

启动后分别复制各自生成的地址。已运行的机器人不要随意更换 `selfId`，现有频道受理关系依赖它。
同一机器人收到新设备连接时会替换旧连接；通讯录缓存和归档范围按账号隔离。
