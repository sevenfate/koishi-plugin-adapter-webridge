/**
 * 出站消息编码：把 Koishi 的消息链翻成 WeBridge 的 `send_message` 命令。
 *
 * 只实现 `visit`（逐元素处理）和 `flush`（真正发出去）两个方法 ——
 * `send()` 由基类实现（`h.normalize` → `before-send` serial → `render` → `flush`），
 * 不要覆盖它。
 */

import { type Context, h, MessageEncoder, type Universal } from '@satorijs/core'

import {
  CMD_SEND_IMAGE,
  CMD_SEND_FILE_FROM_URL,
  CMD_SEND_VIDEO_FROM_URL,
  CMD_SEND_VOICE,
  DEFAULT_COMMAND_TIMEOUT,
  DEFAULT_MEDIA_TIMEOUT,
  MENTION_ALL,
  buildSendMessage,
} from './protocol.js'
import type { WebridgeBot } from './bot.js'
import type { CommandResultFrame } from './types.js'

/**
 * 能发出去的媒体段 → 设备命令。
 *
 * 媒体通过 URL 交给设备下载、转码和上传。协议的 send_image.image_path 支持远程 URL，
 * 图片应保持图片消息类型，不能替换成表情入口。
 * 设备下载器使用通配 Accept，图源需要返回实际图片字节。
 */
export const MEDIA_COMMANDS: Record<string, { command: string; arg: string; label: string }> = {
  img: { command: CMD_SEND_IMAGE, arg: 'image_path', label: '图片' },
  // 官方文档的消息编码示例写的是 `image`，而 satori 元素实际生成的是 `img` —— 两个都认。
  image: { command: CMD_SEND_IMAGE, arg: 'image_path', label: '图片' },
  audio: { command: CMD_SEND_VOICE, arg: 'source', label: '语音' },
  video: { command: CMD_SEND_VIDEO_FROM_URL, arg: 'source', label: '视频' },
  file: { command: CMD_SEND_FILE_FROM_URL, arg: 'file_url', label: '文件' },
}

/** `Channel.Type`（`@satorijs/protocol`）：0 = 文字频道，和 bot.ts 里那个常量同义。 */
const CHANNEL_TYPE_TEXT = 0

/** 媒体 URL 必须是 http(s) —— 别的交给设备去下载只会得到一句没用的报错。 */
export const MEDIA_URL = /^https?:\/\/\S+$/i

/** URL 上限，超过就丢弃而不是截断（截断出来的是坏地址）。 */
export const MAX_MEDIA_URL_LENGTH = 2048

/**
 * 编码器要对 `Context` 泛型 —— 这样才和 `Bot` 基类上
 * `static MessageEncoder` 声明的构造签名对得上（照 `@satorijs/adapter-telegram` 的写法）。
 */
export class WebridgeMessageEncoder<C extends Context = Context> extends MessageEncoder<
  C,
  WebridgeBot<C>
