/**
 * 入站媒体短期托管。
 *
 * 取件成功后的字节默认放在 `data:` URL 里，出站却只接受手机能下载的 http(s)。
 * 打开 `inboundMediaRelay` 后，把同一份字节挂到 Koishi 注入的 `server` 上，
 * 元素 `src` 换成带路径令牌的短期地址，业务插件就可以原样转发。
 *
 * 令牌是访问凭证：只出现在 URL 路径里，不写入日志、不放进查询串。
 * 过期、超条数或超总字节时不托管，调用方继续使用原来的 `data:` URL。
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@satorijs/core'
import type { WebridgeBot } from './bot.js'
import { DEFAULT_ATTACHMENT_MAX_BYTES, safeFilename } from './media-format.js'
import { DEFAULT_INBOUND_MEDIA_MAX_BYTES, type InboundMediaContent } from './media.js'
import { MAX_MEDIA_URL_LENGTH, MEDIA_URL } from './message.js'

export const DEFAULT_INBOUND_MEDIA_RELAY_TTL = 5 * 60 * 1000
export const DEFAULT_INBOUND_MEDIA_RELAY_MAX_ITEMS = 32
export const DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES = 64 * 1024 * 1024

const TOKEN_PATTERN = /^[a-f0-9]{48}$/

/** 与 prepareMedia 实际产出的 MIME 对齐；名单之外不托管。 */
const RELAY_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/avif',
  'audio/wav',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo',
  'application/octet-stream',
])

export type RelaySkipReason = 'disabled' | 'stopped' | 'invalid-payload' | 'too-large' | 'capacity' | 'url-unusable'

export interface RelayDecision {
  src?: string
  reason?: RelaySkipReason
}

interface RelayEntry {
  bytes: Buffer
  mime: string
  kind: string
  filename?: string
  expiresAt: number
  timer: NodeJS.Timeout
}

function readDataUrl(src: string): { mime: string; bytes: Buffer } | undefined {
  const comma = src.indexOf(',')
  if (comma < 0) return
  const head = src.slice(0, comma)
  if (!head.startsWith('data:') || !head.endsWith(';base64')) return
  const mime = head.slice('data:'.length, -';base64'.length).toLowerCase()
  if (!RELAY_MIME.has(mime)) return
  const payload = src.slice(comma + 1)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return
  const bytes = Buffer.from(payload, 'base64')
  if (!bytes.length || bytes.toString('base64') !== payload) return
  return { mime, bytes }
}

