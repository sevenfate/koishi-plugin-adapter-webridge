# 部署指南

[返回首页](../readme.md)

WeBridge 主动连接 Koishi。手机需要访问两类入口：WebSocket 连接用于事件和命令，HTTP POST 用于入站媒体上传。开启入站媒体托管后，手机还会对托管地址发起 HTTP GET。

## 局域网

手机和 Koishi 处于同一网络时，可按首页的最小配置启动。server 监听 `0.0.0.0`，手机使用运行 Koishi 的电脑的局域网 IP，例如：

```text
ws://192.168.1.4:5140/webridge/自动生成的密钥
```

在电脑防火墙中允许实际服务端口。若自动选择了虚拟网卡地址，可在适配器的 `address` 中修正主机，保留原路径和密钥。

`address` 指定对外连接地址，不会改变 server 的监听端口。监听端口应在 `server` 中修改。

## 域名与反向代理

以下示例假设 Nginx 与 Koishi 位于同一主机，Nginx 提供 TLS，Koishi 只监听本机 `5140` 端口。将 `bot.example.com` 换成自己的域名：

```yaml
plugins:
  server:
    host: 127.0.0.1
    port: 5140
    selfUrl: https://bot.example.com
  adapter-webridge:
    address: ''
```

初次启动时会使用 `selfUrl` 生成 `wss://` 地址。已经生成过地址的实例，应修改现有 `address` 的协议、域名和端口，保留路径与密钥；已有地址优先于 `selfUrl`。

在已有 HTTPS 站点的 `server` 块中加入下面的配置，证书与域名沿用站点设置：

```nginx
location ^~ /webridge/ {
    # 不加 URI 后缀，保留完整路径。
    proxy_pass http://127.0.0.1:5140;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    # 为最大 32 MiB 的媒体及 multipart 字段预留空间。
    client_max_body_size 40m;
    client_body_timeout 300s;
    proxy_request_buffering off;
}
```

这里代理整个 `/webridge/` 前缀，同时覆盖：

| 路径 | 用途 |
| --- | --- |
| `/webridge/连接密钥` | WebSocket 握手与持续连接 |
| `/webridge/media/upload/…` | 一次性媒体上传，使用独立令牌 |
| `/webridge/media/relay/…` | 开启 `inboundMediaRelay` 后的短期下载。路径令牌即凭证，使用 GET；不要在访问日志里保留完整路径 |

只代理完整 WebSocket 地址，会导致文本正常但媒体上传失败；开启托管时，手机的 GET 下载也会失败。使用自定义路径时，应将整个对应前缀交给 Koishi，保留上传请求的正文和 HTTP 方法。

连接地址的最后一段作为密钥，前面的路径是路由前缀。例如 `/bots/webridge/密钥` 的路由前缀为 `/bots/webridge`。自定义前缀时同步修改 Nginx 的 `location`，不要自行添加 `/agent`、查询串或锚点，也不要在代理层额外剥掉前缀。

配置后运行 `nginx -t`，通过后按部署环境重载 Nginx。连接地址应形如 `wss://bot.example.com/webridge/密钥`。WebSocket 转发和请求体限制可对照 [Nginx WebSocket 文档](https://nginx.org/en/docs/http/websocket.html) 与 [client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)。

## 容器

同一容器内的 `127.0.0.1` 才指向同一个网络环境。若反向代理和 Koishi 是不同容器：

- server 在 Koishi 容器内监听 `0.0.0.0`。
- 将 Nginx 的 `proxy_pass` 指向容器网络中的 Koishi 服务名和端口。
- 对外连接地址仍填写手机能访问的域名，不使用容器服务名。

已有代理面板时，配置等价的 WebSocket 转发、上传上限和超时即可；同时检查外层 CDN、网关或其他代理的限制。

## 验证与地址管理

1. 确认手机完成握手，Koishi 中机器人在线。
2. 按首页使用 `echo` 验证收发。
3. 发送一张小图片，确认日志出现「入站媒体已就绪」。
4. 用真实大小的媒体验证代理和适配器两处限制。

完整连接地址相当于访问凭据。公网使用 `wss://`，限制控制台和日志访问；分享日志前删掉地址密钥及消息内容。
需要更换密钥时，在 `address` 中替换最后一段，保存重载后同步修改手机端；密钥只能使用字母、数字、下划线和连字符，建议使用随机长字符串。
