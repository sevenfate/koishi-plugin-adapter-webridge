/**
 * 全链路测试：真实 Koishi 实例 ↔ 假 WeBridge 插件客户端。
 *
 * 覆盖的是最容易写错、又最难在真机上定位的几条：握手时限、路径校验、
 * 事件转换、出站命令映射、@ 名单、引用、去重、迟到丢弃。
 *
 * 直接跑：`npx tsx tests/e2e.spec.ts`
 */

import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

// 用 `@koishijs/core` 而不是 `koishi`：后者在 ESM 下会走坏掉的 loader 入口。
// 我们不需要 loader（那是用来读 `.koishi.yml` 的），只要 App 和 h。
import { App, h } from '@koishijs/core'
import server from '@koishijs/plugin-server'

import * as webridge from '../src/index'
import type { WebridgeInternal } from '../src/internal'
import { contact } from './fixtures'

const HOST = '127.0.0.1'
const PORT = 16200
const SECRET = 'sekrit'
const PATH = '/webridge'
const URL_OK = `ws://${HOST}:${PORT}${PATH}/${SECRET}`

const DEVICE_ID = 'webridge_device_test-koishi'
const SESSION_ID = 'sess_1775000000123_a1b2c3d4e5f6'
const BOT_WXID = 'wxid_self'
const GROUP_ID = '1234567890@chatroom'

const nowMs = () => Date.now()

function helloFrame() {
  return {
    type: 'hello',
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    account_id: BOT_WXID,
    runtime_version: '0.8.79',
    build_marker: 'webridge_build_20261014',
    ts_ms: nowMs(),
    capabilities: ['send_message'],
    state: {
      is_logged_in: true,
      account_id: BOT_WXID,
      auth_authorized: true,
      plugin_enabled: true,
    },
  }
}

function messageEvent(over: Record<string, any> = {}) {
  const { body: bodyOver, ...frameOver } = over
  const eventId = frameOver.event_id ?? 'msg:1'
  return {
    type: 'event',
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    account_id: BOT_WXID,
    runtime_version: '0.8.79',
    build_marker: 'webridge_build_20261014',
    ts_ms: nowMs(),
    event_name: 'message',
    event_id: eventId,
    captured_at_ms: nowMs(),
    enqueued_at_ms: nowMs(),
    body: {
      message_id: String(eventId).split(':').pop(),
      msg_type: 'text',
      raw_message_type: 1,
      chat_id: GROUP_ID,
      room_id: GROUP_ID,
      sender_id: 'wxid_member',
      is_group: true,
      is_at: false,
      at_user_list: [],
      at_all: false,
      create_time: Math.floor(nowMs() / 1000),
      content: '你好',
      ...bodyOver,
    },
    ...frameOver,
  }
}

/**
 * 拼一个「body 没有会话字段」的平台事件帧。
 *
 * 转账退还结果（协议 v8.0.80 23.5）不是聊天消息，body 里没有 chat_id / room_id /
 * sender_id，所以不复用 messageEvent 的消息字段，单独拼一个最小帧。
 */
function platformEvent(eventName: string, body: Record<string, any>, over: Record<string, any> = {}) {
  return {
    type: 'event',
    device_id: DEVICE_ID,
    session_id: SESSION_ID,
    account_id: BOT_WXID,
    runtime_version: '8.0.80',
    build_marker: 'webridge_build_20261109',
    ts_ms: nowMs(),
    event_name: eventName,
    event_id: eventName + ':1',
    captured_at_ms: nowMs(),
    enqueued_at_ms: nowMs(),
    body,
    ...over,
  }
}

/** 模拟手机上的 WeBridge 插件。 */
class FakePlugin {
  private queue: any[] = []
  private waiters: Array<(v: any) => void> = []

  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      let frame: any
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      // 普通消息的通讯录补全由设备自动应答，不混入出站命令断言队列。
      if (frame.type === 'command' && frame.command_name === 'room_members' && frame.args.room_id === GROUP_ID) {
        this.reply(frame, true, '', { room_id: GROUP_ID, room_name: '测试群', members: [] })
        return
      }
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.queue.push(frame)
    })
  }

  send(frame: any) {
    this.ws.send(JSON.stringify(frame))
  }

  recv(timeout = 5000): Promise<any> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待帧超时')), timeout)
      this.waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  async handshake() {
    this.send(helloFrame())
    const ack = await this.recv()
    assert.equal(ack.type, 'hello_ack', `期望 hello_ack，实际 ${JSON.stringify(ack)}`)
    return ack
  }

  async expectCommand(timeout = 5000) {
    const cmd = await this.recv(timeout)
    assert.equal(cmd.type, 'command', `期望 command，实际 ${JSON.stringify(cmd)}`)
    assert.ok(cmd.request_id, 'request_id 为空会让插件静默丢弃整帧')
    assert.ok(cmd.command_name, 'command_name 为空会让插件静默丢弃整帧')
    return cmd
  }

  /**
   * 已经到达、但还没有被消费的命令条数。
   *
   * 测试块末尾断言它为 0：**漏消费一条命令会让后面所有 `expectCommand` 全部串位**，
   * 表现出来是某个不相关的断言莫名其妙地失败，很难定位（这个坑踩过一次：
   * 图片段改成走 `send_emoji` 之后，老测试里那条命令没人收，于是后面全错位了）。
   */
  get pendingCount() {
    return this.queue.length
  }

  reply(cmd: any, ok = true, error = '', result?: Record<string, unknown>) {
    this.send({
      type: 'command_result',
      device_id: DEVICE_ID,
      session_id: SESSION_ID,
      account_id: BOT_WXID,
      runtime_version: '0.8.79',
      build_marker: 'webridge_build_20261014',
      ts_ms: nowMs(),
      request_id: cmd.request_id,
      command_name: cmd.command_name,
      ok,
      duration_ms: 10,
      // 查询类命令要回造好的数据；发送类命令回什么无所谓，保持原来的形状即可。
      result: result ?? (ok ? { receiver: cmd.args?.receiver } : {}),
      error: ok ? '' : error,
    })
  }
}

const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------

