/**
 * WeBridge 平台适配器的主体。
 *
 * Koishi 在这里扮演 WeBridge 协议里的「服务端」：手机上的 WeBridge 插件作为
 * WebSocket 客户端连进来，推 `event` 帧、收 `command` 帧。
 *
 * WebSocket 路由挂在 Koishi 自带的 server 服务上（`@koishijs/plugin-server`），
 * 不自开端口 —— 端口、TLS、反代都由 Koishi 那边统一管。
 *
 * 协议来源：WeBridge 插件作者提供的《服务端 WebSocket 协议说明》（v0.8.79）。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
// 注意：从 `@satorijs/core` 导入 Bot / Context / Schema / h，**不要**从 `koishi` 导入。
// koishi 的 Context 与 satori `Bot<C extends Context>` 约束里的 Context 不是同一个类型，
// 混用会让整个泛型体系对不上。这也是官方适配器（如 @satorijs/adapter-telegram）的做法。
import { Bot, type Context, Schema, h, Universal } from '@satorijs/core'
// 副作用导入：只为加载 `@cordisjs/plugin-server` 对 Context 的模块增强，
// 让 `this.ctx.server` 有类型。
import {} from '@koishijs/plugin-server'

import { WebridgeServer } from './adapter.js'
import { WebridgeDirectory } from './directory.js'
import { Config as ArchiveConfig, installArchive, type ArchiveService } from './archive/index.js'
import type { Context as KoishiContext } from '@koishijs/core'
import { WebridgeInternal } from './internal.js'
import { WebridgeMessageEncoder } from './message.js'
import { InboundMediaReceiver, DEFAULT_INBOUND_MEDIA_MAX_BYTES, DEFAULT_INBOUND_MEDIA_TIMEOUT } from './media.js'
import {
  InboundMediaRelay,
  DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES,
  DEFAULT_INBOUND_MEDIA_RELAY_MAX_ITEMS,
  DEFAULT_INBOUND_MEDIA_RELAY_TTL,
} from './media-relay.js'
import type { InboundMediaContent } from './media.js'
import { DEFAULT_ATTACHMENT_MAX_BYTES, type MessageMediaKind } from './media-format.js'
import { WebridgeCommandError, WebridgeTransportError } from './error.js'
import {
  contactToFriend,
  contactToGuild,
  contactToGuildMember,
  contactToUser,
  parseOffset,
  roomToGuild,
} from './contacts.js'
import {
  // 只留 satori 标准方法用得到的命令名（其余非标准能力在 internal.ts 里，用的是同一批常量）
  CMD_ACCOUNT_STATUS,
  CMD_DELETE_FRIEND,
  CMD_FRIENDS,
  CMD_FRIENDS_ALL,
  CMD_GROUPS_ALL,
  CMD_KICK_GROUP_MEMBER,
  CMD_REVOKE_MESSAGE,
  CMD_ROOM_MEMBERS,
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_ECHO_TIMEOUT,
  DEFAULT_MEDIA_TIMEOUT,
  FRAME_COMMAND_RESULT,
  FRAME_EVENT,
  FRAME_HELLO,
  FRAME_PONG,
  SERVER_VERSION,
  buildCommand,
  buildHelloAck,
  createTimeToSeconds,
  dedupKey,
  eventAgeSeconds,
  GROUP_MEMBER_EVENT_MAP,
  buildEventPayload,
  canAcceptFriendRequest,
  frameKind,
  groupMemberId,
  groupMemberProfile,
  groupMemberRoomId,
  inboundMedia,
  inboundMentions,
  inboundMessageLabel,
  inboundText,
  isSelfMessage,
  MEDIA_LABELS,
  MENTION_ALL,
  MSG_SUBTYPE_QUOTE,
  nonMessageEventLabel,
  previewContent,
  quoteEventDetail,
  stripLeadingMentions,
} from './protocol.js'
import type { InboundMediaKind } from './protocol.js'
import { loadOrCreateSecret } from './secret.js'
import {
  buildHttpUrl,
  buildWebSocketUrl,
  formatHost,
  isLoopbackHost,
  parseCallbackAddress,
  selectLanAddress,
} from './url.js'
import type {
  AccountStatusResult,
  CommandResultFrame,
  EventBody,
  EventFrame,
  FriendsAllResult,
  FriendsResult,
  GroupsAllResult,
  HelloFrame,
  RoomMembersResult,
} from './types.js'

/** `Channel.Type`（@sarijs/protocol）：0 = 文字频道（群里用），1 = 私聊。 */
const CHANNEL_TYPE_TEXT = 0
const CHANNEL_TYPE_DIRECT = 1

/** `WebSocket.OPEN`。用字面量避免为了一个常量去直接依赖 `ws` 包。 */
const WS_OPEN = 1

/**
 * 在 loader 的 YAML 配置树里找到本插件的配置对象。
 *
 * loader 会给插件 key 加随机后缀（如 `adapter-webridge:cf17f3`），所以按前缀匹配。
 * 停用的插件 key 前面带 `~`，也一并处理。
 */
function findPluginConfig(node: any, name: string): Record<string, any> | undefined {
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const normalized = key.replace(/^~/, '')
    if (normalized === name || normalized.startsWith(`${name}:`)) {
      return value as Record<string, any>
    }
    const found = findPluginConfig(value, name)
    if (found) return found
  }
}

/** 事件去重缓存容量。插件断线重连会补发，重复是预期行为。 */
const DEDUP_CACHE_SIZE = 2000

/** `friends` 的分页步长。协议里这条命令的 `limit` 默认就是 100。 */
const FRIEND_PAGE_SIZE = 100

/**
 * `session.setInternal()` 用的类型名，也是会话上那个属性的名字 ——
 * 用户插件读的是 `session.webridge`，类型声明在 `src/index.ts` 的模块增强里。
 */
const WEBRIDGE_INTERNAL_TYPE = 'webridge'

/**
 * 只有取得真实内容才生成资源元素；失败或协议缺少取件能力时明确退回文本。
 */
function mediaElement(kind: InboundMediaKind, content?: InboundMediaContent): h {
  if (content?.status === 'ready' && content.src) {
    const type = kind === 'voice' ? 'audio' : kind === 'video' ? 'video' : kind === 'file' ? 'file' : 'img'
    return h(type, { src: content.src, ...(content.filename ? { title: content.filename } : {}) })
  }
  const unavailable = ['image', 'voice', 'video', 'file', 'emoji'].includes(kind)
  return h.text(`[${MEDIA_LABELS[kind]}${unavailable ? '：内容暂不可用' : ''}]`)
}

/** 路径密钥允许的字符集。 */
const SECRET_PATTERN = /^[A-Za-z0-9_-]*$/