function contentDisposition(kind: string, filename?: string): string {
  const type = kind === 'file' ? 'attachment' : 'inline'
  if (!filename) return type
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export class InboundMediaRelay {
  private entries = new Map<string, RelayEntry>()
  private total = 0
  private stopped = false
  private layer?: Context['server']['stack'][number]

  constructor(private bot: WebridgeBot, private path: string, private publicUrl: (token: string) => string) {}

  start(): void {
    if (this.layer || this.stopped) return
    const handler = async (koa: any) => {
      try {
        if (koa.method !== 'GET' && koa.method !== 'HEAD') {
          koa.status = 404
          return
        }
        const token = String(koa.params?.token ?? '')
        const entry = this.take(token)
        if (!entry) {
          koa.status = 404
          return
        }
        koa.set('Content-Type', entry.mime)
        koa.set('Content-Length', String(entry.bytes.length))
        koa.set('X-Content-Type-Options', 'nosniff')
        koa.set('Cache-Control', 'private, no-store')
        koa.set('Pragma', 'no-cache')
        koa.set('Referrer-Policy', 'no-referrer')
        koa.set('X-Robots-Tag', 'noindex')
        koa.set('Content-Disposition', contentDisposition(entry.kind, entry.filename))
        koa.body = entry.bytes
      } catch {
        koa.status = 404
      }
    }
    Object.defineProperty(handler, Symbol.for('noParseBody'), { value: true })
    // 同一路径的其他方法也要落到这里并返回 404。只注册 GET 时，路由器会对 POST 回 405，
    // 从而暴露「这条路径存在」。
    this.layer = this.bot.ctx.server.register(
      `${this.path}/:token`,
      ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      handler,
    )
  }

  /** 托管成功时返回 http(s) 地址；否则给出原因，调用方保留 data: URL。不记录令牌。 */
  publish(content: InboundMediaContent): RelayDecision {
    if (this.stopped) return { reason: 'stopped' }
    if (!this.bot.config.inboundMediaRelay) return { reason: 'disabled' }
    if (content.status !== 'ready' || typeof content.src !== 'string') return { reason: 'invalid-payload' }
    if (MEDIA_URL.test(content.src)) return {}
    const parsed = readDataUrl(content.src)
    if (!parsed) return { reason: 'invalid-payload' }
    if (content.mime && content.mime.toLowerCase() !== parsed.mime) return { reason: 'invalid-payload' }
    if (content.size !== undefined && content.size !== parsed.bytes.length) return { reason: 'invalid-payload' }
    if (parsed.bytes.length > this.itemLimit(content.kind)) return { reason: 'too-large' }

    this.sweep()
    const maxItems = this.bot.config.inboundMediaRelayMaxItems ?? DEFAULT_INBOUND_MEDIA_RELAY_MAX_ITEMS
    const maxBytes = this.bot.config.inboundMediaRelayMaxBytes ?? DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES
    if (this.entries.size >= maxItems || this.total + parsed.bytes.length > maxBytes) return { reason: 'capacity' }

    let token = randomBytes(24).toString('hex')
    while (this.entries.has(token)) token = randomBytes(24).toString('hex')
    let url: string
    try {
      url = this.publicUrl(token)
      const parsedUrl = new URL(url)
      if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) return { reason: 'url-unusable' }
      if (parsedUrl.pathname.split('/').pop() !== token) return { reason: 'url-unusable' }
    } catch {
      return { reason: 'url-unusable' }
    }
    if (url.length > MAX_MEDIA_URL_LENGTH || !MEDIA_URL.test(url)) return { reason: 'url-unusable' }

    const ttl = this.bot.config.inboundMediaRelayTtl ?? DEFAULT_INBOUND_MEDIA_RELAY_TTL
    const filename = typeof content.filename === 'string' && content.filename ? safeFilename(content.filename) : undefined
    const timer = setTimeout(() => this.drop(token), ttl)
    timer.unref?.()
    this.entries.set(token, {
      bytes: parsed.bytes,
      mime: parsed.mime,
      kind: content.kind,
      filename,
      expiresAt: Date.now() + ttl,
      timer,
    })
    this.total += parsed.bytes.length
    return { src: url }
  }

  stop(): void {
    this.stopped = true
    for (const token of [...this.entries.keys()]) this.drop(token)
    const stack = this.bot.ctx.server.stack
    const index = this.layer ? stack.indexOf(this.layer) : -1
    if (index >= 0) stack.splice(index, 1)
    this.layer = undefined
  }

  private itemLimit(kind: string): number {
    const cap = kind === 'image' || kind === 'emoji'
      ? this.bot.config.inboundMediaMaxBytes ?? DEFAULT_INBOUND_MEDIA_MAX_BYTES
      : this.bot.config.inboundAttachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES
    const pool = this.bot.config.inboundMediaRelayMaxBytes ?? DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES
    return Math.min(cap, pool)
  }

  private take(token: string): RelayEntry | undefined {
    if (!TOKEN_PATTERN.test(token)) return
    const entry = this.entries.get(token)
    if (!entry) return
    if (entry.expiresAt <= Date.now()) {
      this.drop(token)
      return
    }
    return entry
  }

  private sweep(): void {
    const now = Date.now()
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.drop(token)
    }
  }

  private drop(token: string): void {
    const entry = this.entries.get(token)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(token)
    this.total -= entry.bytes.length
  }
}
