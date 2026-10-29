# koishi-plugin-adapter-webridge

连接 **WeBridge** 与 **Koishi**，让 Koishi 插件处理微信消息。

支持文本和媒体收发、引用、@、群与联系人查询、群成员昵称补齐，以及可选的聊天归档。

```text
WeBridge ── WebSocket ──▶ Koishi 适配器 ──▶ 业务插件
         ◀── 发送命令 ──              ◀── 回复
```

## 使用前准备

- 一个可以正常启动的 Koishi v4 应用，版本满足 `^4.18.11`。
- Node.js `>=18`。
- 已安装并启用 `@koishijs/plugin-server`。
- WeBridge 已能正常运行，手机可以访问 Koishi 的连接地址。

普通消息收发和通讯录不需要数据库；开启归档时需要配置 Koishi 数据库。暂不支持 Koishi v5 / Satori v5。

## 快速接入

### 1. 安装适配器

在 Koishi 控制台的「插件市场」搜索 `adapter-webridge` 并安装，再到「插件配置」添加并启用。
如果插件市场索引尚未刷新，可通过命令行或安装包安装。

使用命令行时，在 **Koishi 应用目录**执行：

```bash
npm install koishi-plugin-adapter-webridge
```

也可以从 [GitHub Releases](https://github.com/sevenfate/koishi-plugin-adapter-webridge/releases) 下载安装包，再在 Koishi 应用目录执行：

```bash
npm install /path/to/koishi-plugin-adapter-webridge-1.0.0.tgz
```

用 Yarn 管理的应用请使用对应的 `yarn add`，不要混用包管理器。

安装和配置页面的操作可参考 [Koishi 官方指南](https://koishi.chat/zh-CN/manual/usage/market)。

### 2. 启用服务与适配器

确认 `server` 已启用。控制台配置时，初次可以将适配器的 `address` 留空；启动后会自动生成并写回完整连接地址。

手动编辑 `koishi.yml` 时，下面是局域网接入的最小示例。将配置合并到已有的 `plugins` 中，不要重复添加已经存在的 `server`：

```yaml
plugins:
  server:
    host: 0.0.0.0
    port: 5140
  adapter-webridge:
    address: ''
```

手动编辑配置后重启应用。若已有 server 使用其他端口，沿用实际端口即可。

### 3. 连接 WeBridge

1. 在「插件配置 → adapter-webridge」复制 `address`，也可从服务端启动日志取得。
2. 确认地址中的主机和端口能被手机访问。`127.0.0.1`、`localhost`、`0.0.0.0` 不能直接作为手机连接另一台机器的地址。
3. 在 WeBridge 中选择 **WebSocket** 模式，将完整地址填入服务端地址。
4. 开启总开关、发送开关和接收回调，保持账号在线。
5. 查看 Koishi 日志，出现「握手完成」并且机器人状态在线，表示连接已建立。

自动生成的局域网地址不适合直接用于云服务器。域名、HTTPS、容器和反向代理配置见 [部署指南](docs/deployment.md)。

连接地址包含访问密钥，请完整复制，不要在公开截图或问题反馈中暴露。

### 4. 验证第一条回复

在 Koishi 中安装并启用 `echo` 插件，再用另一个微信账号向机器人私聊发送：

```text
echo 接入测试
```

收到「接入测试」后，文本接收和回复链路已打通。群里可以发送 `@机器人 echo 接入测试`。
指令还受 Koishi 的前缀、插件过滤器、权限和频道配置影响，详见 [排错指南](docs/troubleshooting.md)。

需要媒体功能时，再分别测试一张图片、一条语音和实际使用的发送插件；文本回复成功不代表媒体链路已经通过。

## 主要能力

| 能力 | 行为 |
| --- | --- |
| 接收消息 | 文本、引用、@、@所有人；图片、表情、语音、视频和文件取件成功后生成标准 Koishi 元素 |
| 发送消息 | 文本、@、引用，以及使用 HTTP(S) URL 的图片、语音、视频和文件 |
| 通讯录 | 查询群、成员与好友；群消息按需补齐群名和成员昵称，无需数据库 |
| 通知事件 | 群成员加入、离开、改名及好友申请映射为标准事件，其他平台事件通过扩展事件提供 |
| 管理接口 | 撤回、群管理，以及 `bot.internal` 提供的平台原生能力 |
| 聊天归档 | 默认关闭；开启后保存消息、群资料和成员变动，需要数据库 |

## 使用边界

- 入站媒体默认以内联 `data:` 内容交给业务插件；出站媒体要求手机可下载的 HTTP(S) URL。直接转发收到的媒体时，可开启 `inboundMediaRelay`，由适配器把字节短期托管在 Koishi server 上并改写 `src`。关闭时不注册托管路由，行为与未开启时相同。
- 图片和表情默认上限 5 MiB；语音、视频和文件默认上限 20 MiB，均可调整至 32 MiB。
- 文本消息 ID 依赖设备回推，可靠匹配成功才返回；媒体发送不返回可用于撤回的消息 ID。
- 昵称通过群目录补齐；查询失败、资料缺失或等待超时时仍会继续处理消息，可能回退显示账号 ID。
- 名片、链接、小程序、合并转发等入站内容保留类型说明；并非所有消息段都支持原样发送。
- 设备命令回执不等于微信端最终展示成功。群管理、引用和撤回也受当前账号权限及设备缓存限制。

## 继续阅读

- [部署指南](docs/deployment.md)：局域网、域名与反向代理。
- [配置参考](docs/configuration.md)：参数、默认值、多账号与媒体限制。
- [排错指南](docs/troubleshooting.md)：连接、指令、媒体与归档问题。
- [插件开发](docs/development.md)：标准消息元素、Bot API、平台原生接口和事件。
- [通讯录与归档](ARCHIVE.md)：昵称、数据库、记录范围、保留策略与配置迁移。
- [更新日志](CHANGELOG.md)。

## License

[MIT](LICENSE) © 2026 阿飞