interface PendingCommand {
  commandName: string
  resolve: (frame: CommandResultFrame) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 一条「等设备回推自己那条消息」的登记。
 *
 * 匹配条件是「同一会话 + 同一正文」，因为协议里没有别的东西能把一条
 * `command_result` 和随后那帧自发消息对应起来。
 */
interface EchoWaiter {
  /** 会话 ID（群是 `*@chatroom`，私聊是 wxid）。 */
  channelId: string
  /** 归一化后的正文，见 `normalizeEchoText()`。 */
  text: string
  /** 这次发送用的引用目标（`quote_message_id`）。引用回复的回推帧靠它对上。 */
  quoteId?: string
  resolve: (messageId?: string) => void
  timer?: NodeJS.Timeout
  settled?: boolean
}

/** `waitForSelfEcho()` 的返回值：用法见那个方法上的说明。 */
export interface SelfEchoHandle {
  /** 匹配到回推时兑现成 `message_id`；没人调 `wait()`/`cancel()` 就一直挂着。 */
  promise: Promise<string | undefined>
  /** 命令回执之后调用：在窗口内等回推，超时兑现 `undefined`。 */
  wait: (timeout?: number) => Promise<string | undefined>
  /** 命令没发出去、或不想等了：撤掉登记并兑现 `undefined`。 */
  cancel: () => void
}

/**
 * 归一化正文，用于「发出去的内容」和「回推帧的内容」比对。
 *
 * 只做最保守的处理：去掉首尾空白、把连续空白折成一个空格。**不做模糊匹配** ——
 * 撤错人是要出事的（撤回别人的消息），宁可拿不到 ID、让 `deleteMessage()` 报错，
 * 也不能把 ID 挂到一条不相干的消息上。
 */
function normalizeEchoText(content: unknown): string {
  return String(content ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

export class WebridgeBot<
  C extends Context = Context,
  T extends WebridgeBot.Config = WebridgeBot.Config,
> extends Bot<C, T> {
  static inject = ['server']
  static reusable = true
  static MessageEncoder = WebridgeMessageEncoder

  declare internal: WebridgeInternal

  /**
   * 配置的 Schema。
   *
   * **必须挂在类上（静态属性）**：Koishi 取插件的配置 Schema 时读的是 `Plugin.Config` ——
   * 也就是类 / 函数自身上的属性。写在 namespace 里的 `export const Config` 属于
   * namespace 对象，不会出现在类上。
   *
   * 注意：**Schema 里的默认值不是运行时唯一的默认值来源** —— 见下面的 `defaults`。
   */
  static Config = Schema.object({
    directoryCacheTtl: Schema.number().min(1000).max(86400000).default(300000).role('ms').description('群资料与成员目录的缓存时间。'),
    directoryTimeout: Schema.number().min(0).max(10000).default(1000).role('ms').description('首次消息补齐昵称的最长等待时间；超时继续处理消息。'),
    directoryCapacity: Schema.number().min(1).max(4096).step(1).default(256).description('每个机器人最多缓存的群目录数。'),
    archive: Schema.object({
      enabled: Schema.boolean().default(false).description('保存聊天记录、通讯录与成员变更历史，需要数据库。'),
      ...ArchiveConfig.dict,
    }).description('可选归档'),
    address: Schema.string()
      .default('')
      .role('link')
      .description(
        '完整的 WebSocket 地址（含路径和密钥）。例如 ws://192.168.1.4:5140/webridge/xxxx。' +
          '留空时首次启动自动生成，并写回这里；之后只改这一条地址即可。',
      ),
    selfId: Schema.string().default('webridge').description('机器人标识。'),
    commandTimeout: Schema.natural()
      .default(DEFAULT_COMMAND_TIMEOUT)
      .role('ms')
      .description('等待命令结果的超时。'),
    mediaTimeout: Schema.natural()
      .default(DEFAULT_MEDIA_TIMEOUT)
      .role('ms')
      .description(
        '发语音/视频/文件时等待命令结果的超时。设备要先把 URL 下载下来再转码' +
          '（协议文档说这类命令耗时可达数秒以上），所以和普通命令分开，默认放宽到 2 分钟。',
      ),
    echoTimeout: Schema.natural()
      .default(DEFAULT_ECHO_TIMEOUT)
      .role('ms')
      .description(
        '发送文本后等待设备回推自己那条消息的超时。回推帧是 message_id 的唯一来源，' +
          '拿到它 bot.sendMessage() 才会返回可用的 id、bot.deleteMessage() 才撤回得掉。' +
          '真机上回推只比命令回执晚几毫秒，这个超时只是兜底；填 0 表示完全不等（也就不返回 id）。',
      ),
    dropStaleEventSeconds: Schema.natural()
      .default(120)
      .description(
        '丢弃迟到事件的秒数。手机插件断线重连会把停机期间的事件补发回来，' +
          '超过这个秒数的直接丢弃，避免机器人突然回复一条很久以前的消息。填 0 表示不过滤。',
      ),
    acceptMedia: Schema.boolean()
      .default(true)
      .description(
        '允许业务插件处理收到的图片、语音、视频、文件、表情和卡片等消息。' +
          '图片、表情、语音、视频和文件统一由新版手机原生取件并回传，转换为标准元素。取件失败时保留说明。关闭不影响发送。',
      ),
    inboundMediaTimeout: Schema.natural().min(1000).max(200_000).default(DEFAULT_INBOUND_MEDIA_TIMEOUT)
      .role('ms').description('获取入站媒体内容的总超时。超时后保留消息与不可用说明。'),
    inboundMediaMaxBytes: Schema.natural().min(1024).max(32 * 1024 * 1024).default(DEFAULT_INBOUND_MEDIA_MAX_BYTES)
      .description('单张入站图片和表情最大字节数；默认 5 MiB，超限不会交给业务插件。'),
    inboundAttachmentMaxBytes: Schema.natural().min(1024).max(32 * 1024 * 1024).default(DEFAULT_ATTACHMENT_MAX_BYTES)
      .description('入站语音、视频和文件的最大字节数；默认 20 MiB，也约束语音解码后的大小。'),
    inboundMediaRelay: Schema.boolean().default(false).description(
      '将取件成功的入站媒体临时托管在 server 上，并把元素 src 换成带路径令牌的 http(s) 地址，便于原样转发。' +
        '默认关闭。关闭时仍使用 data: URL，且不注册托管路由；修改开关后需要重新加载适配器。',
    ),
    inboundMediaRelayTtl: Schema.natural().min(1000).max(3_600_000).default(DEFAULT_INBOUND_MEDIA_RELAY_TTL)
      .role('ms').description('托管地址有效期。到期后删除字节并返回 404。默认 5 分钟。'),
    inboundMediaRelayMaxItems: Schema.natural().min(1).max(256).default(DEFAULT_INBOUND_MEDIA_RELAY_MAX_ITEMS)
      .description('同时保留的托管条数。达到上限时新的媒体仍以 data: URL 投递，不删除尚未过期的条目。'),
    inboundMediaRelayMaxBytes: Schema.natural().min(1024).max(256 * 1024 * 1024).default(DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES)
      .description('全部托管媒体的总字节上限。单条仍受入站图片或附件上限约束；放不下时该条保持 data: URL。'),
    quoteOnReply: Schema.boolean()
      .default(true)
      .description(
        '发送文字回复时，自动引用触发本次回复的原消息。' +
          '关闭后默认直接回复；插件主动指定的引用仍然有效。',
      ),
  })

  /**
   * 各配置项的默认值（**与上面 Schema 里的 `default()` 必须一致**）。
   *
   * 为什么要有这一份：schemastery 的 `default()` 只在 schema 被**调用**时才填值，
   * 而 `ctx.plugin(WebridgeBot, {...})` 这种直接注册（测试、以及别的插件内嵌本适配器时）
   * 根本不会调 schema —— 那时 `this.config.quoteOnReply` 就是 `undefined`，
   * 插件行为会跟控制台里显示的默认值对不上（这个坑踩过一次：控制台显示默认开着自动引用，
   * 运行时却不引用）。
   *
   * 两份默认值会不会写岔？类型检查兜着：`Required<Config>` 要求每个字段都有值，
   * 而 Schema 里的 `default()` 由 schemastery 的类型推断出字面量，
   * 少写一个字段这里立刻编译不过（`pnpm typecheck` 覆盖）。
   * 超时那两个用的是 `protocol.ts` 里的常量，Schema 与这里读的是同一个值。
   */
  static defaults: Required<WebridgeBot.Config> = {
    directoryCacheTtl: 300000,
    directoryTimeout: 1000,
    directoryCapacity: 256,
    archive: { enabled: false },
    address: '',
    selfId: 'webridge',
    commandTimeout: DEFAULT_COMMAND_TIMEOUT,
    mediaTimeout: DEFAULT_MEDIA_TIMEOUT,
    echoTimeout: DEFAULT_ECHO_TIMEOUT,
    dropStaleEventSeconds: 120,
    acceptMedia: true,
    inboundMediaTimeout: DEFAULT_INBOUND_MEDIA_TIMEOUT,
    inboundMediaMaxBytes: DEFAULT_INBOUND_MEDIA_MAX_BYTES,
    inboundAttachmentMaxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
    inboundMediaRelay: false,
    inboundMediaRelayTtl: DEFAULT_INBOUND_MEDIA_RELAY_TTL,
    inboundMediaRelayMaxItems: DEFAULT_INBOUND_MEDIA_RELAY_MAX_ITEMS,
    inboundMediaRelayMaxBytes: DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES,
    quoteOnReply: true,
  }

  /** `ctx.server.ws()` 返回的路由层，卸载时用它关掉路由与所有 socket。 */
  private layer?: { close(): void }

  /** 完整地址里带的 origin；有值时优先用它生成对外地址。 */
  private addressOrigin?: string

  /** 从完整地址解析出的路由路径（不含 secret）。 */
  private routePath = '/webridge'

  /** 从完整地址解析出的密钥；地址里没有时会自动生成。 */
  private secret = ''

  /** 当前已握手的设备连接。WeBridge 是「一台手机一个微信号」，只维护一条。 */
  private socket?: WebSocket
  private mediaReceiver?: InboundMediaReceiver
  /** 仅在启动时开启 inboundMediaRelay 后存在；关闭开关不会注册这条路由。 */
  private mediaRelay?: InboundMediaRelay
  private inboundQueues = new Map<string, Promise<void>>()
  private inboundQueued = 0
  private inboundGeneration = 0
  private handshakes = new WeakSet<WebSocket>()
  private handshakeTimers = new Map<WebSocket, NodeJS.Timeout>()

  /**
   * 设备上的真实账号（wxid，如 `wxid_abc123`），握手时由设备给出。
   *
   * 和 `selfId` 是两回事：`selfId` 是给 Koishi 用的标识（配置值），这里是设备上的
   * 真实 wxid —— `at_user_list` 里出现的机器人就是它。用它把「机器人被 @ 了」
   * 从名单里认出来。
   */
  deviceAccountId?: string
  readonly directory: WebridgeDirectory
  /** 开启归档且数据库就绪后可查询历史；通讯录接口不依赖此模块。 */
  archive?: ArchiveService
  /** 归档事件契约版本；独立于普通消息中间件。 */
  readonly archiveEventsVersion = 1

  /**
   * 设备在 `hello` 里自报的支持命令清单。
   *
   * 协议 13 明确要求：**不要硬编码这份清单**，以每次 `hello` 实际收到的为准 ——
   * 它随插件版本变化（0.8.76 及更早版本的清单就有缺口，能执行但不在清单里）。
   *
   * `supportsCommand()` 在清单为空时允许尝试；清单非空时按实际声明判断。
   * 发送入口不会据此硬性过滤，老版本设备可能存在清单缺口。
   */
  capabilities: string[] = []

  /** `request_id` → 等待中的命令。 */
  private pending = new Map<string, PendingCommand>()

  /**
   * 收到的好友申请，按 `message_id` 索引。
   *
   * 为什么需要：satori 的 `handleFriendRequest(messageId, approve)` 只给一个
   * `message_id`，而微信的 `accept_friend_request` 要的是
   * `encrypt_username` + `ticket`（协议 15.7）。两者之间没有查询接口，
   * 只能收到事件时先记下来。
   *
   * 有界：保留最近 200 条，避免长期运行内存膨胀（好友申请是低频事件）。
   */
  private friendRequests = new Map<string, Record<string, unknown>>()

  /** 事件去重。用 Set 判重 + 数组维护淘汰顺序。 */
  private seen = new Set<string>()
  private seenOrder: string[] = []

  /**
   * 等待「设备回推自己刚发出的那条消息」的登记（见 `waitForSelfEcho()`）。
   *
   * 顺序有意义：同样的正文连发两条时，先登记的先匹配 —— 回推帧也是按发送顺序来的。
   */
  private echoWaiters: EchoWaiter[] = []

  constructor(ctx: C, config: T) {
    // 先补默认值再交给基类。`config` 允许只写一小部分字段（见 namespace 里的注释）。
    super(ctx, { ...WebridgeBot.defaults, ...config }, 'webridge')
    // 先解析「完整地址」，把 path/secret 拆回旧字段；地址为空时沿用旧配置。
    this.applyAddressConfig()
    // 没配 secret 时首次启动生成并持久化，之后重启沿用同一个值。
    this.resolveSecret()
    this.selfId = this.config.selfId || 'webridge'
    // 平台原生能力统一走内部接口 —— 官方指引：不直接加在 Bot 上，
    // 免得将来 satori 扩展通用接口时撞名（详见 internal.ts 顶部注释）。
    this.internal = new WebridgeInternal(this)
    this.directory = new WebridgeDirectory(
      guildId => this.query<RoomMembersResult>(CMD_ROOM_MEMBERS, { room_id: guildId }),
      () => this.deviceAccountId, this.config.directoryCacheTtl, this.config.directoryCapacity,
      async (guildId, userId) => {
        if (!this.archive) return new Map()
        const session = this.session({ type: 'internal', guild: { id: guildId }, channel: { id: guildId, type: CHANNEL_TYPE_TEXT },
          user: userId ? { id: userId } : undefined })
        session.setInternal(WEBRIDGE_INTERNAL_TYPE, { accountId: this.deviceAccountId })
        const rows = userId ? [await this.archive.member(session as any, userId)] : await this.archive.members(session as any, true)
        return new Map(rows.filter(row => row && typeof row.roomNickname === 'string').map(row => [row!.userId, row!.roomNickname]))
      },
    )
    if (this.config.archive?.enabled) {
      this.ctx.inject(['database'], ctx => {
        // Koishi 会为 Bot 包代理对象，不能按对象引用比较所属机器人。
        const scope = (ctx as unknown as KoishiContext).intersect(session => session.platform === this.platform && session.selfId === this.selfId
          && session.resolve(this.config.archive?.filter ?? true))
        const archive = installArchive(scope, ArchiveConfig(this.config.archive as any))
        this.archive = archive
        ctx.on('dispose', () => { if (this.archive === archive) this.archive = undefined })
      })
      this.ctx.on('ready', () => {
        this.ctx.setTimeout(() => {
          if (!this.archive) this.logger.warn('归档已开启但数据库不可用；消息收发与通讯录仍可使用。')
        }, 1000)
      })
    }
    // v4 的 `Bot.start()` 调的是 `this.adapter?.connect(this)`，所以「起服务端」这件事
    // 只能挂在 Adapter 上（写在 Bot 的 connect() 里永远不会被调用）。
    // 这里按官方做法把 Adapter 注册成插件，由它负责把自己挂到 bot 上 ——
    // 细节和「为什么不用 Adapter.fork()」见 adapter.ts。
    this.ctx.plugin(WebridgeServer, this)
    // 路由清理不能依赖设备的在线状态，插件卸载时必须释放所有连接与等待项。
    this.ctx.on('dispose', () => this.teardownRoute())
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  /**
   * 解析「完整地址」配置。
   *
   * 地址里的最后一段是 secret，前面的部分是路由 path；解析后写回旧字段，
   * 这样注册路由、生成地址都只需要读 path/secret。
   */
  private applyAddressConfig(): void {
    const raw = (this.config.address || '').trim()
    if (!raw) {
      this.routePath = '/webridge'
      this.secret = ''
      return
    }
    const parsed = parseCallbackAddress(raw)
    this.addressOrigin = parsed.origin
    this.routePath = parsed.path
    this.secret = parsed.secret
  }

  /**
   * 把实际使用的完整地址写回 koishi.yml 的插件配置。
   *
   * `scope.update()` 在部分作用域下不会触发 loader 的写盘钩子，所以这里直接改
   * loader 持有的配置树再调 `writeConfig()`；只改配置、不重启插件。
   */
  private persistAddress(address: string): void {
    this.config.address = address

    const loader = (this.ctx as any).get('loader')
    const root = loader?.config
    if (!root) return

    const entry = findPluginConfig(root, 'adapter-webridge')
    if (!entry) {
      this.logger.debug('未找到 adapter-webridge 配置项，跳过完整地址回写')
      return
    }

    let changed = false
    if (entry.address !== address) {
      entry.address = address
      changed = true
    }
    // 旧版本留下的字段：既然不再兼容，就从配置文件里清掉。
    for (const key of ['path', 'secret', 'publicUrl']) {
      if (key in entry) {
        delete entry[key]
        changed = true
      }
    }
    if (!changed) return

    try {
      const task = loader.writeConfig?.()
      task?.catch?.((error: any) => {
        this.logger.warn('写回完整地址失败：%s', error?.message ?? error)
      })
    } catch (error: any) {
      this.logger.warn('写回完整地址失败：%s', error?.message ?? error)
    }
  }

  /**
   * 解析路径密钥：配置优先；没有配置时读 `data/adapter-webridge.json`；
   * 两者都没有就首次生成并写盘；结果写进内部的 `this.secret`。
   */
  private resolveSecret(): string {
    if (this.secret) return this.secret

    const baseDir = (this.ctx as any).baseDir || process.cwd()
    const file = join(baseDir, 'data', 'adapter-webridge.json')
    const result = loadOrCreateSecret(file, '')
    this.secret = result.secret
    if (result.source === 'generated') {
      this.logger.info('首次启动：已自动生成 secret 并保存到 %s', file)
    }
    if (result.warning) this.logger.warn(result.warning)
    return this.secret
  }

  /** 注册 WebSocket 路由。由 `WebridgeServer.connect()` 调用。 */
  setupRoute(): void {
    const endpoint = this.endpointPath()
    const secret = this.secret.trim()

    if (!SECRET_PATTERN.test(secret)) {
      // 路径要交给 path-to-regexp 编译，密钥里出现 : * ( ) 之类的元字符会
      // 让匹配规则和我们的预期不一致。与其静默放宽，不如直接拒绝启动。
      throw new Error(
        `secret 只能包含字母、数字、下划线和连字符，当前值为 ${JSON.stringify(secret)}`,
      )
    }

    // 先生成完整地址再注册路由：address 配错时直接报错，不留下半注册的路由。
    const callbackUrl = this.callbackUrl()
    // 把最终地址写回基础设置的「完整地址」字段；已一致时不会重复写。
    this.persistAddress(callbackUrl)

    this.layer = this.ctx.server.ws(endpoint, (socket, request) => {
      this.onConnection(socket, request, endpoint)
    })
    // 每个 Bot 独立路由，防止相同路由前缀下的多账号互相截获上传。
    const mediaPath = `${this.routePath}/media/upload/${randomUUID()}`
    this.mediaReceiver = new InboundMediaReceiver(this, mediaPath, (token) => {
      return buildHttpUrl(this.callbackBaseUrl(), `${mediaPath}/${token}`)
    })
    this.mediaReceiver.start()
    if (this.config.inboundMediaRelay) {
      const relayPath = `${this.routePath}/media/relay/${randomUUID()}`
      this.mediaRelay = new InboundMediaRelay(this, relayPath, (token) => {
        return buildHttpUrl(this.callbackBaseUrl(), `${relayPath}/${token}`)
      })
      this.mediaRelay.start()
      this.logger.info(
        '入站媒体托管已开启 ttl=%dms maxItems=%d maxBytes=%d',
        this.config.inboundMediaRelayTtl ?? DEFAULT_INBOUND_MEDIA_RELAY_TTL,
        this.config.inboundMediaRelayMaxItems ?? DEFAULT_INBOUND_MEDIA_RELAY_MAX_ITEMS,
        this.config.inboundMediaRelayMaxBytes ?? DEFAULT_INBOUND_MEDIA_RELAY_MAX_BYTES,
      )
    }

    // 对外只打印一条完整地址：path 与 secret 不再分开显示，用户直接复制这一行。
    // 路由注册信息只留在 debug 里，而且只打 path，避免和完整地址重复。
    this.logger.debug('WebSocket 路由已注册 path=%s', this.routePath)
    this.logger.info('手机 WeBridge 的「WebSocket 服务端地址」填：%s', callbackUrl)

    // 只监听 loopback 且没有填对外地址时，生成的地址手机一定连不上；提前说清楚。
    const host = this.ctx.server.host
    if (host && !this.addressOrigin && !this.ctx.server.config?.selfUrl && isLoopbackHost(host)) {
      this.logger.warn(
        'server 只监听了 %s，手机无法通过局域网访问；请把 server.host 改成 0.0.0.0，或填写完整地址',
        host,
      )
    }

    // RECONNECT 表示服务正在等待设备，仍属于 active，基类 stop() 会正常清理路由。
    this.status = Universal.Status.RECONNECT
  }

  /** 注销路由并断开连接。由 `WebridgeServer.disconnect()` 调用。 */
  teardownRoute(): void {
    this.directory?.clear()
    this.socket = undefined
    this.cancelInbound()
    this.mediaReceiver?.stop()
    this.mediaReceiver = undefined
    this.mediaRelay?.stop()
    this.mediaRelay = undefined
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer)
    this.handshakeTimers.clear()
    // WebSocketLayer.close() 会把自己从 wsStack 摘掉并关掉所有 socket ——
    // 不调它的话，bot 重载后旧路由会一直留在服务端上。
    try {
      this.layer?.close()
    } catch {
      /* 关路由失败没有补救手段 */
    }
    this.layer = undefined
    this.clearWaiting(new Error('WebridgeBot 已断开'))
  }

  private clearWaiting(error: Error): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new WebridgeTransportError('disconnected', requestId, entry.commandName, error.message))
    }
    this.pending.clear()
    for (const waiter of [...this.echoWaiters]) waiter.resolve(undefined)
  }