> {
  /** 累积的正文。 */
  private text = ''
  /** 累积的 @ 名单。 */
  private mentions: string[] = []
  /** 消息链里显式写的引用 ID（`quote` 段的 `id`）。 */
  private quoteMessageId?: string
  /** 要单独发的媒体，按出现顺序。 */
  private media: Array<{ command: string; args: Record<string, unknown>; label: string }> = []
  /** 发不出去的元素类型（图片、卡片等），最后统一警告，不静默吞掉。 */
  private skipped = new Set<string>()

  async visit(element: h): Promise<void> {
    const { type, attrs, children } = element as {
      type: string
      attrs: Record<string, any>
      children: h[]
    }

    switch (type) {
      case 'text':
        this.text += attrs.content ?? ''
        return

      case 'at':
        // @所有人：Koishi 侧既能写成 h.at('all')（落在 id 上），
        // 也能写成 h('at', { type: 'all' })，两种都认。
        if (attrs.type === 'all' || attrs.id === 'all') {
          this.mentions.push(MENTION_ALL)
        } else if (attrs.id) {
          this.mentions.push(String(attrs.id))
        }
        return

      case 'quote':
        if (attrs.id) this.quoteMessageId = String(attrs.id)
        return

      case 'br':
        this.text += '\n'
        return

      case 'p':
        await this.render(children)
        this.text += '\n'
        return

      case 'img':
      case 'image':
      case 'audio':
      case 'video':
      case 'file': {
        const spec = MEDIA_COMMANDS[type]
        const src = typeof attrs.src === 'string' ? attrs.src.trim() : ''
        if (src.length > MAX_MEDIA_URL_LENGTH || !MEDIA_URL.test(src)) {
          // 设备会自己去下载这个地址，给个本地路径、`data:` URL 或乱码只会得到一句
          // 没用的报错。入站媒体占位（不带 src 的 `<img/>`）也会走到这里，
          // 转发这类消息时正文照发、媒体跳过，是预期行为。
          // 需要原样转发时打开 inboundMediaRelay：收件阶段会把 data: 换成 http(s)，这里不再改写。
          this.skipped.add(`${type}(需要 http(s) 的 src)`)
          return
        }
        this.media.push({ command: spec.command, args: { [spec.arg]: src }, label: spec.label })
        return
      }

      default:
        // 认不出的元素按官方建议「尽量兼容实现」：**回退渲染它的内部元素**，
        // 而不是整枝丢掉。比如 `<p><b>粗体</b></p>` 里的文字必须留下，
        // 否则用户会发现「我说的话发出去少了一部分」。
        // 同时记进 skipped，收尾时统一警告，不静默吞掉。
        this.skipped.add(type)
        await this.render(children)
    }
  }

  async flush(): Promise<void> {
    const logger = this.bot.ctx.logger('webridge')
    const content = this.text.trim()

    if (this.skipped.size) {
      logger.warn(
        '还不支持这些消息段，已跳过：%s（本条消息只发送其中的正文与可发送的媒体）',
        [...this.skipped].sort().join(', '),
      )
    }

    if (!content && !this.media.length) {
      if (this.skipped.size) logger.warn('本条消息没有任何可发送的内容')
      return
    }

    // 正文在前、媒体在后 —— 跟「一句话配一张图」的读法一致。
    if (content) {
      // 引用目标只算一次：既要传给 buildSendMessage，也要登记进「等回推」——
      // 引用回推要同时核对解析后的正文与 quote_msg_id（见 bot.ts）。
      const replyTarget = this.replyTarget()
      let command: [string, Record<string, unknown>] | undefined
      try {
        command = buildSendMessage(this.channelId, content, this.mentions, replyTarget)
      } catch (error: any) {
        // 本地就能判定发不出去（receiver 空、正文全是空白）。也算一次发送失败。
        this.pushError(error)
        logger.error('构造发送命令失败：%s', error?.message ?? error)
      }
      if (command) {
        // 配置字段是可选的（`Config` 里全是可选字段），但构造函数已经把默认值补进
        // `bot.config` 了；`??` 只是让类型收窄，兜底值与 Schema 的 default 同源。
        const timeout = this.bot.config.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT
        // **先登记再发、发完再等**：设备回推自己那条消息只比 `command_result` 晚几毫秒，
        // 登记晚一步就可能错过；而计时只能从回执之后开始 —— 设备忙时一条命令能跑几秒，
        // 提前计时会在回推到达之前超时。拿到 ID 之后 `bot.sendMessage()` 才会返回可用 id，
        // `bot.deleteMessage()` 也才撤得掉这条消息（见 bot.ts 的 `waitForSelfEcho()`）。
        const echo = this.bot.waitForSelfEcho(this.channelId, String(command[1].content), replyTarget)
        const result = await this.deliver(command[0], command[1], timeout, logger)
        if (result) {
          const messageId = await echo.wait()
          logger.info(
            '已发送 receiver=%s 耗时=%sms 引用=%s @=%s id=%s',
            this.channelId,
            result.duration_ms ?? '-',
            // 打**实际用的**引用目标（显式或自动），排查时不用再猜是哪种
            replyTarget ?? '-',
            this.mentions.length ? this.mentions.join(',') : '-',
            messageId ?? '-',
          )
          this.addResult(content, messageId)
        } else {
          // 命令没发出去，不会有回推 —— 取消登记，别让它挂到超时。
          echo.cancel()
        }
      }
    }

    for (const item of this.media) {
      // 语音要转码、视频要下载，文档明确说这类命令耗时可达数秒以上，
      // 所以用单独的 mediaTimeout，不要被 commandTimeout 卡掉。
      const timeout = this.bot.config.mediaTimeout ?? DEFAULT_MEDIA_TIMEOUT
      // ⚠️ `receiver` 必须在这里补上：协议里每一条媒体命令（`send_emoji`、
      // `send_voice`、`send_video_from_url`、`send_file_from_url`）都把
      // `receiver` 列为**必需参数**，只有 `send_message` 是在 `buildSendMessage()`
      // 里带上去的。漏了它设备会回一句看不懂的
      // `source and receiver are required`（正文里有 receiver、媒体没有，
      // 所以只有媒体发不出去）—— 真机上撞过。
      const result = await this.deliver(item.command, { receiver: this.channelId, ...item.args }, timeout, logger)
      if (result) {
        logger.info(
          '已发送%s receiver=%s 耗时=%sms',
          item.label,
          this.channelId,
          result.duration_ms ?? '-',
        )
        // 媒体是独立的一条消息，所以单独记一条结果（正文为空）。
        this.addResult('')
      }
    }
  }

  /**
   * 记一条发送结果，并广播 `send` 事件。
   *
   * 两件事都得做，官方适配器（telegram / kook / discord 的 `addResult()`）全都这么做：
   * `results` 是 `bot.createMessage()` 的返回值，而 `send` 是 satori 的标准事件 ——
   * 日志、统计、控制台那类插件靠它感知"刚刚发出去一条消息"，漏掉就是静默丢失。
   *
   * `id` **只在真的拿到时才填**：微信的 `send_message` 回执里没有 message_id
   * （只有 `receiver`，可选带 `quote_message_id` / `mention_user_list`），
   * 唯一来源是设备随后回推的那帧「自己的消息」—— 由 `bot.waitForSelfEcho()` 捕获。
   * 等不到就留空，**绝不编 UUID**：调用方会以为能拿它去 `revoke_message`，
   * 而微信只认真实 ID，到时会静默失败。空 id 的消息会被 `sendMessage()` 过滤掉，
   * 这是诚实的「发出去了，但没法引用它」。
   */
  private addResult(content: string, messageId?: string): void {
    const message: Universal.Message = {
      content,
      channel: { id: this.channelId, type: CHANNEL_TYPE_TEXT },
    }
    if (messageId) message.id = messageId
    this.results.push(message)
    const session = this.bot.session()
    session.type = 'send'
    session.channelId = this.channelId
    // 官方写法（`guide/adapter/message`）：先把消息挂进 session 的 event 再广播，
    // 监听 `send` 的插件才能从 `session.event.message` 拿到刚发出去的那条。
    session.event.message = message
    session.app.emit(session, 'send', session)
  }

  /** 把任意抛出物归一成 Error 收进 `errors`（基类最后会抛 `AggregateError`）。 */
  private pushError(error: unknown): void {
    this.errors.push(error instanceof Error ? error : new Error(String(error)))
  }

  /**
   * 下发一条命令并按结果记账。
   *
   * 失败**不在这里抛**，而是收进 `this.errors` —— 基类 `MessageEncoder.send()` 会做两件事：
   * 有 `errors` 时抛 `AggregateError`，没有则返回 `results`。
   *
   * 这样比"失败只记日志、静默返回"更规矩：
   * - `session.send()` 这条路行为不变 —— koishi 的 `Session.send` 自己 `.catch()` 掉异常
   *   并记 warn，仍然返回 `[]`，所以不会炸掉用户的中间件链；
   * - 直接调 `bot.createMessage()` 的调用方则能拿到 `AggregateError`，区分得出
   *   「发出去了」和「设备离线 / 超时」。
   */
  private async deliver(
    command: string,
    args: Record<string, unknown>,
    timeout: number,
    logger: ReturnType<Context['logger']>,
  ): Promise<CommandResultFrame | undefined> {
    try {
      const result = await this.bot.sendCommand(command, args, timeout)
      // 只认 ok 字段判成败，不要看 error 是否为空。
      if (!result.ok) {
        // 失败时 result 里可能带诊断信息，一起打出来能省很多排查时间。
        logger.error(
          '发送失败 receiver=%s command=%s error=%o result=%o',
          this.channelId,
          command,
          result.error,
          result.result,
        )
        this.pushError(new Error(`${command} 失败：${result.error || '设备未给出原因'}`))
        return undefined
      }
      return result
    } catch (error: any) {
      logger.error(
        '发送异常 receiver=%s command=%s: %s',
        this.channelId,
        command,
        error?.message ?? error,
      )
      this.pushError(error)
      return undefined
    }
  }

  /**
   * 这条消息要引用哪一条 —— 显式优先、隐式兜底。
   *
   * - 消息链里自己写了 `quote` 段（`this.quoteMessageId`）：**以它为准**。调用方显式指定
   *   了引用对象，适配器不该覆盖它，哪怕配置开了 `quoteOnReply`。
   * - 否则在 `quoteOnReply` 打开时引用「触发这次回复的那条消息」，也就是微信里点「回复」的效果。
   *   用 satori 的通用字段 `session.messageId`，不另外造字段：入站时它来自事件的
   *   `message_id`，而设备要的 `quote_message_id` 正是同一个 ID（实测确认）。
   * - 取的是 `options.session`（触发发送的那条入站会话），**不是 `this.session`**：
   *   后者是基类在 `send()` 里现造的一条 `type='send'` 会话，只拷了 channel / guild，
   *   没有 `messageId`（这个坑踩过一次：读 `this.session.messageId` 永远是 undefined，
   *   表现为「开着 quoteOnReply 却不出引用」）。
   * - 直接调 `bot.sendMessage()` 时没有 `options.session`，也就没有「被回复的那条消息」
   *   可引用，返回 undefined。
   *
   * ⚠️ 引用有「最近缓存」限制：手机端只认它自己最近消息缓存里的 ID，引用太早的消息会失败。
   */
  private replyTarget(): string | undefined {
    if (this.quoteMessageId) return this.quoteMessageId
    if (!this.bot.config.quoteOnReply) return undefined
    const messageId = this.options.session?.messageId
    return messageId ? String(messageId) : undefined
  }
}