async function main() {
  const received: any[] = []

  const app = new App()
  const serverFork = app.plugin(server, { host: HOST, port: PORT })
  const adapterFork = app.plugin(webridge, {
    address: `ws://${HOST}:${PORT}${PATH}/${SECRET}`,
    selfId: 'test',
    commandTimeout: 5000,
    dropStaleEventSeconds: 120,
    // 等自发回推的窗口调小：假设备默认不回推，默认的 1 秒会让每个用例都白等。
    echoTimeout: 150,
  })
  // 收集进入事件流的会话
  app.on('message', (session: any) => {
    received.push(session)
  })

  await app.start()
  const waitForSession = async (timeout = 3000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (received.length) return received.shift()
      await sleep(20)
    }
    return undefined
  }

  try {
    // --- 0. 路径校验：错的路径应当被拒 ---
    {
      const ws = await connect(`ws://${HOST}:${PORT}/nope`).catch(() => null)
      if (ws) {
        const closed = await new Promise<boolean>((resolve) => {
          ws.once('close', () => resolve(true))
          setTimeout(() => resolve(false), 1500)
        })
        assert.ok(closed, '错误路径的连接应当被关闭')
        ws.close()
      }
      console.log('PASS 错误路径被拒绝')
    }

    const ws = await connect(URL_OK)
    const plugin = new FakePlugin(ws)
    const bot: any = (app as any).bots[0]
    assert.ok(bot, 'Koishi 里应当能拿到 bot 实例')
    assert.equal(bot.status, 4, '设备握手前应处于等待连接状态')

    // --- 1. 握手必须在 10 秒内完成 ---
    {
      const t0 = Date.now()
      await plugin.handshake()
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 2000, `hello_ack 用了 ${elapsed}ms，太慢`)
      console.log(`PASS 握手 ${elapsed}ms`)
      assert.equal(bot.status, 1, '有效握手后才应在线')

      // 握手之后适配器会异步问一句「我是谁」（`getLogin()` → `account_status`），
      // 用来填 `bot.user`。必须在这里消费掉，否则它会混进后面每个测试的命令队列。
      const login = await plugin.expectCommand()
      assert.equal(login.command_name, 'account_status')
      plugin.reply(login, true, '', {
        account_id: 'wxid_self',
        nick_name: '测试机器人',
        display_name: '测试机器人',
        avatar_url: 'https://example.com/avatar.png',
      })
      await sleep(100)
      // 只补 name / avatar —— `selfId` 是 `user.id` 的访问器，改它会让非 @ 的群消息被吞
      assert.equal(bot.user?.id, 'test', 'selfId 不能被账号资料改掉')
      assert.equal(bot.user?.name, '测试机器人', 'getLogin 应当把昵称填进 bot.user')
      assert.equal(bot.user?.avatar, 'https://example.com/avatar.png')
      console.log('PASS 握手后 getLogin 填充 bot.user')

      // 回调地址由插件自己生成：默认用 server 的 host/port + 端点路径。
      const callbackUrl = bot.callbackUrl()
      assert.match(
        callbackUrl,
        new RegExp(`^ws://.+:${PORT}/webridge/${SECRET}$`),
        '应当拼出完整的 ws 地址（含端口、路径、secret）',
      )
      assert.equal(bot.internal.getCallbackUrl(), callbackUrl, 'internal 暴露的地址要一致')
      assert.equal(bot.config.address, callbackUrl, '完整地址应当写回配置')
      console.log('PASS 自动生成回调地址', callbackUrl)
    }

    // 未握手的旁路连接不能注入消息，也不能冒领当前设备的命令回执。
    {
      const auxiliary = await connect(URL_OK)
      const stranger = new FakePlugin(auxiliary)
      let resolved = false
      const query = bot.query('device_status').then((value: any) => { resolved = true; return value })
      const cmd = await plugin.expectCommand()
      stranger.send(messageEvent({ event_id: 'msg:before-hello' }))
      stranger.reply(cmd, true, '', { forged: true })
      await sleep(100)
      assert.equal(received.length, 0)
      assert.equal(resolved, false, '未握手连接的结果不能兑现当前请求')
      plugin.reply(cmd, true, '', { verified: true })
      assert.deepEqual(await query, { verified: true })
      auxiliary.close()
      console.log('PASS 未握手连接不能注入消息或命令结果')
    }

    // --- 2. 未知帧不能把连接搞坏 ---
    {
      plugin.send({ type: 'totally_unknown', x: 1 })
      await sleep(100)
      plugin.send(messageEvent({ event_id: 'msg:alive' }))
      const session = await waitForSession()
      assert.ok(session, '未知帧之后连接应当仍然可用')
      console.log('PASS 未知帧被安静忽略')
    }

    // --- 3. 群文本消息 → Koishi 会话 ---
    let session: any
    {
      plugin.send(messageEvent({ event_id: 'msg:1', body: { content: '在吗' } }))
      session = await waitForSession()
      assert.ok(session, '群消息没有进入事件流')
      assert.equal(session.content, '在吗')
      assert.equal(session.channelId, GROUP_ID)
      assert.equal(session.userId, 'wxid_member')
      assert.equal(session.guildId, GROUP_ID)
      console.log('PASS 群文本消息 → Koishi 会话')
    }

    // 空 CDATA 不能制造假 @，真实 @ 的命令过滤规则仍应保留。
    {
      const commands = ['抽签', '签到', '解签'].map(name => app.command(name).action(() => `${name}已执行`))
      const acknowledgeReply = async (command: any) => {
        const sent = new Promise<void>(resolve => {
          const off = app.on('send', () => { off(); resolve() })
        })
        plugin.reply(command)
        await sent
      }
      try {
        let sequence = 0
        for (const name of ['抽签', '签到', '解签']) {
          for (const mentions of [[], ['<![CDATA[]]>'], ['<![CDATA[ \n ]]>']]) {
            plugin.send(messageEvent({ event_id: `msg:empty-at:${++sequence}`, body: { content: name, at_user_list: mentions } }))
            const receivedSession = await waitForSession()
            assert.ok(receivedSession)
            assert.equal(receivedSession.stripped.hasAt, false, '空名单不应产生 at 段')
            const reply = await plugin.expectCommand()
            assert.equal(reply.args.content, `${name}已执行`)
            await acknowledgeReply(reply)
          }
        }
        plugin.send(messageEvent({ event_id: 'msg:real-other-at', body: { content: '抽签', at_user_list: ['wxid_other'] } }))
        const other = await waitForSession()
        assert.equal(other.stripped.hasAt, true)
        assert.equal(other.stripped.atSelf, false)
        await sleep(200)
        assert.equal(plugin.pendingCount, 0, '@其他人时不应执行命令')

        plugin.send(messageEvent({ event_id: 'msg:wrapped-self-at', body: { content: '抽签', at_user_list: ['<![CDATA[wxid_self]]>'] } }))
        const self = await waitForSession()
        assert.equal(self.stripped.atSelf, true, 'CDATA 中真实的机器人 ID 仍应被识别')
        const reply = await plugin.expectCommand()
        assert.equal(reply.args.content, '抽签已执行')
        await acknowledgeReply(reply)
        console.log('PASS 空 CDATA 下抽签、签到、解签均执行，真实 @ 规则保持有效')
      } finally {
        for (const command of commands) command.dispose()
      }
    }

    // --- 3b. session.webridge：原始帧字段 + bot.internal 的方法 ---
    {
      // `session.setInternal('webridge', …)` 挂上去的原始字段 —— 这些 satori 里没有对应概念。
      assert.equal(session.webridge.msg_type, 'text')
      assert.equal(session.webridge.room_id, GROUP_ID)
      assert.equal(session.webridge.sender_id, 'wxid_member')
      // 帧级字段也该在（连同 body 一起平铺）
      assert.equal(session.webridge.event_name, 'message')
      assert.equal(session.webridge.device_id, DEVICE_ID)

      // 类型增强真的生效了吗 —— 这行是**编译期**检查，`tsc --noEmit` 不通过就说明声明写错了。
      // 取 `bot.internal` 验证原型关系：`setInternal` 里是
      // `Object.create(this.bot.internal)` 再挂上帧字段，所以两边不是同一个对象。
      const viaSession: WebridgeInternal = session.webridge
      assert.equal(
        Object.getPrototypeOf(viaSession),
        session.bot.internal,
        'session.webridge 的原型应当是 bot.internal',
      )

      // 直接调用 internal 的方法：底下就是一条普通命令，走的是同一个通道。
      const status = session.webridge.getBridgeStatus()
      const statusCmd = await plugin.expectCommand()
      assert.equal(statusCmd.command_name, 'bridge_status')
      plugin.reply(statusCmd, true, '', { ok: true, plugin_version: '0.8.79' })
      assert.equal((await status).plugin_version, '0.8.79')
      console.log('PASS session.webridge 暴露原始字段 + internal 方法')
    }

    // --- 4. 回复 → send_message 命令 ---
    {
      const sent: any[] = []
      app.on('send', (s: any) => sent.push(s))

      const sending = session.send('在的')
      const cmd = await plugin.expectCommand()
      assert.equal(cmd.command_name, 'send_message')
      assert.equal(cmd.args.receiver, GROUP_ID)
      assert.equal(cmd.args.content, '在的')
      // `quoteOnReply` 默认开着：消息链里没写引用时，隐式引用「触发回复的那条消息」，
      // 也就是微信里点「回复」的效果。ID 直接取 satori 的 `session.messageId`
      // （入站时来自事件的 `message_id`，正是设备要的那个值）。
      assert.equal(cmd.args.quote_message_id, session.messageId)
      assert.equal(cmd.args.quote_message_id, '1', 'messageEvent 里 message_id 取的是 event_id 的数字部分')
      plugin.reply(cmd)

      // 设备不回 message_id，适配器就不填 id，`sendMessage()` 会把没有 id 的消息过滤掉
      // —— 空数组是刻意的（见 message.ts 的 addResult）
      assert.deepEqual(await sending, [])

      // 但 `send` 事件必须照发：日志 / 统计 / 控制台那类插件靠它感知「刚发出去一条」
      assert.equal(sent.length, 1, '发送成功后应当 emit send 事件')
      assert.equal(sent[0].channelId, GROUP_ID)
      console.log('PASS 回复 → send_message 命令（并 emit send 事件）')
    }

    // --- 5. @所有人 + @某人 ---
    {
      const sending = session.send([h.at('all'), h.at('wxid_a'), h.at('wxid_a'), h.text('开会了')])
      const cmd = await plugin.expectCommand()
      assert.deepEqual(cmd.args.mention_user_list, ['notify@all', 'wxid_a'])
      assert.ok(
        String(cmd.args.content).includes('@所有人'),
        `@所有人 的正文必须含这四个字，实际 ${JSON.stringify(cmd.args.content)}`,
      )
      plugin.reply(cmd)
      await sending
      console.log('PASS @所有人 补字样 + @ 名单去重')
    }

    // --- 6. 引用 ---
    {
      const sending = session.send([h.quote('7307587870543245070'), h.text('回复')])
      const cmd = await plugin.expectCommand()
      assert.equal(cmd.args.quote_message_id, '7307587870543245070')
      plugin.reply(cmd)
      await sending
      console.log('PASS 引用 → quote_message_id')
    }

    // --- 6b. quoteOnReply 的三种情形 ---
    {
      // ① 关掉：不引用（同一个会话，只换配置开关）
      bot.config.quoteOnReply = false
      const noQuote = session.send('不引用')
      const plainCmd = await plugin.expectCommand()
      assert.equal(plainCmd.args.quote_message_id, undefined, '关掉 quoteOnReply 后不该带引用')
      plugin.reply(plainCmd)
      await noQuote
      bot.config.quoteOnReply = true

      // ② 显式 quote 段优先，且不会覆盖会话语义 —— `bot.sendMessage` 没有会话上下文
      //    （`options.session` 为空），所以只认显式那一段。
      const explicit = bot.sendMessage(GROUP_ID, [h.quote('111'), h.text('显式引用')])
      const explicitCmd = await plugin.expectCommand()
      assert.equal(explicitCmd.args.quote_message_id, '111')
      plugin.reply(explicitCmd)
      await explicit

      // ③ `bot.sendMessage`（无会话上下文）：没有「被回复的那条消息」，不该凭空加引用
      const plain = bot.sendMessage(GROUP_ID, '主动推送')
      const pushCmd = await plugin.expectCommand()
      assert.equal(pushCmd.args.quote_message_id, undefined, '主动推送没有原消息可引用')
      plugin.reply(pushCmd)
      await plain
      console.log('PASS quoteOnReply：关闭 / 显式优先 / 无会话上下文')
    }

    // --- 6c. 入站引用：引用走 message.quote，正文不能被 quote 段污染 ---
    {
      plugin.send(
        messageEvent({
          event_id: 'msg:quote-in',
          body: {
            msg_type: 'app',
            msg_subtype: 'quote',
            app_msg_type: 57,
            content: 'wxid_other:\n<msg><appmsg><title>help</title></appmsg></msg>',
            quote_msg_id: 'orig:1',
            quote_content: '被引用的原话',
            quote_from_user: 'wxid_other',
            quote_display_name: '别人',
          },
        }),
      )
      const quoteSession = await waitForSession()
      assert.ok(quoteSession, '引用消息没有进入事件流')
      // 正文必须只剩用户打的字；带 <quote .../> 前缀会让 Koishi 的指令匹配失败。
      assert.equal(quoteSession.content, 'help', '引用消息的正文被 quote 段污染了')
      assert.equal(quoteSession.stripped.content, 'help', 'stripped 正文被 quote 段污染了')
      // 引用信息必须在独立字段上，而不是 elements 里的一个段。
      assert.equal(quoteSession.quote?.id, 'orig:1')
      assert.equal(quoteSession.quote?.content, '被引用的原话')
      assert.equal(quoteSession.quote?.user?.name, '别人')
      assert.deepEqual(
        quoteSession.elements.map((el: any) => el.type),
        ['text'],
        'elements 里不该再出现 quote 段',
      )
      console.log('PASS 入站引用 → message.quote（正文不被污染）')
    }

    // --- 7. 图片段走 send_image，文本照发 ---
    {
      const sending = session.send([h.text('看图'), h.image('https://example.com/a.png')])
      const cmd = await plugin.expectCommand()
      assert.equal(cmd.args.content, '看图')
      plugin.reply(cmd)

      const image = await plugin.expectCommand()
      assert.equal(image.command_name, 'send_image')
      assert.equal(image.args.image_path, 'https://example.com/a.png')
      assert.equal(image.args.receiver, GROUP_ID)
      plugin.reply(image)

      await sending
      assert.equal(plugin.pendingCount, 0, '队列里不该有没被消费的命令')
      console.log('PASS 图片段走 send_image、文本照发')
    }

    // --- 7b. 没有对应命令的段被跳过，文本照发 ---
    {
      const sending = session.send([
        h.text('看卡片'),
        // 链接卡片这类在 satori 里没有对应元素，也没有可用的出站命令
        h('card', { title: '标题', url: 'https://example.com' }),
      ])
      const cmd = await plugin.expectCommand()
      assert.equal(cmd.args.content, '看卡片')
      plugin.reply(cmd)
      await sending
      // 跳过是不下发命令的 —— 队列空即证明没有偷偷发一条坏命令出去
      assert.equal(plugin.pendingCount, 0, '被跳过的段不该产生命令')
      console.log('PASS 无对应命令的段被跳过、文本照发')
    }

    // --- 8. 重复 event_id 去重 ---
    {
      plugin.send(messageEvent({ event_id: 'msg:1', body: { content: '在吗' } }))
      await sleep(300)
      assert.equal(received.length, 0, '重复事件应当被去重')
      console.log('PASS 重复 event_id 被去重')
    }

    // --- 9. 迟到事件被丢弃 ---
    {
      plugin.send(
        messageEvent({
          event_id: 'msg:stale',
          captured_at_ms: nowMs() - 10 * 60 * 1000,
          body: { content: '十分钟前的消息' },
        }),
      )
      await sleep(300)
      assert.equal(received.length, 0, '10 分钟前的事件应当被丢弃')
      console.log('PASS 迟到事件被丢弃')
    }

    // --- 10. 群成员事件独立派发，不进入消息会话 ---
    {
      const members: any[] = []
      const off = app.on('guild-member-added', (session) => { members.push(session) })
      plugin.send({
        type: 'event',
        device_id: DEVICE_ID,
        session_id: SESSION_ID,
        account_id: BOT_WXID,
        runtime_version: '0.8.79',
        build_marker: 'webridge_build_20261014',
        ts_ms: nowMs(),
        event_name: 'group_member_join',
        event_id: 'group_member:join:1',
        captured_at_ms: nowMs(),
        body: { room_id: GROUP_ID, member_id: 'wxid_new' },
      })
      await sleep(300)
      assert.equal(received.length, 0, '群成员事件不应进事件流')
      assert.equal(members.length, 1)
      assert.equal(members[0].guildId, GROUP_ID)
      assert.equal(members[0].userId, 'wxid_new')
      off()
      console.log('PASS 群成员事件派发标准事件，不进入消息会话')
    }

    {
      const requests: any[] = []
      const off = app.on('friend-request', (session) => { requests.push(session) })
      plugin.send(messageEvent({ event_name: 'friend_request', event_id: 'friend:1',
        body: { message_id: 'friend-message:1', encrypt_username: 'encrypted', ticket: 'ticket',
          request_id: 'business:1', scene: 3 } }))
      await sleep(100)
      assert.equal(requests.length, 1)
      assert.equal(requests[0].messageId, 'friend-message:1')
      const accepting = bot.handleFriendRequest(requests[0].messageId, true)
      const cmd = await plugin.expectCommand()
      assert.equal(cmd.command_name, 'accept_friend_request')
      assert.deepEqual(cmd.args, { encrypt_username: 'encrypted', ticket: 'ticket', request_id: 'business:1', scene: 3 })
      plugin.reply(cmd)
      await accepting
      await assert.rejects(bot.handleFriendRequest(requests[0].messageId, true), /没有找到/)
      off()
      console.log('PASS 好友申请事件到同意申请的完整链路')
    }

    // --- 11. 私聊消息 ---
    {
      plugin.send(
        messageEvent({
          event_id: 'msg:2',
          body: { room_id: '', chat_id: 'wxid_friend', sender_id: 'wxid_friend', is_group: false },
        }),
      )
      const dm = await waitForSession()
      assert.ok(dm, '私聊消息没有进入事件流')
      assert.equal(dm.channelId, 'wxid_friend')
      assert.equal(dm.guildId, undefined)
      console.log('PASS 私聊消息')
    }

    // --- 12. 命令失败不该抛异常打断流水线 ---
    {
      plugin.send(messageEvent({ event_id: 'msg:3', body: { content: '试试' } }))
      const s = await waitForSession()
      assert.ok(s)
      const sending = s.send('试试回复')
      const cmd = await plugin.expectCommand()
      plugin.reply(cmd, false, 'send_message is disabled')
      const ids = await sending // 不应抛
      assert.ok(Array.isArray(ids))
      console.log('PASS 命令失败不抛异常')
    }

    // --- 13. 图片取件失败时保留消息，明确标识内容不可用，不制造空 img ---
    {
      plugin.send(
        messageEvent({
          event_id: 'msg:img1',
          body: { msg_type: 'image', content: 'wxid_member: <msg><img aeskey="xx"/></msg>' },
        }),
      )
      const upload = await plugin.expectCommand()
      assert.equal(upload.command_name, 'upload_message_media')
      assert.equal(upload.args.message_id, 'img1')
      plugin.reply(upload, false, '测试设备未提供图片')
      const s = await waitForSession()
      assert.ok(s, '图片消息没有进入事件流')
      assert.ok(s.content.includes('图片：内容暂不可用'))
      assert.ok(!s.elements.some((e: any) => e.type === 'img'))
      assert.equal(s.webridge.media[0].status, 'unavailable')
      console.log('PASS 图片取件失败 → 明确降级并保留消息')
    }

    // --- 14. @所有人：出站认 id='all'，入站也用同一个约定 ---
    {
      plugin.send(
        messageEvent({
          event_id: 'msg:atall',
          body: { at_all: true, at_user_list: ['notify@all'], content: '大家都看看' },
        }),
      )
      const s = await waitForSession()
      assert.ok(s)
      const atAll = s.elements.find((e: any) => e.type === 'at' && e.attrs.id === 'all')
      assert.ok(atAll, `应当有 id=all 的 at 段，实际 ${JSON.stringify(s.elements)}`)
      // notify@all 是协议标记，不能当成一个 wxid
      assert.ok(
        !s.elements.some((e: any) => e.type === 'at' && e.attrs.id === 'notify@all'),
        'notify@all 不该变成 at 段',
      )
      console.log('PASS @所有人 → at(id=all) 段')
    }

    // --- 15. 机器人自己发出的消息要被丢掉（设备会把自发消息回推） ---
    {
      const before = received.length
      plugin.send(
        messageEvent({
          event_id: 'msg:self',
          body: { sender_id: BOT_WXID, content: '当前可用的指令有：help' },
        }),
      )
      await sleep(300)
      assert.equal(received.length, before, '机器人自己的消息不该进事件流')
      console.log('PASS 自发消息被丢弃')
    }

    // --- 16. 出站媒体走各自的 URL 入口 ---
    {
      plugin.send(messageEvent({ event_id: 'msg:media1', body: { content: '看这个' } }))
      const s = await waitForSession()
      assert.ok(s)
      const sending = s.send([
        h('text', { content: '看这个' }),
        h('audio', { src: 'https://example.com/a.mp3' }),
        h('video', { src: 'https://example.com/v.mp4' }),
        h('file', { src: 'https://example.com/r.pdf' }),
        // image_path 接受远程 URL，图片应保持图片消息类型。
        h('img', { src: 'https://example.com/p.png' }),
      ])

      // 正文先发，然后是按出现顺序的四种媒体
      const text = await plugin.expectCommand()
      assert.equal(text.command_name, 'send_message')
      plugin.reply(text)

      const expected: Array<[string, string, string]> = [
        ['send_voice', 'source', 'https://example.com/a.mp3'],
        ['send_video_from_url', 'source', 'https://example.com/v.mp4'],
        ['send_file_from_url', 'file_url', 'https://example.com/r.pdf'],
        ['send_image', 'image_path', 'https://example.com/p.png'],
      ]
      for (const [commandName, argKey, url] of expected) {
        const cmd = await plugin.expectCommand()
        assert.equal(cmd.command_name, commandName)
        assert.equal(cmd.args[argKey], url)
        assert.equal(cmd.args.receiver, GROUP_ID)
        plugin.reply(cmd)
      }

      const ids = await sending
      // 设备不回 message_id，适配器就**不填** id（不伪造），而 `sendMessage()` 会把没有
      // id 的消息过滤掉 —— 所以返回值是空数组。这是刻意的：宁可说「发出去了但没法引用」，
      // 也不要给调用方一个拿去撤回必然失败的假 id。见 message.ts 的 addResult()。
      assert.deepEqual(ids, [], '不该伪造 message id')
      assert.equal(plugin.pendingCount, 0, '队列里不该有没被消费的命令')
      console.log('PASS 出站媒体走 URL 入口并带齐 receiver')
    }

    // --- 17. 媒体 URL 不合法时不下发命令，只记 warn ---
    {
      plugin.send(messageEvent({ event_id: 'msg:media2', body: { content: '试试' } }))
      const s = await waitForSession()
      assert.ok(s)
      const sending = s.send([
        h('text', { content: '试试' }),
        // 设备会自己去下载这个地址，给个本地路径只会得到一句没用的报错
        h('audio', { src: '/var/mobile/tmp/a.mp3' }),
        // 入站媒体占位就是这种不带 src 的 img，转发时只发正文
        h('img', {}),
      ])
      const text = await plugin.expectCommand()
      assert.equal(text.command_name, 'send_message')
      plugin.reply(text)
      const ids = await sending
      assert.deepEqual(ids, [], '不该伪造 message id')
      // 队列空 = 那两条被跳过的媒体没产生任何命令（否则这里会挂起等 reply）
      assert.equal(plugin.pendingCount, 0, '被跳过的媒体不该产生命令')
      console.log('PASS 非法媒体 URL 被跳过')
    }

    // --- 18. 查询类 API：群列表 / 群详情 / 群成员 / 好友 ---
    {
      // groups_all → Guild 列表。这条命令一次给全，所以不带 next。
      const guilds = bot.getGuildList()
      const groupsAll = await plugin.expectCommand()
      assert.equal(groupsAll.command_name, 'groups_all')
      plugin.reply(groupsAll, true, '', {
        keyword: '',
        total: 2,
        items: [
          contact({
            account_id: '111@chatroom',
            display_name: '测试群',
            avatar_url: 'https://x/y.png',
          }),
          contact({ account_id: '222@chatroom', display_name: '另一个群' }),
        ],
      })
      const guildList = await guilds
      assert.equal(guildList.data.length, 2)
      assert.equal(guildList.data[0].id, '111@chatroom')
      assert.equal(guildList.data[0].name, '测试群')
      assert.equal(guildList.data[0].avatar, 'https://x/y.png')
      assert.equal(guildList.data[1].avatar, undefined, '空串头像要收敛成 undefined')
      assert.equal(guildList.next, undefined, 'groups_all 没有分页字段')
      console.log('PASS getGuildList → groups_all')

      // room_members → 群资料。名字优先取「群备注」（微信界面上显示的就是它）。
      const guild = bot.getGuild('111@chatroom')
      const roomCmd = await plugin.expectCommand()
      assert.equal(roomCmd.command_name, 'room_members')
      assert.equal(roomCmd.args.room_id, '111@chatroom')
      plugin.reply(roomCmd, true, '', {
        room_id: '111@chatroom',
        room_name: '测试群',
        room_remark: '我的备注',
        members: [],
      })
      const gotGuild = await guild
      assert.equal(gotGuild.id, '111@chatroom')
      assert.equal(gotGuild.name, '我的备注', '群备注优先于群名称')
      console.log('PASS getGuild → room_members')

      // 群成员：is_owner / is_admin 映射成 satori 的 title
      bot.directory.clear()
      const memberList = bot.getGuildMemberList('111@chatroom')
      const memberCmd = await plugin.expectCommand()
      plugin.reply(memberCmd, true, '', {
        room_id: '111@chatroom',
        room_name: '测试群',
        members: [
          contact({ account_id: 'wxid_owner', display_name: '群主大人', is_owner: true }),
          contact({ account_id: 'wxid_admin', display_name: '管理员', is_admin: true }),
          contact({ account_id: 'wxid_plain', display_name: '路人', nick_name: '路人甲' }),
        ],
      })
      const members = await memberList
      assert.equal(members.data.length, 3)
      assert.equal(members.data[0].title, '群主')
      assert.equal(members.data[1].title, '管理员')
      assert.equal(members.data[2].title, undefined, '既非群主也非管理员时不设 title')
      assert.equal(members.data[0].user.id, 'wxid_owner')
      assert.equal(members.data[0].user.name, '群主大人')
      assert.equal(members.data[2].user.nick, '路人甲')
      console.log('PASS getGuildMemberList → room_members（群主/管理员映射为 title）')

      // 单个成员：找不到就抛错，不回一个只有 ID 的空壳
      bot.directory.clear()
      const found = bot.getGuildMember('111@chatroom', 'wxid_plain')
      const findCmd = await plugin.expectCommand()
      plugin.reply(findCmd, true, '', {
        room_id: '111@chatroom', members: [contact({ account_id: 'wxid_plain', display_name: '路人' })],
      })
      assert.equal((await found).user.id, 'wxid_plain')

      bot.directory.clear()
      const missing = bot.getGuildMember('111@chatroom', 'wxid_nobody')
      const missCmd = await plugin.expectCommand()
      plugin.reply(missCmd, true, '', {
        room_id: '111@chatroom', members: [contact({ account_id: 'wxid_plain' })],
      })
      await assert.rejects(() => missing, /没有 wxid_nobody/)
      console.log('PASS getGuildMember 命中与未命中')

      // friends 有分页：next 游标要能当成 offset 传回去
      const page1Promise = bot.getFriendList()
      const friendsCmd = await plugin.expectCommand()
      assert.equal(friendsCmd.command_name, 'friends')
      assert.equal(friendsCmd.args.offset, 0)
      assert.equal(friendsCmd.args.limit, 100)
      plugin.reply(friendsCmd, true, '', {
        limit: 100,
        offset: 0,
        total: 150,
        has_more: true,
        items: [contact({ account_id: 'wxid_f1', display_name: '好友一', remark: '老同学' })],
      })
      const page1 = await page1Promise
      assert.equal(page1.data[0].user.id, 'wxid_f1')
      assert.equal(page1.data[0].nick, '老同学', '备注名进 Friend.nick')
      assert.equal(page1.next, '100')

      const page2Promise = bot.getFriendList(page1.next)
      const page2Cmd = await plugin.expectCommand()
      assert.equal(page2Cmd.args.offset, 100, 'next 游标要变成 offset 传下去')
      plugin.reply(page2Cmd, true, '', {
        limit: 100,
        offset: 100,
        total: 150,
        has_more: false,
        items: [],
      })
      const page2 = await page2Promise
      assert.equal(page2.next, undefined, '没有更多时不带 next')
      console.log('PASS getFriendList 分页')

      // 查询失败必须抛异常 —— 静默返回空数据会被当成「查到了 0 条」
      const failing = bot.getGuildList()
      const failCmd = await plugin.expectCommand()
      plugin.reply(failCmd, false, 'room list unavailable', { room_id: 'x' })
      await assert.rejects(() => failing, /room list unavailable/)
      console.log('PASS 查询失败抛异常（带上 result 诊断）')

      // 账号 / 设备状态：0.8.79 起 device_status 才有 device 段
      const account = bot.internal.getAccountStatus()
      const accountCmd = await plugin.expectCommand()
      assert.equal(accountCmd.command_name, 'account_status')
      plugin.reply(accountCmd, true, '', { account_id: 'wxid_self', display_name: '测试机器人' })
      assert.equal((await account).display_name, '测试机器人')

      const device = bot.internal.getDeviceStatus()
      const deviceCmd = await plugin.expectCommand()
      assert.equal(deviceCmd.command_name, 'device_status')
      plugin.reply(deviceCmd, true, '', {
        ok: true,
        version: '0.8.79',
        device: { ios_version: '16.1.1', device_model: 'iPhone14,3' },
      })
      assert.equal((await device).device?.device_model, 'iPhone14,3')
      console.log('PASS getAccountStatus / getDeviceStatus')
    }

    // --- 19. 写操作：命令名与参数键要逐一对照协议总表 ---
    {
      const kick = bot.kickGuildMember('111@chatroom', 'wxid_bad')
      const kickCmd = await plugin.expectCommand()
      assert.equal(kickCmd.command_name, 'kick_group_member')
      assert.equal(kickCmd.args.room_id, '111@chatroom')
      assert.equal(kickCmd.args.member_id, 'wxid_bad')
      plugin.reply(kickCmd)
      await kick

      // 退群的参数名是 `id` —— 整张命令表里就这一条不是 room_id
      const quit = bot.internal.leaveGuild('111@chatroom')
      const quitCmd = await plugin.expectCommand()
      assert.equal(quitCmd.command_name, 'quit_group')
      assert.equal(quitCmd.args.id, '111@chatroom')
      plugin.reply(quitCmd)
      await quit

      // 撤回：微信只认消息 ID，channelId 用不上
      const revoke = bot.deleteMessage('111@chatroom', '7307587870543245070')
      const revokeCmd = await plugin.expectCommand()
      assert.equal(revokeCmd.command_name, 'revoke_message')
      assert.equal(revokeCmd.args.message_id, '7307587870543245070')
      plugin.reply(revokeCmd)
      await revoke

      const invite = bot.internal.inviteGuildMember('111@chatroom', 'wxid_new')
      const inviteCmd = await plugin.expectCommand()
      assert.equal(inviteCmd.command_name, 'invite_group_member')
      // 协议 v8.0.80 第 16 节统一用 member_ids 数组，单个成员也包一层；不再发旧的 wxid 键
      assert.deepEqual(inviteCmd.args.member_ids, ['wxid_new'])
      assert.equal(inviteCmd.args.room_id, '111@chatroom')
      plugin.reply(inviteCmd)
      await invite

      const delFriend = bot.deleteFriend('wxid_old')
      const delCmd = await plugin.expectCommand()
      assert.equal(delCmd.command_name, 'delete_friend')
      assert.equal(delCmd.args.id, 'wxid_old')
      plugin.reply(delCmd)
      await delFriend

      // 改**群名**和改**我在本群的昵称**是两条不同命令，别串了
      const setName = bot.internal.setGuildName('111@chatroom', '新群名')
      const setNameCmd = await plugin.expectCommand()
      assert.equal(setNameCmd.command_name, 'set_group_name')
      assert.equal(setNameCmd.args.room_id, '111@chatroom')
      assert.equal(setNameCmd.args.new_name, '新群名')
      plugin.reply(setNameCmd)
      await setName

      const setNick = bot.internal.setGuildSelfNickname('111@chatroom', '我的群名片')
      const setNickCmd = await plugin.expectCommand()
      assert.equal(setNickCmd.command_name, 'rename_group')
      assert.equal(setNickCmd.args.new_name, '我的群名片')
      plugin.reply(setNickCmd)
      await setNick

      // 群名只允许空串清空昵称那条命令，自己的参数先在本地校验掉
      await assert.rejects(() => bot.internal.setGuildName('wxid_not_a_room', 'x'), /@chatroom/)
      await assert.rejects(() => bot.internal.setGuildName('111@chatroom', '   '), /不能为空/)

      // 读群公告：原样透传协议结构，不做「有没有公告」的判断
      const notice = bot.internal.getGuildNotice('111@chatroom')
      const noticeCmd = await plugin.expectCommand()
      assert.equal(noticeCmd.command_name, 'get_group_notice')
      plugin.reply(noticeCmd, true, '', {
        room_id: '111@chatroom',
        cached_notice_found: false,
        summary: null,
        html: null,
        html_cached: false,
      })
      assert.equal((await notice).cached_notice_found, false)
      console.log('PASS 群管理写操作与参数键')
    }

    // --- 20. 自发回推 → message_id → 撤回 ---
    {
      // 微信的 `send_message` 回执里没有 message_id，唯一来源是设备把机器人自己
      // 发出去的消息再回推一遍。适配器要在窗口内认领这条回推、把 ID 填进结果。
      const sending = bot.sendMessage(GROUP_ID, '撤回测试')
      const cmd = await plugin.expectCommand()
      assert.equal(cmd.command_name, 'send_message')
      plugin.reply(cmd)

      plugin.send(
        messageEvent({
          event_id: 'msg:616',
          body: {
            message_id: '616',
            content: '撤回测试',
            sender_id: BOT_WXID,
            chat_id: GROUP_ID,
            room_id: GROUP_ID,
            is_group: true,
          },
        }),
      )

      const ids = await sending
      assert.deepEqual(ids, ['616'], '认领到回推后应当返回真实 message_id')

      // 拿这个 ID 撤回：参数就是协议里那条 `revoke_message`
      const revoke = bot.deleteMessage(GROUP_ID, ids[0])
      const revokeCmd = await plugin.expectCommand()
      assert.equal(revokeCmd.command_name, 'revoke_message')
      assert.equal(revokeCmd.args.message_id, '616')
      plugin.reply(revokeCmd)
      await revoke

      // 引用回复的回推帧是 app/quote 形状：正文是 XML，正文匹配不上，
      // 只能靠帧里的 quote_msg_id（就是发送时用的引用目标）认领。
      const quoted = bot.sendMessage(GROUP_ID, [h.quote('7307587870543245070'), h.text('引用认领')])
      const quotedCmd = await plugin.expectCommand()
      assert.equal(quotedCmd.args.quote_message_id, '7307587870543245070')
      plugin.reply(quotedCmd)
      plugin.send(
        messageEvent({
          event_id: 'msg:700',
          body: {
            message_id: '700',
            msg_type: 'app',
            msg_subtype: 'quote',
            quote_msg_id: '7307587870543245070',
            content: 'wxid_self:\n<msg><appmsg><title>引用认领</title></appmsg></msg>',
            sender_id: BOT_WXID,
            chat_id: GROUP_ID,
            room_id: GROUP_ID,
            is_group: true,
          },
        }),
      )
      assert.deepEqual(await quoted, ['700'], '引用回复应当按 quote_msg_id 认领到 id')

      // 没等到回推：不填 id（宁可空数组，也不编一个拿去撤回必然失败的值）
      const late = bot.sendMessage(GROUP_ID, '这条没有回推')
      const lateCmd = await plugin.expectCommand()
      plugin.reply(lateCmd)
      assert.deepEqual(await late, [], '没有回推时不该编造 message_id')
      console.log('PASS 自发回推 → message_id → 撤回')
    }

    // --- 21. 8.0.80 新增：收款 confirmed 判据、转账退还/查询与群操作 ---
    {
      // 收款成功判据只有 confirmed=true（status=callback_ok 是典型成功形态）
      const receiving = bot.internal.receiveTransfer('transfer_1', 'msg_transfer_1')
      const receiveCmd = await plugin.expectCommand()
      assert.equal(receiveCmd.command_name, 'receive_transfer')
      assert.deepEqual(receiveCmd.args, { transfer_id: 'transfer_1', message_id: 'msg_transfer_1' })
      plugin.reply(receiveCmd, true, '', {
        status: 'callback_ok',
        confirmed: true,
        accepted: true,
        callback_received: true,
        ret_code: 0,
      })
      const received = await receiving
      assert.equal(received.ok, true)
      assert.equal(received.confirmed, true, 'confirmed=true 才算确认收款')
      assert.equal(received.status, 'callback_ok')
      assert.equal(received.ret_code, 0)
      assert.equal(received.error, '')

      // confirm_invoked 只是「已发起但等待超时」，confirmed=false：不能抛错、不能认定到账
      const waiting = bot.internal.receiveTransfer(undefined, 'msg_transfer_2')
      const waitingCmd = await plugin.expectCommand()
      assert.equal(waitingCmd.command_name, 'receive_transfer')
      assert.deepEqual(waitingCmd.args, { message_id: 'msg_transfer_2' }, '未提供的 transfer_id 不应下发空串')
      plugin.reply(waitingCmd, true, '', {
        status: 'confirm_invoked',
        accepted: true,
        confirmed: false,
        callback_received: false,
        ret_code: null,
      })
      const waitingOutcome = await waiting
      assert.equal(waitingOutcome.ok, true, '业务未决不等于命令失败')
      assert.equal(waitingOutcome.confirmed, false, 'confirm_invoked 不能当确认收款')
      assert.equal(waitingOutcome.status, 'confirm_invoked')

      // 建群：command_name / args.member_ids / 信封 request_id；回 created 后 room_id 正确
      const creating = bot.internal.createGroup(['wxid_a', 'wxid_b'])
      const createCmd = await plugin.expectCommand()
      assert.equal(createCmd.command_name, 'create_group')
      assert.deepEqual(createCmd.args.member_ids, ['wxid_a', 'wxid_b'])
      assert.ok(createCmd.request_id, 'create_group 的命令信封必须带 request_id')
      plugin.reply(createCmd, true, '', {
        status: 'created',
        mode: 'create',
        request_id: 'create-business-1',
        room_id: '99887766@chatroom',
        member_ids: ['wxid_a', 'wxid_b'],
        created: true,
        all_members_added: true,
      })
      const created = await creating
      assert.equal(created.ok, true)
      assert.equal(created.status, 'created')
      assert.equal(created.room_id, '99887766@chatroom')
      assert.equal(created.created, true)

      // 显式 requestId 原样进信封（同 ID 只用于查询/重放，换 ID 不等于安全重试）
      const replaying = bot.internal.createGroup('wxid_a', { requestId: 'create-replay-1' })
      const replayCmd = await plugin.expectCommand()
      assert.equal(replayCmd.command_name, 'create_group')
      assert.equal(replayCmd.request_id, 'create-replay-1', '显式 requestId 应原样出现在命令信封')
      assert.deepEqual(replayCmd.args.member_ids, ['wxid_a'], '单个成员也要包成数组')
      plugin.reply(replayCmd, true, '', { status: 'created', room_id: '99887766@chatroom' })
      assert.equal((await replaying).status, 'created')

      // 直接加人：ok=false + requires_invitation 也要保留结构化 result，不能抛错
      const adding = bot.internal.addGroupMember(GROUP_ID, ['wxid_a', 'wxid_b'])
      const addCmd = await plugin.expectCommand()
      assert.equal(addCmd.command_name, 'add_group_member')
      assert.equal(addCmd.args.room_id, GROUP_ID)
      assert.deepEqual(addCmd.args.member_ids, ['wxid_a', 'wxid_b'])
      plugin.reply(addCmd, false, 'MEMBERS_NOT_ALL_ADDED', {
        status: 'requires_invitation',
        error_code: 'MEMBERS_NOT_ALL_ADDED',
        invite_required_member_ids: ['wxid_a'],
      })
      const added = await adding
      assert.equal(added.ok, false)
      assert.equal(added.error, 'MEMBERS_NOT_ALL_ADDED')
      assert.equal(added.status, 'requires_invitation')
      assert.deepEqual(added.invite_required_member_ids, ['wxid_a'], '需要单独邀请的成员名单必须保留')

      // 退还：只有 status=refunded + native_status=2002 才是已退还
      const refunding = bot.internal.refundTransfer('transfer_2')
      const refundCmd = await plugin.expectCommand()
      assert.equal(refundCmd.command_name, 'refund_transfer')
      assert.deepEqual(refundCmd.args, { transfer_id: 'transfer_2' })
      plugin.reply(refundCmd, true, '', {
        status: 'refunded',
        native_status: 2002,
        accepted: true,
        confirmed: true,
      })
      const refunded = await refunding
      assert.equal(refunded.ok, true)
      assert.equal(refunded.status, 'refunded')
      assert.equal(refunded.native_status, 2002)

      // 查询：waiting_receive 字段原样透传，can_refund 只表示可退还，不代表已退
      const querying = bot.internal.getTransferStatus(undefined, 'msg_transfer_3')
      const queryCmd = await plugin.expectCommand()
      assert.equal(queryCmd.command_name, 'get_transfer_status')
      assert.deepEqual(queryCmd.args, { message_id: 'msg_transfer_3' })
      plugin.reply(queryCmd, true, '', {
        transfer_id: 'transfer_3',
        status: 'waiting_receive',
        native_status: 1,
        can_refund: true,
      })
      const queried = await querying
      assert.equal(queried.ok, true)
      assert.equal(queried.status, 'waiting_receive')
      assert.equal(queried.can_refund, true)
      assert.equal(plugin.pendingCount, 0, '本段命令都应被消费')
      console.log('PASS 8.0.80 收款 confirmed 判据、转账退还/查询与群操作')
    }

    // --- 22. transfer_refund_result 只走自定义事件，不进消息流 ---
    {
      const refundEvents: any[] = []
      const off = app.on('webridge/transfer-refund-result', (payload) => { refundEvents.push(payload) })
      // event_id 用完整形态 transfer_refund:<refund_result_id>，去重不能按 transfer_id
      plugin.send(platformEvent('transfer_refund_result', {
        refund_result_id: 'refund_result_example',
        transfer_id: 'transfer_2',
        status: 'refunded',
        native_status: 2002,
        confirmed: true,
        accepted: true,
        ret_code: 0,
      }, { event_id: 'transfer_refund:refund_result_example' }))
      await sleep(300)
      off()
      assert.equal(refundEvents.length, 1, '应收到 webridge/transfer-refund-result 事件')
      const payload = refundEvents[0]
      assert.equal(payload.eventName, 'transfer_refund_result')
      assert.equal(payload.kind, 'transfer-refund')
      assert.equal(payload.eventId, 'transfer_refund:refund_result_example')
      assert.equal(payload.body.status, 'refunded')
      assert.equal(payload.body.native_status, 2002)
      console.log('PASS transfer_refund_result 走自定义事件并保留原始字段')
    }

    {
      const command = bot.query('device_status')
      const rejected = assert.rejects(command, /替换/)
      await plugin.expectCommand()
      const echo = bot.waitForSelfEcho(GROUP_ID, '旧连接等待的回推')
      const replacementSocket = await connect(URL_OK)
      const replacement = new FakePlugin(replacementSocket)
      await replacement.handshake()
      const login = await replacement.expectCommand()
      replacement.reply(login)
      await rejected
      assert.equal(await echo.wait(), undefined)
      const disconnected = bot.query('device_status')
      const failed = assert.rejects(disconnected, /断开/)
      await replacement.expectCommand()
      replacementSocket.close()
      await failed
      assert.equal(bot.status, 4, '设备断开后应显示等待重连')
      console.log('PASS 连接替换及断线立即清理请求与回推等待，状态准确')
    }
  } finally {
    // 先卸载依赖方，再关闭 server，避免根作用域先销毁 bots/logger 服务。
    await adapterFork.dispose()
    assert.equal(app.server.wsStack.length, 0, '卸载后不应残留 WebSocket 路由')
    await serverFork.dispose()
    await sleep(100)
    await app.stop()
  }

  console.log('\n全部通过')
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('\n失败：', error)
    process.exit(1)
  },
)