  // ------------------------------------------------------------------
  // 连接与帧分派
  // ------------------------------------------------------------------

  private onConnection(socket: WebSocket, request: IncomingMessage, expectedPath: string) {
    const logger = this.logger
    const remote = request.socket?.remoteAddress ?? 'unknown'

    // 路由已经用 path-to-regexp 匹配过一次，这里再按字符串精确确认一次，
    // 免得密钥里出现正则元字符时路由被静默放宽。
    let pathname = ''
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      pathname = ''
    }
    if (pathname !== expectedPath) {
      logger.warn('拒绝连接：路径不匹配 remote=%s path=%s', remote, pathname)
      socket.close(1008, 'invalid path')
      return
    }

    logger.info('插件已连接，等待 hello remote=%s', remote)
    const timer = setTimeout(() => {
      this.handshakeTimers.delete(socket)
      socket.close(1008, 'hello timeout')
    }, 10_000)
    timer.unref()
    this.handshakeTimers.set(socket, timer)

    socket.addEventListener('message', (event: any) => {
      void this.onFrame(socket, String(event.data)).catch((error: unknown) => {
        logger.warn('处理设备帧失败：%s', error instanceof Error ? error.message : String(error))
        socket.close(1008, 'invalid frame')
      })
    })
    socket.addEventListener('close', () => {
      clearTimeout(this.handshakeTimers.get(socket))
      this.handshakeTimers.delete(socket)
      if (this.socket === socket) {
        this.socket = undefined
        this.cancelInbound()
        this.capabilities = []
        this.clearWaiting(new Error('WeBridge 设备连接已断开'))
        if (this.layer) this.status = Universal.Status.RECONNECT
      }
      logger.info('连接已断开 remote=%s', remote)
    })
    socket.addEventListener('error', (event: any) => {
      logger.warn('连接出错 remote=%s: %s', remote, event?.message ?? event)
    })
  }

  private async onFrame(socket: WebSocket, raw: string): Promise<void> {
    const logger = this.logger

    let frame: any
    try {
      frame = JSON.parse(raw)
    } catch {
      logger.warn('收到非法 JSON，已忽略')
      return
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      logger.warn('帧不是 JSON 对象，已忽略')
      return
    }

    if (socket.readyState !== WS_OPEN) return
    if (frame.type === FRAME_EVENT || frame.type === FRAME_COMMAND_RESULT) {
      if (socket !== this.socket || !this.handshakes.has(socket)) {
        logger.warn('忽略未握手或已替换连接的帧 type=%s', frame.type)
        return
      }
    }

    switch (frame.type) {
      case FRAME_HELLO:
        this.onHello(socket, frame as HelloFrame)
        return
      case FRAME_EVENT:
        if (typeof frame.event_name !== 'string' || !frame.body
          || typeof frame.body !== 'object' || Array.isArray(frame.body)) {
          logger.warn('事件帧结构不完整，已忽略')
          return
        }
        this.onEvent(frame as EventFrame)
        return
      case FRAME_COMMAND_RESULT:
        if (typeof frame.request_id !== 'string' || typeof frame.ok !== 'boolean') {
          logger.warn('命令结果帧结构不完整，已忽略')
          return
        }
        this.onCommandResult(frame as CommandResultFrame)
        return
      case FRAME_PONG:
        return
      default:
        // 协议要求忽略不认识的 type，不要报错、不要断开。
        logger.debug('忽略未知帧 type=%s', frame.type)
    }
  }

  private onHello(socket: WebSocket, frame: HelloFrame): void {
    const logger = this.logger
    if (this.handshakes.has(socket)) return
    if (typeof frame.device_id !== 'string' || !frame.device_id.trim()
      || typeof frame.session_id !== 'string' || !frame.session_id.trim()
      || typeof frame.account_id !== 'string') {
      socket.close(1008, 'invalid hello')
      return
    }
    clearTimeout(this.handshakeTimers.get(socket))
    this.handshakeTimers.delete(socket)
    this.handshakes.add(socket)

    const previous = this.socket
    if (previous && previous !== socket) {
      this.cancelInbound()
      this.clearWaiting(new Error('WeBridge 设备连接已替换'))
      // 手机重启或网络切换后，旧连接常常还挂在服务端这边；
      // 不顶掉的话，后续命令会发到那条死连接上。
      logger.warn('已有连接，关闭旧的 device_id=%s', frame.device_id)
      previous.close(4000, 'replaced by a newer connection')
    }
    this.socket = socket
    if (this.deviceAccountId && this.deviceAccountId !== frame.account_id) {
      this.seen.clear()
      this.seenOrder = []
      this.friendRequests.clear()
    }
    // 记下设备真实 wxid：入站 @ 判定要用它把机器人自己从 at_user_list 里认出来。
    this.directory?.clear()
    this.deviceAccountId = frame.account_id || undefined
    // 设备自报的支持命令清单（协议 13：以此为准，不要硬编码）
    this.capabilities = Array.isArray(frame.capabilities) ? frame.capabilities.map(String) : []

    logger.info(
      '握手完成 device_id=%s account_id=%s version=%s build=%s capabilities=%d state=%o',
      frame.device_id,
      frame.account_id,
      frame.runtime_version,
      frame.build_marker,
      Array.isArray(frame.capabilities) ? frame.capabilities.length : 0,
      frame.state,
    )
    if (frame.state?.plugin_enabled === false) {
      logger.warn('插件总开关处于关闭状态，命令会被设备拒绝')
    }
    if (frame.state?.auth_authorized === false) {
      logger.warn('插件授权无效，命令会被设备拒绝')
    }

    // 必须立刻回 —— 插件等 10 秒收不到 hello_ack 就会断开重连。
    socket.send(JSON.stringify(buildHelloAck(SERVER_VERSION)))
    this.online()

    // 链路已经通了，顺手问一句「我是谁」，把昵称 / 头像补进 `bot.user`
    // （控制台的机器人状态栏要用）。异步做且失败只记 warn ——
    // 拿不到资料不该影响收发消息，这是握手之后才可能拿到的东西。
    void this.getLogin().catch((error: any) => {
      logger.warn('获取账号资料失败（不影响收发消息）：%s', error?.message ?? error)
    })
  }

  private onCommandResult(frame: CommandResultFrame): void {
    const entry = this.pending.get(frame.request_id)
    if (!entry) {
      this.logger.debug('收到无人认领的 command_result request_id=%s', frame.request_id)
      return
    }
    if (frame.command_name !== entry.commandName) {
      this.logger.warn('命令结果名称不匹配，已忽略 request_id=%s', frame.request_id)
      return
    }
    clearTimeout(entry.timer)
    this.pending.delete(frame.request_id)
    entry.resolve(frame)
  }

  // ------------------------------------------------------------------
  // 入站：event 帧 → Koishi 会话
  // ------------------------------------------------------------------

  private onEvent(frame: EventFrame): void {
    const logger = this.logger

    // 顺序不能换：先去重，再分流，最后才判新鲜度。
    // 协议保证事件会重复（连接抖动、重连补发），不先去掉会在群里刷屏。
    const key = dedupKey(frame)
    if (this.isDuplicate(key)) {
      logger.debug('重复事件已忽略 key=%s', key)
      return
    }

    // 归档先于自发消息、时效和媒体过滤；只广播独立事件，不触发业务回复。
    this.dispatchArchiveEvent(frame)
    if (GROUP_MEMBER_EVENT_MAP[frame.event_name]) this.directory?.observe(frame)

    // 设备会把机器人自己发出去的消息也回推一遍（sender_id 等于机器人自己的
    // account_id）。不丢掉的话，机器人会把自己的输出当成用户输入，
    // 遇到「对任何消息都回复」的逻辑就是无限自我回环。
    if (isSelfMessage(frame, this.deviceAccountId)) {
      // 先兑现等待中的发送登记：这一帧是 `message_id` 的唯一来源。
      this.settleSelfEcho(frame)
      // 自发消息**不能进会话流**（否则机器人会把自己的输出当成输入，遇到「对任何消息都
      // 回复」的逻辑就是无限回环），但这条回推帧是**唯一能拿到 `message_id` 的地方**：
      // 微信的 `send_message` 回执里没有它，而 `revoke_message` 只认它。
      //
      // 这些短 ID（真机见过 `616`、`76`，别人消息则是 19 位）**确实能用**：真机实测把它
      // 交给 `revoke_message` 后，微信立刻回推了一条 `revokemsgcontent` 系统消息，
      // 说明服务端真的撤回了（2026-10-18 实测）。
      // 所以这里不是「只记日志」了 —— 上面那行 `settleSelfEcho()` 会把 ID 交给
      // 正在等它的那一次 `sendMessage()`。
      //
      // 仍然降在 debug 是因为机器人每发一条消息都会走这里，info 级会把正常日志刷满。
      logger.debug(
        '忽略机器人自己发出的消息 sender=%s message_id=%s room=%s content="%s"',
        frame.body?.sender_id,
        frame.body?.message_id ?? '(缺字段)',
        frame.body?.room_id || frame.body?.chat_id || '-',
        previewContent(frame.body?.content),
      )
      return
    }

    // 用户打的字（文本消息、引用回复），和这条消息携带的媒体。
    const rawText = inboundText(frame)
    const media = this.config.acceptMedia ? inboundMedia(frame) : []

    // 既没有正文也没有媒体 —— 群成员变动、好友申请、红包、转账、撤回这些通知事件。
    // 它们不走消息会话，硬塞进事件流反而会污染对话上下文。
    // 新鲜度对它们没意义 —— 记日志本来就是为了排查连通性。
    if (rawText === null && media.length === 0) {
      // 协议 15.1「事件类型总表」里的七种事件，除 message 之外都要派发出去 ——
      // 这些数据在微信侧都没有历史查询，错过就永久丢失。
      // 顺序：群成员（satori 标准事件）→ 红包/转账/好友申请/系统消息（自定义事件）。
      if (this.dispatchGroupMember(frame)) return
      if (this.dispatchPlatformEvent(frame)) return
      // 兜底：协议清单里没有的 event_name。仍然不丢，原样透传。
      // 协议**没有承诺**事件清单是闭合的，静默丢弃会让升级后的新事件凭空消失。
      this.dispatchUnknownEvent(frame)
      logger.info('非文本消息/通知事件：%s', nonMessageEventLabel(frame))
      // 取不到正文的引用消息（XML 里没有 <title>）落在这里，
      // 这时把完整字段打出来才定位得下去。
      if (frame.body?.msg_subtype === MSG_SUBTYPE_QUOTE) {
        logger.info('引用消息诊断 %s', quoteEventDetail(frame))
      }
      return
    }

    if (this.isStale(frame, key)) return

    // 群里 @ 人时正文会带一份「@显示名」（真机样例 "@阿飞 help"）。@ 本身已经由
    // at_user_list 变成 at 段了，正文里这份是重复的，还会插在指令名前面让
    // 「以指令名开头」的匹配失效 —— 真机上 "@阿飞 help" 不剥就永远触发不了指令。
    // **无条件剥**：设备有时**不给** at_user_list（实测 00:39:42 那条 @ 消息就
    // 完全没有 is_at / at_user_list），按「有没有名单」决定剥不剥会漏掉这种情况。
    const text = rawText === null ? '' : stripLeadingMentions(rawText)
    const mediaLabels = media.map((kind) => MEDIA_LABELS[kind])

    const dispatch = async (contents: InboundMediaContent[]) => {
      const session = this.buildSession(frame, text, media, contents)
      if (!session) return
      // 原始字段保留在平台内部接口；通用插件只需读取标准消息元素。
      const { body: frameBody, ...frameFields } = frame
      session.setInternal(WEBRIDGE_INTERNAL_TYPE, { ...frameFields, ...frameBody, media: contents })
      if (this.directory) await this.directory.enrich(session, this.config.directoryTimeout ?? 1000)
      if (frame.account_id && frame.account_id !== this.deviceAccountId) return
      logger.info('收到消息 %s', inboundMessageLabel(frame, text, mediaLabels))
      this.dispatch(session)
    }
    const channelId = String(frame.body.chat_id || frame.body.room_id || frame.body.sender_id || '')
    const contents = media.map((kind): InboundMediaContent => ({ kind, status: 'unavailable', reason: 'no-media-content' }))
    // 同会话后续文字必须等图片取件完毕；命令回执仍直接处理，避免等待自己的回执而死锁。
    const retrievable = ['image', 'voice', 'video', 'file', 'emoji']
    if (!media.some(kind => retrievable.includes(kind)) && !this.inboundQueues.has(channelId) && !this.directory) { void dispatch(contents); return }
    if (this.inboundQueued >= 256) { logger.warn('入站媒体队列已满，忽略新消息'); return }
    const generation = this.inboundGeneration
    this.inboundQueued++
    const task = (this.inboundQueues.get(channelId) ?? Promise.resolve()).then(async () => {
      if (generation !== this.inboundGeneration) return
      for (let index = 0; index < media.length; index++) {
        const kind = media[index]
        if (retrievable.includes(kind)) {
          contents[index] = this.mediaReceiver
            ? await this.mediaReceiver.receive(typeof frame.body.message_id === 'string' ? frame.body.message_id : '', kind as MessageMediaKind)
            : { kind, status: 'unavailable', reason: 'disconnected' }
          if (contents[index].status === 'ready' && this.mediaRelay) {
            const hosted = this.mediaRelay.publish(contents[index])
            if (hosted.src) contents[index].src = hosted.src
            else if (hosted.reason && hosted.reason !== 'disabled') {
              logger.warn('入站媒体未托管 kind=%s reason=%s', kind, hosted.reason)
            }
          }
        }
        if (contents[index].status !== 'ready' && retrievable.includes(kind)) {
          logger.warn('入站媒体内容不可用 kind=%s reason=%s', kind, contents[index].reason)
        } else if (contents[index].status === 'ready') {
          logger.info('入站媒体已就绪 kind=%s mime=%s bytes=%d', kind, contents[index].mime, contents[index].size)
        }
      }
      if (generation === this.inboundGeneration) await dispatch(contents)
    }).catch(() => { logger.warn('入站媒体处理失败') }).finally(() => {
      this.inboundQueued--
      if (this.inboundQueues.get(channelId) === task) this.inboundQueues.delete(channelId)
    })
    this.inboundQueues.set(channelId, task)
  }

  private cancelInbound(): void {
    this.inboundGeneration++
    this.inboundQueues.clear()
    this.mediaReceiver?.cancel()
  }

  /** 广播原始归档会话，不进入消息中间件。 */
  private dispatchArchiveEvent(frame: EventFrame): void {
    const body = frame.body ?? {}
    const channelId = String(body.room_id || body.chat_id || '')
    if (!channelId || !this.deviceAccountId) return
    const group = channelId.endsWith('@chatroom')
    const session = this.session({
      type: 'internal',
      channel: { id: channelId, type: group ? 0 : 1 },
      guild: group ? { id: channelId } : undefined,
      user: { id: String(body.member_id || body.sender_id || '') },
      timestamp: this.eventTimestamp(frame),
    })
    session.setInternal(WEBRIDGE_INTERNAL_TYPE, {
      ...frame, ...body, accountId: this.deviceAccountId,
    })
    ;(this.ctx as Context).emit(session as any, 'webridge/archive-event', session as any)
  }

  /**
   * 把群成员变更事件派发成 satori 的标准事件。
   *
   * @returns 是否真的是群成员事件（是则调用方不再走「非消息事件」分支）。
   *
   * 三条协议事件 → 三个 satori 标准事件（`@satorijs/core` 的 `Events` 里都有声明）：
   * `group_member_join` → `guild-member-added`、`group_member_leave` →
   * `guild-member-removed`、`group_member_nickname_change` → `guild-member-updated`。
   *
   * 为什么两种事件都发：
   * - **satori 标准事件**让生态里任何插件（控制台、权限、统计）都能感知成员变动，
   *   不必知道 WeBridge 的存在；
   * - 同时把**原始帧**挂进 `session.webridge`，因为 satori 的 `GuildMember` 表达不了
   *   `room_nick_name` / `snapshot_before_count` / `new_room_nick_name` 这些字段，
   *   归档类插件需要完整原文。
   */
  private dispatchGroupMember(frame: EventFrame): boolean {
    const eventName = String(frame?.event_name ?? '')
    const sessionType = GROUP_MEMBER_EVENT_MAP[eventName]
    if (!sessionType) return false

    const roomId = groupMemberRoomId(frame)
    const memberId = groupMemberId(frame)
    if (!roomId || !memberId) {
      // 结构不完整时不派发，但仍然告诉调用方「这是群成员事件」，
      // 免得它被记成一条莫名其妙的「非文本消息」。
      this.logger.warn(
        '群成员事件结构不完整，已跳过派发 event=%s room_id=%o member_id=%o',
        eventName,
        frame?.body?.room_id,
        frame?.body?.member_id,
      )
      return true
    }

    const profile = groupMemberProfile(frame)
    const displayName = profile.roomNickname || profile.displayName || profile.nickname || memberId

    // 按 satori 的契约构造 event：member 里放 GuildMember，user 单独给。
    // 参考官方适配器（discord / kook / qq 的 utils.ts）都是这个形状。
    const member: Record<string, unknown> = {
      nick: profile.roomNickname || profile.nickname || undefined,
      avatar: undefined,
      joined_at: sessionType === 'guild-member-added' ? this.eventTimestamp(frame) : undefined,
    }
    if (sessionType === 'guild-member-removed') {
      delete member.joined_at
      delete member.nick
    }

    const session = this.session({
      type: sessionType,
      guild: { id: roomId, name: '' },
      channel: { id: roomId, type: CHANNEL_TYPE_TEXT },
      user: { id: memberId, name: displayName },
      member: member as any,
      timestamp: this.eventTimestamp(frame),
    } as any)
    // 原始帧 + 解析出的资料一起挂上去：归档插件读 session.webridge 即可，
    // 不必再去翻日志或重解析 XML。
    session.setInternal(WEBRIDGE_INTERNAL_TYPE, {
      ...frame,
      ...frame.body,
      roomId,
      memberId,
      profile,
    })
    this.logger.debug(
      '群成员事件 %s room=%s member=%s profile=%o',
      eventName,
      roomId,
      memberId,
      profile,
    )
    this.dispatch(session)
    return true
  }

  /** 群成员事件的毫秒时间戳（`create_time` 是秒）。 */
  private eventTimestamp(frame: EventFrame): number {
    return createTimeToSeconds(frame?.body?.create_time) * 1000
  }

  /**
   * 派发「satori 没有标准结构，但协议有定义」的事件。
   *
   * 覆盖协议 15.1 里剩下的四种：
   *
   * | 协议事件 | 派发 |
   * |---|---|
   * | `friend_request` | satori 标准 `friend-request` + 自定义 `webridge/friend-request` |
   * | `red_packet_received` | 自定义 `webridge/red-packet` |
   * | `transfer_received` | 自定义 `webridge/transfer` |
   * | `message` + `msg_type=system` | 自定义 `webridge/system-message` |
   *
   * 为什么自定义事件也发：satori 里没有红包 / 转账 / 系统消息的对应结构，
   * 硬塞进标准事件会让监听方拿到一个形状对不上的 Session。让监听方按
   * `payload.body` 自己取字段，比猜一个「差不多」的标准事件诚实。
   *
   * @returns 是否已派发（false 表示这个帧不归这里管）
   */
  private dispatchPlatformEvent(frame: EventFrame): boolean {
    const kind = frameKind(frame)
    const CHANNELS: Partial<Record<string, string>> = {
      'red-packet': 'webridge/red-packet',
      transfer: 'webridge/transfer',
      'moments-result': 'webridge/moments-result',
      'friend-request': 'webridge/friend-request',
      'system-message': 'webridge/system-message',
      'unknown-message': 'webridge/unknown-message',
    }
    const channel = CHANNELS[kind]
    if (!channel) return false

    const payload = buildEventPayload(frame)

    // 好友申请额外派发 satori 标准事件：satori 的 Events 里有 `friend-request`，
    // 生态里可能已有插件在监听（比如自动通过申请那种）。
    if (kind === 'friend-request') {
      const body = payload.body
      const messageId = String(body.message_id || payload.eventId || body.request_id || randomUUID())
      // 先登记再派发，监听方可能在收到事件时立即同意申请。
      this.friendRequests.set(messageId, { ...body, eventId: payload.eventId })
      while (this.friendRequests.size > 200) {
        this.friendRequests.delete(this.friendRequests.keys().next().value!)
      }
      const applicant =
        String(body.from_user ?? '') ||
        String(body.encrypt_username ?? '') ||
        String(body.chat_id ?? '')
      const session = this.session({
        type: 'friend-request',
        channel: { id: applicant || 'unknown', type: CHANNEL_TYPE_DIRECT },
        user: { id: applicant || 'unknown', name: applicant || 'unknown' },
        message: { id: messageId },
        timestamp: payload.capturedAt,
      } as any)
      session.setInternal(WEBRIDGE_INTERNAL_TYPE, {
        ...frame,
        ...body,
        // 协议 15.7 要求同意前校验这两个字段，顺手算好一起给出去
        canAccept: canAcceptFriendRequest(body),
      })
      this.dispatch(session)
    }

    // 自定义事件：载荷是普通对象、不带 session 过滤，所有监听方（含别的插件作用域）都能收到。
    // 这里用 any 是因为事件名是运行时决定的字符串，重载解析会把 payload 误当 thisArg。
    ;(this.ctx as any).emit(channel, payload)
    this.logger.debug('派发事件 %s kind=%s event_id=%s', payload.eventName, kind, payload.eventId ?? '-')
    return true
  }

  /**
   * 兜底：协议事件清单之外的 `event_name`。
   *
   * 协议没有承诺事件清单是闭合列表，因此按 `webridge/unknown-event` 原样透传整帧，
   * 让归档类插件照实入库，而不是只能事后翻日志。
   */
  private dispatchUnknownEvent(frame: EventFrame): void {
    const payload = buildEventPayload(frame)
    ;(this.ctx as any).emit('webridge/unknown-event', payload)
    this.logger.info(
      '未知事件类型（协议清单之外）event_name=%s，已按 webridge/unknown-event 透传',
      payload.eventName || '(空)',
    )
  }

  private isDuplicate(key: string): boolean {
    if (this.seen.has(key)) return true
    this.seen.add(key)
    this.seenOrder.push(key)
    while (this.seenOrder.length > DEDUP_CACHE_SIZE) {
      this.seen.delete(this.seenOrder.shift()!)
    }
    return false
  }

  private isStale(frame: EventFrame, key: string): boolean {
    const limit = this.config.dropStaleEventSeconds ?? 120
    if (limit <= 0) return false
    const age = eventAgeSeconds(frame, Date.now())
    if (age === null || age <= limit) return false
    this.ctx
      .logger('webridge')
      .warn('丢弃迟到事件（%d 秒前的消息，阈值 %d 秒）key=%s', Math.round(age), limit, key)
    return true
  }

  private buildSession(frame: EventFrame, text: string, media: readonly InboundMediaKind[], contents: InboundMediaContent[] = []) {
    const logger = this.logger
    const body: EventBody = frame.body ?? {}

    const senderId = String(body.sender_id ?? '')
    const roomId = String(body.room_id ?? '')
    const chatId = String(body.chat_id ?? '')
    const isGroup = Boolean(body.is_group)

    const channelId = chatId || roomId || senderId
    if (!channelId) {
      logger.warn('消息缺少 chat_id/room_id/sender_id，无法确定会话，已忽略')
      return
    }

    const elements: h[] = []

    // 入站引用**不能**塞进 elements。satori 的引用是 `message.quote` 这个独立字段，
    // 塞进 elements 会变成正文的一部分（开头多一个 `<quote id="…"/>`）：
    // - Koishi 的 `session.stripped.content` 会带上这个前缀，指令匹配不到；
    // - 前缀还会挡住后面的 at 段，`atSelf` 也识别不出来；
    // - `session.quote` 反而一直是空的（satori 只在设置 content 时才拆 quote 段）。
    // 所以这里按契约构造 `message.quote`，正文保持干净。
    const quoteId = body.quote_msg_id ? String(body.quote_msg_id) : ''
    const quoteContent = typeof body.quote_content === 'string' ? body.quote_content : undefined
    const quoteUserName =
      typeof body.quote_display_name === 'string' ? body.quote_display_name.trim() : ''
    const quoteUserId =
      typeof body.quote_from_user === 'string' ? body.quote_from_user.trim() : ''
    const quoteUser =
      quoteUserId || quoteUserName
        ? { id: quoteUserId, name: quoteUserName || quoteUserId }
        : undefined
    const quote = quoteId
      ? { id: quoteId, content: quoteContent, ...(quoteUser ? { user: quoteUser } : {}) }
      : undefined

    // @ 名单。两个信号都来自设备的结构化字段（`is_at` 是「机器人被 @ 了」，
    // 真机确认、官方协议文档里没有；`at_user_list` 是被 @ 的真实 wxid），不要靠正文猜。
    // 但名单里是真实 wxid，而我们向 Koishi 报的 selfId 是配置里的固定值，
    // 直接照搬的话 Koishi 永远认不出「这是在叫我」—— 所以机器人自己那一项换成 selfId，
    // 并且必须放在**最前面**：Koishi 只从开头的连续 at 段里判断 atSelf。
    const mentionedIds = inboundMentions(body.at_user_list)
    const botMentioned =
      body.is_at === true ||
      (!!this.deviceAccountId && mentionedIds.includes(this.deviceAccountId))
    if (botMentioned) elements.push(h.at(this.selfId))

    for (const wxid of mentionedIds) {
      // notify@all 是协议标记不是 wxid，不能当 at 段。
      if (wxid === MENTION_ALL) continue
      // 机器人自己上面已经换成 selfId 了，别重复。
      if (botMentioned && wxid === this.deviceAccountId) continue
      elements.push(h.at(wxid))
    }

    // @所有人。用 `h.at('all')` 而不是文本，好让下游按元素判断 ——
    // 出站编码器认的也正是 `id === 'all'`，进出对称。
    if (body.at_all) elements.push(h.at('all'))

    // 媒体排在正文前面，跟微信里「一张图配一句话」的观感一致。
    for (const kind of media) elements.push(mediaElement(kind, contents.find(item => item.kind === kind)))
    if (text) elements.push(h.text(text))

    return this.session({
      type: 'message',
      channel: { id: channelId, type: isGroup ? CHANNEL_TYPE_TEXT : CHANNEL_TYPE_DIRECT },
      // 协议的事件正文里**没有**发送者昵称字段，只能拿 wxid 占位。
      user: { id: senderId, name: senderId },
      message: {
        id: String(body.message_id ?? ''),
        elements,
        ...(quote ? { quote } : {}),
      } as any,
      // create_time 是秒，统一换算成毫秒。
      timestamp: createTimeToSeconds(body.create_time) * 1000,
      ...(isGroup && roomId ? { guild: { id: roomId, name: '' } } : {}),
    })
  }

  // ------------------------------------------------------------------
  // 出站
  // ------------------------------------------------------------------

  /**
   * 下发一条命令并等它的 `command_result`。
   *
   * @param timeout 覆盖配置里的 `commandTimeout`。语音要转码、视频要下载，
   *   文档说这类命令耗时可达数秒以上，调用方会传一个更宽的值。
   * @throws 当设备未连接、或超时收不到结果时。
   */
  async sendCommand(
    commandName: string,
    args: Record<string, unknown> = {},
    timeout?: number,
    requestId: string = randomUUID(),
  ): Promise<CommandResultFrame> {
    const socket = this.socket
    if (!socket || socket.readyState !== WS_OPEN) {
      throw new WebridgeTransportError('disconnected', requestId, commandName, 'WeBridge 设备未连接')
    }

    if (!/^[^\s\x00-\x1f\x7f]{1,128}$/.test(requestId)) throw new Error('request_id 必须为 1～128 个非空白字符')
    if (this.pending.has(requestId)) throw new Error('同一 request_id 的命令仍在等待结果')
    const frame = buildCommand(requestId, commandName, args)
    const limit = timeout ?? this.config.commandTimeout ?? 15000

    return new Promise<CommandResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new WebridgeTransportError('command-timeout', requestId, commandName, `等待 command_result 超时（${limit}ms）`))
      }, limit)

      this.pending.set(requestId, { commandName, resolve, reject, timer })

      try {
        socket.send(JSON.stringify(frame), (error?: Error) => {
          if (!error) return
          clearTimeout(timer)
          this.pending.delete(requestId)
          reject(new WebridgeTransportError('send-failed', requestId, commandName, error.message))
        })
      } catch (error: any) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new WebridgeTransportError('send-failed', requestId, commandName, String(error?.message ?? error)))
      }
    })
  }

  /** 只撤销本地等待；不代表手机取消了业务操作，也不能据此重发写入。 */
  cancelCommand(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.reject(new WebridgeTransportError('command-cancelled', requestId, entry.commandName, '命令等待已取消'))
  }

  /**
   * 设备是否声明支持某个命令。
   *
   * ⚠️ 名字带 `Command` 是必须的：satori 的 `Bot` 基类已经有
   * `supports(name, session)`（判断 bot 是否实现某个 satori 方法），
   * 同名会与基类签名冲突、编译不过。
   *
   * 协议 13 的两条提醒都体现在这里：
   * 1. 清单随版本变化，**以 hello 收到的为准**（本方法读的就是它）；
   * 2. 0.8.76 及更早版本清单有缺口（命令能执行但不在清单里）——
   *    所以**清单为空时一律返回 true**，不拿「不在清单里」当「不支持」的证据，
   *    否则老设备会被整片挡掉。
   */
  supportsCommand(command: string): boolean {
    if (!this.capabilities.length) return true
    return this.capabilities.includes(command)
  }

  /**
   * 登记一次「发完消息要拿 `message_id`」的等待。
   *
   * 用法固定为三步：**先登记 → 发命令 → `wait()`**。
   *
   * - 登记必须早于发命令：设备回推紧跟在 `command_result` 后面几毫秒，发完再登记可能错过；
   * - 但**计时从 `wait()` 那一刻才开始**：设备忙的时候一条 `send_message` 可能跑上几秒
   *   （真机上见过），从登记时刻计时会在回推到达之前就超时，然后这条消息永远拿不到 ID。
   */
  waitForSelfEcho(channelId: string, content: string, quoteId?: string): SelfEchoHandle {
    const text = normalizeEchoText(content)
    if (!text) {
      // 纯媒体消息没有可匹配的正文，没有回推能认领它。
      return {
        promise: Promise.resolve(undefined),
        wait: () => Promise.resolve(undefined),
        cancel: () => {},
      }
    }

    let settle!: (messageId?: string) => void
    const promise = new Promise<string | undefined>((resolve) => {
      settle = resolve
    })
    const waiter: EchoWaiter = {
      channelId,
      text,
      quoteId: quoteId ? String(quoteId) : undefined,
      resolve: (messageId?: string) => {
        if (waiter.settled) return
        waiter.settled = true
        this.dropEchoWaiter(waiter)
        settle(messageId)
      },
    }
    this.echoWaiters.push(waiter)

    return {
      promise,
      wait: (timeout: number = this.config.echoTimeout ?? DEFAULT_ECHO_TIMEOUT) =>
        this.awaitSelfEcho(waiter, promise, timeout),
      cancel: () => waiter.resolve(undefined),
    }
  }

  /** 撤掉一条登记（匹配成功、超时、放弃时都走这里）。 */
  private dropEchoWaiter(waiter: EchoWaiter): void {
    if (waiter.timer) clearTimeout(waiter.timer)
    this.echoWaiters = this.echoWaiters.filter((item) => item !== waiter)
  }

  /** 在窗口内等回推兑现；超时兑现 `undefined`（窗口 `<= 0` 表示不等）。 */
  private awaitSelfEcho(
    waiter: EchoWaiter,
    promise: Promise<string | undefined>,
    timeout: number,
  ): Promise<string | undefined> {
    if (waiter.settled) return promise
    if (timeout <= 0) {
      waiter.resolve(undefined)
      return Promise.resolve(undefined)
    }
    return new Promise<string | undefined>((resolve) => {
      waiter.timer = setTimeout(() => waiter.resolve(undefined), timeout)
      promise.then((messageId) => {
        if (waiter.timer) clearTimeout(waiter.timer)
        resolve(messageId)
      })
    })
  }

  /** 用一帧自发消息回推兑现等待中的登记（在 `onEvent()` 里调用）。 */
  private settleSelfEcho(frame: EventFrame): void {
    const body = frame.body
    const channelId = body?.room_id || body?.chat_id || ''
    const echoed = normalizeEchoText(inboundText(frame))
    const quoteId = body?.quote_msg_id ? String(body.quote_msg_id) : undefined
    // 引用回推先解析用户正文，再同时核对引用目标。不能只凭正文后缀或同一引用目标认领。
    // 设备若改写了正文（例如额外插入 @ 显示名），宁可不返回 ID，也不能认领另一条消息。
    const candidates = this.echoWaiters.filter(
      (waiter) => waiter.channelId === channelId && waiter.text === echoed && waiter.quoteId === quoteId,
    )
    if (!candidates.length) return
    // 并发的相同正文没有协议关联键可区分，全部放弃认领，不能凭登记顺序分配 ID。
    if (candidates.length > 1) {
      for (const waiter of candidates) waiter.resolve(undefined)
      return
    }
    const [waiter] = candidates
    // 字段缺失也照样兑现（`undefined`）—— 这一帧已经到过了，再等也不会有第二帧。
    waiter.resolve(body?.message_id ? String(body.message_id) : undefined)
  }

  // ------------------------------------------------------------------
  // 查询与群管理
  //
  // 方法名与签名刻意对齐 satori 的 `Methods` 接口（`@satorijs/protocol`）——
  // 这样 Koishi 生态里的中间件、控制台和其他插件不用知道 WeBridge 的存在就能调用，
  // 这也是官方适配器（如 `@satorijs/adapter-telegram`）的做法：方法直接定义在
  // Bot 子类上，基类并不 `implements Methods`。
  //
  // 协议里没有对应概念的扩展（改群名、退群、读群公告等）放在这一段末尾。
  // ------------------------------------------------------------------

  /**
   * 下发一条查询类命令并取出 `result`。
   *
   * 和 `sendCommand` 的分工：那个返回整帧、由调用方自己判 `ok`（发送类命令只关心成败）；
   * 这个把失败直接翻成异常 —— 查询类 API 的调用方要的是**数据**，让它每次判 `ok`
   * 只会到处漏判。失败时 `result` 里常带诊断字段，一并拼进错误消息省得翻日志。
   */
  async query<T extends object>(
    command: string,
    args: Record<string, unknown> = {},
    timeout?: number,
    requestId?: string,
  ): Promise<T> {
    const frame = await this.sendCommand(command, args, timeout, requestId)
    const result = frame.result && typeof frame.result === 'object' && !Array.isArray(frame.result) ? frame.result : {}
    if (!frame.ok || result.ok === false) throw new WebridgeCommandError(command, frame)
    return result as T
  }

  /**
   * satori 标准接口：返回本机器人的登录信息。
   *
   * 官方适配器（telegram / discord / kook / slack / wecom …）都在这里问平台"我是谁"，
   * 并把结果写进 `this.user` —— 也就是 `bot.selfId` 背后的那个对象。我们问的是
   * 设备的 `account_status`。基类有默认实现（直接 `return this.toJSON()`），
   * 覆盖它是为了让 `user.name` / `user.avatar` 有值 —— 官方指引明确说
   * 「调用 `bot.online()` 之前应当尽量保证有 `selfId`、`username`、`avatar`，
   * 后两个会显示在控制台的机器人状态栏里」。
   *
   * ⚠️ **只补 `name` / `avatar`，绝不动 `id`。** `selfId` 是 `user.id` 的访问器
   * （`defineAccessor(Bot.prototype, 'selfId', ['user', 'id'])` 的 setter 就是
   * `this.user.id = value`），把它换成真 wxid 会让已有的 `channel.assignee` 对不上，
   * 所有没有 @ 机器人的群消息都会因此被过滤。
   */
  async getLogin(): Promise<Universal.Login> {
    const account = await this.query<AccountStatusResult>(CMD_ACCOUNT_STATUS)
    const current = this.user ?? { id: this.selfId }
    this.user = {
      ...current,
      name: account?.nick_name || account?.display_name || current.name,
      avatar: account?.avatar_url || current.avatar,
    }
    return this.toJSON()
  }

  /** 全部群聊。`groups_all` 一次给全（协议里没有分页字段），所以返回不带 `next`。 */
  async getGuildList(): Promise<Universal.List<Universal.Guild>> {
    const result = await this.query<GroupsAllResult>(CMD_GROUPS_ALL)
    const items = Array.isArray(result.items) ? result.items : []
    return { data: items.map(contactToGuild) }
  }

  /**
   * 单个群的资料。
   *
   * 走 `room_members` 而不是 `groups_all` —— 后者要把全部群拉下来再筛，
   * 而前者直接就带 `room_name` / `room_remark`。
   */
  async getGuild(guildId: string): Promise<Universal.Guild> {
    const result = await this.directory.snapshot(guildId)
    return roomToGuild(result, guildId)
  }

  /**
   * 群成员列表。
   *
   * 微信一次把成员全给出来，没有分页，所以 `next` 永远为空。
   * 成员里的 `is_owner` / `is_admin` 会被映射成 satori 的 `title`（群主 / 管理员）。
   */
  async getGuildMemberList(guildId: string): Promise<Universal.List<Universal.GuildMember>> {
    const members = await this.directory.members(guildId)
    return { data: members.map(contactToGuildMember) }
  }

  /** 单个群成员。找不到就抛错，不返回一个只有 ID 的空壳。 */
  async getGuildMember(guildId: string, userId: string): Promise<Universal.GuildMember> {
    const found = await this.directory.member(guildId, userId)
    if (!found) throw new Error(`群 ${guildId} 的成员列表里没有 ${userId}`)
    return contactToGuildMember(found)
  }

  /**
   * 好友列表（分页）。
   *
   * satori 的 `next` 是不透明游标，而微信只给了朴素的 `limit` / `offset`，
   * 所以直接拿偏移量当游标 —— 对本方法返回的 `next` 是自洽的。
   */
  async getFriendList(next?: string): Promise<Universal.List<Universal.Friend>> {
    const offset = parseOffset(next)
    const result = await this.query<FriendsResult>(CMD_FRIENDS, {
      offset,
      limit: FRIEND_PAGE_SIZE,
    })
    const items = Array.isArray(result.items) ? result.items : []
    const list: Universal.List<Universal.Friend> = { data: items.map(contactToFriend) }
    if (result.has_more) {
      // 设备可能把自己的上限压在我们的 limit 之下，所以按它回报的步长推进。
      const step =
        Number.isFinite(result.limit) && result.limit > 0 ? result.limit : FRIEND_PAGE_SIZE
      list.next = String(offset + step)
    }
    return list
  }

  /**
   * 单个用户资料。
   *
   * 有群上下文时走群成员；没有时只在 `friends_all` 普通好友中查找。
   * 新版该数组不含陌生人、公众号和系统号，不能把未命中解释为微信账号不存在。
   */
  async getUser(userId: string, guildId?: string): Promise<Universal.User> {
    if (guildId) {
      const member = await this.getGuildMember(guildId, userId)
      // contactToGuildMember 必定填好 user，这里的断言是安全的。
      return member.user!
    }
    const result = await this.query<FriendsAllResult>(CMD_FRIENDS_ALL)
    const items = Array.isArray(result.items) ? result.items : []
    const found = items.find((item) => String(item?.account_id ?? '') === userId)
    if (!found) throw new Error(`联系人里没有 ${userId}`)
    return contactToUser(found)
  }

  /**
   * 处理好友申请（satori 标准方法 `handleFriendRequest`）。
   *
   * satori 的签名只给 `messageId`，而微信侧的 `accept_friend_request` 要的是
   * `encrypt_username` + `ticket`（协议 15.7）。两者之间没有查询接口，
   * 所以只能拿「收到 friend_request 事件时登记下来的原始 body」去匹配。
   *
   * `approve === false` 时**不做任何事**：协议的命令表里只有 `accept_friend_request`，
   * 没有「拒绝好友申请」的命令。静默返回比假装成功诚实 —— 调用方看日志能发现。
   */
  async handleFriendRequest(messageId: string, approve: boolean, _comment?: string): Promise<void> {
    const key = String(messageId ?? '')
    if (!approve) {
      this.logger.warn(
        '拒绝好友申请：协议没有对应命令（只有 accept_friend_request），已忽略 message_id=%s',
        key || '-',
      )
      return
    }
    const match = [...this.friendRequests.entries()].find(
      ([id, item]) => id === key || String(item.eventId ?? '') === key,
    )
    if (!match) {
      throw new Error(
        `没有找到 message_id=${key} 的好友申请。` +
          'handleFriendRequest 只认收到 friend_request 事件时登记过的那条（进程重启后登记表会清空）。',
      )
    }
    const [recordId, record] = match
    if (!canAcceptFriendRequest(record)) {
      throw new Error(
        '这条好友申请缺少 encrypt_username 或 ticket，不能同意（协议 15.7 要求先校验）',
      )
    }
    await this.internal.acceptFriendRequest({
      encryptUsername: String(record.encrypt_username ?? ''),
      ticket: String(record.ticket ?? ''),
      requestId: record.request_id ? String(record.request_id) : undefined,
      scene: typeof record.scene === 'number' ? record.scene : undefined,
    })
    this.friendRequests.delete(recordId)
  }

  /**
   * 踢出群成员（协议命令 `kick_group_member`）。
   *
   * `permanent` 在 satori 里表示「永久踢出 / 拉黑」，微信没有这个语义（踢就是踢），
   * 接受它只是为了与 `Methods` 的签名一致。
   */
  async kickGuildMember(guildId: string, userId: string, _permanent?: boolean): Promise<void> {
    await this.query(CMD_KICK_GROUP_MEMBER, { room_id: guildId, member_id: userId })
  }

  /** 删除好友（协议命令 `delete_friend`）。参数名是 `id`，不是 `room_id` 那一套。 */
  async deleteFriend(userId: string): Promise<void> {
    await this.query(CMD_DELETE_FRIEND, { id: userId })
  }

  /**
   * 撤回消息（协议命令 `revoke_message`）。
   *
   * `channelId` 用不上 —— 微信的撤回只认消息 ID，不认会话。保留这个参数是为了满足
   * satori 的签名：调用方从 session 里拿到的本来就是两者，不必让它特判。
   */
  async deleteMessage(_channelId: string, messageId: string): Promise<void> {
    await this.query(CMD_REVOKE_MESSAGE, { message_id: messageId })
  }

  /**
   * 手机端 WeBridge 设置里要填的完整 WebSocket 地址。
   *
   * 配了 `address` 就用它的 origin；否则用 server 的 `selfUrl` / 监听地址 /
   * 局域网 IPv4 + 实际端口。路径与 secret 由 `endpointPath()` 统一补。
   */
  callbackUrl(): string {
    return buildWebSocketUrl(this.callbackBaseUrl(), this.endpointPath())
  }

  /** `callbackUrl()` 使用的基地址（http(s) / ws(s)，不含 endpoint）。 */
  private callbackBaseUrl(): string {
    // 用户填的完整地址优先：host/port 只用于对外展示，不改变 server 监听。
    if (this.addressOrigin) return this.addressOrigin

    const server = this.ctx.server
    const selfUrl = server.config?.selfUrl
    if (selfUrl) return selfUrl

    const port = server.port || server.config?.port || 5140
    const host = server.host
    if (host && host !== '0.0.0.0' && host !== '::') {
      return `http://${formatHost(host)}:${port}`
    }

    // 监听 0.0.0.0 / :: 时地址本身没法给手机用，挑一个局域网 IPv4。
    const lan = selectLanAddress(networkInterfaces())
    return `http://${formatHost(lan ?? '127.0.0.1')}:${port}`
  }

  private endpointPath(): string {
    const path = this.routePath || '/webridge'
    return this.secret ? `${path}/${this.secret}` : path
  }
}

