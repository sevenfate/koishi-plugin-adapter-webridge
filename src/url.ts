/**
 * 回调地址生成。
 *
 * 手机端 WeBridge 要填的是一个**完整 WebSocket 地址**，包含协议、主机、端口、路径和
 * 路径密钥。这里负责把这些片段拼起来，并尽量自动选一个手机能访问到的局域网 IPv4。
 *
 * 纯函数放在这里是为了能单测；真正读取网卡、server 配置的逻辑在 `bot.ts`。
 */

import type { NetworkInterfaceInfo } from 'node:os'

/** 判断一个 IPv4 是否属于常见局域网段。 */
function isPrivateIPv4(address: string): boolean {
  return (
    address.startsWith('10.') ||
    address.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address)
  )
}

/**
 * 从 `os.networkInterfaces()` 的结果里挑一个最可能被手机访问到的 IPv4。
 *
 * 优先 192.168（家用 / 办公 Wi-Fi 最常见），其次 10，再其次 172.16/12；
 * 忽略 loopback、IPv6 和 0.0.0.0。找不到时返回 undefined。
 */
export function selectLanAddress(
  interfaces: Record<string, NetworkInterfaceInfo[] | undefined>,
): string | undefined {
  const candidates: string[] = []
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (!item.address || item.address === '0.0.0.0') continue
      candidates.push(item.address)
    }
  }
  return (
    candidates.find((address) => address.startsWith('192.168.')) ??
    candidates.find((address) => address.startsWith('10.')) ??
    candidates.find((address) => isPrivateIPv4(address)) ??
    candidates[0]
  )
}

/** 拼 URL 的 host 部分：IPv6 字面量必须加方括号。 */
export function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** 这个 host 是否只能本机访问（手机填了也连不上）。 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** 从完整地址里拆出来的部分。 */
export interface ParsedCallbackAddress {
  /** 协议 + 主机 + 端口，例如 `ws://192.168.1.4:5140`。 */
  origin: string
  /** 路由路径，例如 `/webridge`。 */
  path: string
  /** 路径末尾的密钥；没有就是空串。 */
  secret: string
}

/** 地址里的 secret 只允许这些字符（与 bot.ts 的校验一致）。 */
const ADDRESS_SECRET_PATTERN = /^[A-Za-z0-9_-]*$/

/**
 * 解析用户填在「完整地址」里的值。
 *
 * 规则：路径的最后一段当作 secret，前面的部分当作路由 path。
 * 例如 `ws://192.168.1.4:5140/koishi/webridge/abc` →
 * origin=`ws://192.168.1.4:5140`、path=`/koishi/webridge`、secret=`abc`。
 *
 * 支持 ws(s) 和 http(s)（后者在生成时自动换成 ws(s)）。
 *
 * @throws 地址非法、缺主机名、或 secret 含非法字符时。
 */
export function parseCallbackAddress(address: string): ParsedCallbackAddress {
  const url = new URL(address)
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) {
    throw new Error(`地址必须是 ws(s):// 或 http(s)://，收到 ${JSON.stringify(address)}`)
  }
  if (!url.hostname) {
    throw new Error(`地址缺少主机名：${JSON.stringify(address)}`)
  }

  const segments = url.pathname.split('/').filter(Boolean)
  let secret = ''
  if (segments.length > 1) secret = segments.pop()!
  const path = segments.length ? `/${segments.join('/')}` : '/webridge'
  if (!ADDRESS_SECRET_PATTERN.test(secret)) {
    throw new Error(
      `地址里的 secret 只能包含字母、数字、下划线和连字符：${JSON.stringify(secret)}`,
    )
  }
  return { origin: `${url.protocol}//${url.host}`, path, secret }
}

/**
 * 用基地址和端点拼出手机要填的 WebSocket 地址。
 *
 * - `http:` → `ws:`，`https:` → `wss:`；已经是 ws(s) 的原样保留；
 * - 保留基地址里的路径前缀（反向代理挂在 `/koishi` 这类子路径时要用）；
 * - 清掉基地址里的查询串与锚点，默认端口（ws:80 / wss:443）不写出来。
 *
 * @throws 基地址不是 http(s) / ws(s) 地址时。
 */
export function buildWebSocketUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`基地址必须是 http(s) 或 ws(s) 地址，收到 ${JSON.stringify(baseUrl)}`)
  }

  const prefix = url.pathname.replace(/\/+$/, '')
  url.pathname = `${prefix}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
  url.search = ''
  url.hash = ''
  if (
    (url.protocol === 'ws:' && url.port === '80') ||
    (url.protocol === 'wss:' && url.port === '443')
  ) {
    url.port = ''
  }
  return url.toString()
}

/**
 * 用与 {@link buildWebSocketUrl} 相同的基地址规则，拼出手机能下载的 http(s) 地址。
 *
 * `ws:` 换成 `http:`，`wss:` 换成 `https:`。查询串和锚点同样会被清掉。
 */
export function buildHttpUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(buildWebSocketUrl(baseUrl, endpoint))
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.toString()
}