export namespace WebridgeBot {
  /**
   * 配置类型（**所有字段都是可选的**）。
   *
   * 为什么可选：`ctx.plugin(WebridgeBot, { address: 'ws://...' })` 这种直接注册不会经过
   * schemastery，缺的字段由构造函数里那次 `WebridgeBot.Config(config)` 补默认值。
   * 如果这里写成必填，调用方（尤其是测试）就得把每个字段都抄一遍 —— 而且抄漏一个
   * 编译期就报错，可运行时其实完全能跑（schema 里有默认值）。
   *
   * 对照参考：satori 官方的 telegram 适配器把 `token` 标为必填（它确实没有合理默认值），
   * 但 `slash` 这类有默认值的字段都是可选的 —— 本插件所有字段都有默认值，故全部可选。
   *
   * 代价：类型上没法保证「读的时候一定不是 undefined」。因此**不直接读 `this.config.xxx`**，
   * 只在构造函数里把它换成补全后的对象，其余代码读到的就是补全过的值。
   */
  export interface Config {
    directoryCacheTtl?: number
    directoryTimeout?: number
    directoryCapacity?: number
    archive?: Partial<import('./archive/index.js').Config> & { enabled?: boolean }
    address?: string
    selfId?: string
    commandTimeout?: number
    mediaTimeout?: number
    dropStaleEventSeconds?: number
    acceptMedia?: boolean
    inboundMediaTimeout?: number
    inboundMediaMaxBytes?: number
    inboundAttachmentMaxBytes?: number
    /** 启动时为 true 才注册托管路由。 */
    inboundMediaRelay?: boolean
    inboundMediaRelayTtl?: number
    inboundMediaRelayMaxItems?: number
    inboundMediaRelayMaxBytes?: number
    quoteOnReply?: boolean
    echoTimeout?: number
  }
}
