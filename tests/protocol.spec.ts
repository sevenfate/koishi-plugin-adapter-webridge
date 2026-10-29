/**
 * 协议层单测（纯函数，不依赖 Koishi）。
 *
 * 直接跑：`npx tsx tests/protocol.spec.ts`
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CMD_SEND_MESSAGE,
  MENTION_ALL,
  buildCommand,
  buildHelloAck,
  buildSendMessage,
  createTimeToSeconds,
  dedupKey,
  eventAgeSeconds,
  extractQuoteText,
  groupMemberId,
  groupMemberProfile,
  groupMemberRoomId,
  inboundMedia,
  inboundMentions,
  inboundMessageLabel,
  inboundText,
  isSelfMessage,
  isTextMessageEvent,
  nonMessageEventLabel,
  previewContent,
  quoteEventDetail,
  APP_MSG_TYPE_QUOTE,
  KNOWN_MSG_TYPES,
  buildEventPayload,
  canAcceptFriendRequest,
  frameKind,
  isMemberWxid,
  stripLeadingMentions,
} from '../src/protocol'
import {
  contactToFriend,
  contactToGuild,
  contactToGuildMember,
  contactToUser,
  parseOffset,
  roomToGuild,
} from '../src/contacts'
import { MEDIA_COMMANDS } from '../src/message'
import * as protocol from '../src/protocol'
import { generateSecret, loadOrCreateSecret } from '../src/secret'
import {
  buildHttpUrl,
  buildWebSocketUrl,
  formatHost,
  isLoopbackHost,
  parseCallbackAddress,
  selectLanAddress,
} from '../src/url'
import type { EventFrame } from '../src/types'
import { contact } from './fixtures'

const tests: Array<[string, () => void]> = []
const test = (name: string, fn: () => void) => tests.push([name, fn])

// ---------------------------------------------------------------------------

test('入站 @ 名单忽略空 CDATA 和非法项，保留真实 ID', () => {
  assert.deepEqual(inboundMentions(undefined), [])
  assert.deepEqual(inboundMentions('<![CDATA[]]>'), [])
  assert.deepEqual(inboundMentions(['', ' ', '<![CDATA[]]>', '<![CDATA[ \n ]]>', null, 123, {}]), [])
  assert.deepEqual(inboundMentions([
    ' wxid_member ', '<![CDATA[wxid_bot]]>', '<![CDATA[ wxid_bot ]]>',
    'ordinary_wechat_id', 'notify@all', '<![CDATA[notify@all]]>',
    '<![CDATA[broken', '<xml/>', 'invalid id',
  ]), ['wxid_member', 'wxid_bot', 'ordinary_wechat_id', 'notify@all'])
})

test('buildHelloAck 最简形式只有 type', () => {
  assert.deepEqual(buildHelloAck(''), { type: 'hello_ack' })
  assert.deepEqual(buildHelloAck('1.2.3'), { type: 'hello_ack', server_version: '1.2.3' })
})

test('buildCommand 正常产出', () => {
  const frame = buildCommand('req-1', 'send_message', { receiver: 'wxid_a' })
  assert.deepEqual(frame, {
    type: 'command',
    request_id: 'req-1',
    command_name: 'send_message',
    args: { receiver: 'wxid_a' },
  })
  assert.deepEqual(buildCommand('req-2', 'x').args, {}, 'args 缺省时应当是空对象')
})

test('buildCommand 拒空 request_id / command_name', () => {
  // 插件对这两者为空的帧会静默丢弃，永远等不到结果，所以必须在这里炸掉
  assert.throws(() => buildCommand('', 'send_message'), /requestId/)
  assert.throws(() => buildCommand('req', ''), /commandName/)
})

test('buildSendMessage 基本形态', () => {
  const [name, args] = buildSendMessage('wxid_a', '你好')
  assert.equal(name, CMD_SEND_MESSAGE)
  assert.deepEqual(args, { receiver: 'wxid_a', content: '你好' })
})

test('buildSendMessage 过滤空串与重复的 @ 名单', () => {
  const [, args] = buildSendMessage('123@chatroom', '大家好', [
    'wxid_a',
    '',
    '   ',
    'wxid_a',
    'wxid_b',
  ])
  assert.deepEqual(args.mention_user_list, ['wxid_a', 'wxid_b'])
})

test('buildSendMessage：@所有人 缺字样时补到最前面', () => {
  const [, args] = buildSendMessage('123@chatroom', '开会了', [MENTION_ALL])
  assert.equal(args.content, '@所有人 开会了')
  assert.deepEqual(args.mention_user_list, [MENTION_ALL])
})

test('buildSendMessage：@所有人 已有字样则不重复补', () => {
  const [, args] = buildSendMessage('123@chatroom', '@所有人 开会了', [MENTION_ALL])
  assert.equal(args.content, '@所有人 开会了')
})

test('buildSendMessage：名单里的 notify@all 不参与去重以外的处理', () => {
  const [, args] = buildSendMessage('123@chatroom', 'hi', [MENTION_ALL, 'wxid_a', MENTION_ALL])
  assert.deepEqual(args.mention_user_list, [MENTION_ALL, 'wxid_a'])
})

test('buildSendMessage 拒空 receiver / 全空白正文', () => {
  assert.throws(() => buildSendMessage('', 'x'), /receiver/)
  assert.throws(() => buildSendMessage('   ', 'x'), /receiver/)
  assert.throws(() => buildSendMessage('wxid_a', ''), /content/)
  assert.throws(() => buildSendMessage('wxid_a', '   '), /content/, '全空白正文必须被拒')
})

test('buildSendMessage 引用透传', () => {
  const [, args] = buildSendMessage('wxid_a', '回复', [], '7307587870543245070')
  assert.equal(args.quote_message_id, '7307587870543245070')
  const [, args2] = buildSendMessage('wxid_a', '回复')
  assert.ok(!('quote_message_id' in args2), '没有引用时不该带这个键')
})

// ---------------------------------------------------------------------------

const textEvent = (over: Partial<EventFrame> = {}): EventFrame =>
  ({
    type: 'event',
    event_name: 'message',
    event_id: 'msg:1',
    captured_at_ms: 1_000_000,
    ts_ms: 1_000_000,
    body: { msg_type: 'text', content: 'hi' },
    ...over,
  }) as EventFrame

test('isTextMessageEvent 的各种边界', () => {
  assert.equal(isTextMessageEvent(textEvent()), true)

  // 图片/文件的 content 是原始 XML，当文本送进事件流会污染上下文
  assert.equal(
    isTextMessageEvent(textEvent({ body: { msg_type: 'image', content: '<msg/>' } })),
    false,
  )
  assert.equal(isTextMessageEvent(textEvent({ body: { msg_type: 'text', content: '  ' } })), false)
  assert.equal(isTextMessageEvent(textEvent({ event_name: 'group_member_join' })), false)
  assert.equal(isTextMessageEvent(textEvent({ body: {} })), false)
})

test('dedupKey 优先用 event_id', () => {
  assert.equal(dedupKey(textEvent({ event_id: 'msg:123' })), 'msg:123')
})

test('dedupKey 在 event_id 缺失时用组合键兜底', () => {
  const frame = textEvent({
    event_id: undefined,
    body: { message_id: 'm1', room_id: 'r1' },
  })
  const key = dedupKey(frame)
  assert.ok(key.includes('message') && key.includes('1000000') && key.includes('m1'), key)
})

test('eventAgeSeconds', () => {
  assert.equal(eventAgeSeconds(textEvent({ captured_at_ms: 1_000_000 }), 1_120_000), 120)
  assert.equal(eventAgeSeconds(textEvent({ captured_at_ms: undefined as any }), 1_000), null)
  assert.equal(eventAgeSeconds(textEvent({ captured_at_ms: 'x' as any }), 1_000), null)
  assert.equal(eventAgeSeconds(textEvent({ captured_at_ms: NaN as any }), 1_000), null)
})

test('nonMessageEventLabel 带上关键 ID', () => {
  const label = nonMessageEventLabel(
    textEvent({
      event_name: 'group_member_join',
      body: { room_id: '123@chatroom', member_id: 'wxid_x' },
    }),
  )
  assert.ok(label.startsWith('group_member_join'))
  assert.ok(label.includes('123@chatroom') && label.includes('wxid_x'), label)
})

test('previewContent 压平换行并截断', () => {
  assert.equal(previewContent(''), '')
  assert.equal(previewContent(undefined), '')
  assert.equal(previewContent(123 as any), '')
  assert.equal(previewContent('a\nb'), 'a b')

  const got = previewContent('x'.repeat(100))
  assert.ok(got.startsWith('x'.repeat(80)), got)
  assert.ok(got.includes('+20'), got)
})

test('nonMessageEventLabel 指出为什么被判成非文本（引用回复）', () => {
  const label = nonMessageEventLabel(
    textEvent({
      body: {
        msg_type: 'app',
        app_msg_type: 57,
        msg_subtype: 'quote',
        room_id: '123@chatroom',
        content: '<msg>引用原文</msg>',
      },
    }),
  )
  for (const expected of [
    'msg_type=app',
    'app_msg_type=57',
    'msg_subtype=quote',
    'room_id=123@chatroom',
  ]) {
    assert.ok(label.includes(expected), `${expected} 缺失：${label}`)
  }
  assert.ok(label.includes('content="<msg>引用原文</msg>"'), label)
})

test('inboundMessageLabel 带上 @ 相关字段与正文预览', () => {
  const label = inboundMessageLabel(
    textEvent({
      body: {
        room_id: '123@chatroom',
        sender_id: 'wxid_member',
        is_at: true,
        at_user_list: ['wxid_bot'],
        content: '@凌 /echo 你好',
      },
    }),
  )
  for (const expected of [
    'room=123@chatroom',
    'sender=wxid_member',
    'is_at=true',
    'at=[wxid_bot]',
  ]) {
    assert.ok(label.includes(expected), `${expected} 缺失：${label}`)
  }
  // 前导 `@名字` 会原样出现在正文里 —— 这正是群里 @机器人 时命令匹配不上的原因
  assert.ok(label.includes('@凌'), label)
})

test('媒体日志不包含原始 XML 的解密密钥', () => {
  const label = inboundMessageLabel(textEvent({ body: { msg_type: 'image', content: '<img aeskey="private-key"/>' } }), '', ['图片'])
  assert.ok(label.includes('media=[图片]'))
  assert.ok(!label.includes('private-key'))
  assert.ok(!label.includes('aeskey'))
})

test('stripLeadingMentions 剥掉正文开头的 @名字', () => {
  // 真机样例：@ 与名字之间是 U+2005
  assert.equal(stripLeadingMentions('@凌 /echo 你好'), '/echo 你好')
  assert.equal(stripLeadingMentions('@凌 @白桦树 hello'), 'hello')

  // 整条被剥光说明只是单纯 @人，保留原文，免得会话内容凭空消失
  assert.equal(stripLeadingMentions('@阿飞'), '@阿飞')
  assert.equal(stripLeadingMentions('@凌  @白桦树'), '@凌  @白桦树')

  // 没有前导 @、或 @ 在中间的，都不动
  assert.equal(stripLeadingMentions('你好'), '你好')
  assert.equal(stripLeadingMentions('你好 @阿飞'), '你好 @阿飞')
})

test('quoteEventDetail 打出引用字段与正文首尾', () => {
  const detail = quoteEventDetail(
    textEvent({
      body: {
        msg_type: 'app',
        app_msg_type: 57,
        msg_subtype: 'quote',
        room_id: '123@chatroom',
        quote_msg_id: '7307587870543245070',
        quote_content: '被引用的原文',
        content: 'x'.repeat(500),
      },
    }),
  )
  assert.ok(detail.includes('quote_msg_id="7307587870543245070"'), detail)
  assert.ok(detail.includes('quote_content="被引用的原文"'), detail)
  assert.ok(detail.includes('content_len=500'), detail)
  assert.ok(detail.includes('content_head='), detail)
  // 尾部必须打：微信引用正文有的在 XML 之后，只看开头会误判成「正文不在 content 里」
  assert.ok(detail.includes('content_tail='), detail)
  assert.ok(detail.includes('body_keys=['), detail)
})

// ---------------------------------------------------------------------------
// 入站正文提取 —— 引用消息（msg_type=app）是真机 2026-10-14 实测的形状
// ---------------------------------------------------------------------------

/** 真机抓到的引用消息 content：前缀是「<对方 wxid>:」，正文在第一个 <title> 里。 */
const REAL_QUOTE_CONTENT =
  'wxid_friend:\n<?xml version="1.0"?>\n<msg>\n\t<appmsg appid="" sdkver="0">\n' +
  '\t\t<title>这是引用</title>\n\t\t<des />\n\t</appmsg>\n' +
  '\t<refermsg>\n\t\t<displayname>九命456</displayname>\n\t\t<content>&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;456&lt;/title&gt;</content>\n\t</refermsg>\n</msg>\n'

test('引用消息能取出用户打的正文（真机帧形状）', () => {
  const frame = textEvent({
    body: {
      msg_type: 'app',
      app_msg_type: 57,
      msg_subtype: 'quote',
      content: REAL_QUOTE_CONTENT,
      content_prefix: 'wxid_friend:',
      quote_msg_id: '4439043442319416579',
      quote_content: '<msg><appmsg><title>456</title></appmsg></msg>',
    },
  })
  // 取的是外层第一个 <title>（用户新打的），不是 refermsg 里被引用的那条
  assert.equal(inboundText(frame), '这是引用')
  assert.equal(isTextMessageEvent(frame), true)
})

test('引用正文里的 XML 实体被还原', () => {
  const frame = textEvent({
    body: {
      msg_type: 'app',
      msg_subtype: 'quote',
      content: '<msg><appmsg><title>a &lt;b&gt; &amp;amp; c</title></appmsg></msg>',
    },
  })
  assert.equal(inboundText(frame), 'a <b> &amp; c')
})

test('其他 app 子类型与非消息事件都取不到正文', () => {
  const file = textEvent({ body: { msg_type: 'app', msg_subtype: 'file', content: '<msg/>' } })
  assert.equal(inboundText(file), null)
  assert.equal(inboundText(textEvent({ body: { msg_type: 'image', content: '<msg/>' } })), null)
  assert.equal(inboundText(textEvent({ event_name: 'group_member_join' })), null)
  // 引用消息但 XML 里没有 <title>：交给上层记诊断日志
  const noTitle = textEvent({
    body: { msg_type: 'app', msg_subtype: 'quote', content: '<msg><appmsg></appmsg></msg>' },
  })
  assert.equal(inboundText(noTitle), null)
})

test('extractQuoteText 回落到 content_xml', () => {
  assert.equal(
    extractQuoteText('<msg></msg>', '<msg><appmsg><title>备用</title></appmsg></msg>'),
    '备用',
  )
  assert.equal(extractQuoteText(undefined, undefined), '')
  assert.equal(extractQuoteText(null, 123 as any), '')
})

test('inboundMessageLabel 在原始正文与生效正文不同时两个都打', () => {
  const label = inboundMessageLabel(
    textEvent({ body: { room_id: 'r', is_at: true, at_user_list: ['wxid_bot'], content: '@阿飞 help' } }),
    'help',
  )
  assert.ok(label.includes('content="@阿飞 help"'), label)
  assert.ok(label.includes('text="help"'), label)

  // 没有差别时不要啰嗦
  const same = inboundMessageLabel(textEvent({ body: { room_id: 'r', content: 'help' } }), 'help')
  assert.ok(!same.includes('text='), same)
})

test('inboundMedia 认出入站媒体种类', () => {
  const kind = (body: Record<string, unknown>) => inboundMedia(textEvent({ body }))

  assert.deepEqual(kind({ msg_type: 'image', content: '<msg/>' }), ['image'])
  assert.deepEqual(kind({ msg_type: 'voice' }), ['voice'])
  assert.deepEqual(kind({ msg_type: 'video' }), ['video'])
  assert.deepEqual(kind({ msg_type: 'emoji', content: '<msg/>' }), ['emoji'])
  assert.deepEqual(kind({ msg_type: 'app', app_msg_type: 8, content: '<msg><appmsg><appattach><emoticonmd5>0123456789abcdef0123456789abcdef</emoticonmd5></appattach></appmsg></msg>' }), ['emoji'])
  assert.deepEqual(kind({ msg_type: 'contact_card' }), ['contact_card'])
  assert.deepEqual(kind({ msg_type: 'pat' }), ['pat'])

  // app 要按 msg_subtype 细分 —— 协议里没有 file / link 这两种 msg_type
  assert.deepEqual(kind({ msg_type: 'app', msg_subtype: 'link' }), ['link'])
  assert.deepEqual(kind({ msg_type: 'app', msg_subtype: 'file' }), ['file'])
  assert.deepEqual(kind({ msg_type: 'app', msg_subtype: 'upload' }), ['file'])
  assert.deepEqual(kind({ msg_type: 'app', msg_subtype: 'mini_program' }), ['mini_program'])
  assert.deepEqual(kind({ msg_type: 'app', msg_subtype: 'merged_records' }), ['merged_records'])
  // 认不出的子类归到「应用消息」，不硬塞成链接/文件
  assert.deepEqual(kind({ msg_type: 'app', msg_subtype: 'app_unknown' }), ['app'])
  assert.deepEqual(kind({ msg_type: 'app' }), ['app'])
})

test('inboundMedia 不把引用、文本和通知事件当媒体', () => {
  // 引用消息带的是用户打的字，不是媒体
  assert.deepEqual(
    inboundMedia(
      textEvent({
        body: { msg_type: 'app', msg_subtype: 'quote', content: '<msg><appmsg><title>x</title></appmsg></msg>' },
      }),
    ),
    [],
  )
  assert.deepEqual(inboundMedia(textEvent()), [])
  assert.deepEqual(inboundMedia(textEvent({ event_name: 'group_member_join' })), [])
  // 系统消息（撤回、改群名）不算会话内容
  assert.deepEqual(inboundMedia(textEvent({ body: { msg_type: 'system' } })), [])
  assert.deepEqual(inboundMedia(textEvent({ body: { msg_type: 'unknown' } })), [])
})

test('isSelfMessage 按 sender_id 判机器人自己发出的消息', () => {
  // 下面两个 wxid 的归属来自真机：机器人 = 握手 hello 帧的 account_id
  // （协议文档定义它就是「当前登录的微信 wxid」），九命456 = 在群里发消息、发起引用的那个人。
  const BOT = 'wxid_self'
  const OTHER_USER = 'wxid_friend'

  // 真机实测：机器人自己那条回复的 sender_id 就是 account_id
  const echo = textEvent({ body: { sender_id: BOT, content: '当前可用的指令有：help' } })
  assert.equal(isSelfMessage(echo, BOT), true)

  const fromUser = textEvent({ body: { sender_id: OTHER_USER } })
  assert.equal(isSelfMessage(fromUser, BOT), false)

  // 还不知道自己是谁时（握手前）不能误判
  assert.equal(isSelfMessage(fromUser, undefined), false)
  assert.equal(isSelfMessage(textEvent({ body: {} }), BOT), false)
})

test('createTimeToSeconds：秒、毫秒、非法值', () => {
  assert.equal(createTimeToSeconds(1789205411), 1789205411, '秒值原样返回')
  assert.equal(createTimeToSeconds(1789205411310), 1789205411, '毫秒值要除以 1000')
  // 非法值回落成当前时间（只断言是个合理的秒级时间戳）
  const now = Math.floor(Date.now() / 1000)
  for (const bad of [0, -1, 'abc', null, undefined, NaN]) {
    const got = createTimeToSeconds(bad)
    assert.ok(Math.abs(got - now) < 5, `${String(bad)} 应当回落成当前时间，实际 ${got}`)
  }
})

// ---------------------------------------------------------------------------
// 联系人映射：协议「联系人摘要」→ satori 结构
// ---------------------------------------------------------------------------

test('contactToUser：display_name 进 name，nick_name 进 nick', () => {
  const user = contactToUser(
    contact({
      account_id: 'wxid_a',
      display_name: '备注名',
      nick_name: '微信昵称',
      avatar_url: 'https://x/y.png',
    }),
  )
  assert.equal(user.id, 'wxid_a')
  // display_name 已经是「优先备注名、其次昵称」，就是聊天界面显示的那个名字
  assert.equal(user.name, '备注名')
  assert.equal(user.nick, '微信昵称')
  assert.equal(user.avatar, 'https://x/y.png')
})

test('contactToUser：名称字段全空时兜底成 wxid，空串收敛成 undefined', () => {
  const user = contactToUser(contact({ account_id: 'wxid_a' }))
  assert.equal(user.name, 'wxid_a', '宁可显示一串 ID，也不能给 satori 一个 undefined')
  assert.equal(user.nick, undefined)
  assert.equal(user.avatar, undefined, '空串在 satori 里是「有值但为空」，要收敛')
})

test('contactToUser / contactToGuild：account_id 缺失时抛错，不降级成空串', () => {
  // 空串 id 是个「看起来合法」的毒数据：不会报错，却会污染所有以 id 为键的映射
  // （koishi 自己的群成员表就是 `result[member.user.id] = ...`），事后极难查。
  // 协议里 account_id 是恒有字段，缺了就该当场炸。
  for (const bad of ['', '   ', undefined, null]) {
    assert.throws(
      () => contactToUser(contact({ account_id: bad as any })),
      /account_id/,
      `account_id=${JSON.stringify(bad)} 应当抛错`,
    )
    assert.throws(() => contactToGuild({} as any), /account_id/)
  }
  // 显示名可以兜底成 wxid（那是「没名字」），id 不行
  assert.equal(contactToUser(contact({ account_id: 'wxid_a' })).name, 'wxid_a')
})

test('contactToGuild：群 ID 用 account_id', () => {
  const guild = contactToGuild(
    contact({ account_id: '111@chatroom', display_name: '测试群', avatar_url: 'https://x/y.png' }),
  )
  assert.deepEqual(guild, {
    id: '111@chatroom',
    name: '测试群',
    avatar: 'https://x/y.png',
  })
})

test('roomToGuild：群备注优先于群名称，缺 room_id 时回落传入的 ID', () => {
  assert.equal(
    roomToGuild({ room_id: '111@chatroom', room_name: '群名', room_remark: '我的备注' } as any, 'x')
      .name,
    '我的备注',
  )
  assert.equal(
    roomToGuild({ room_id: '111@chatroom', room_name: '群名', room_remark: '' } as any, 'x').name,
    '群名',
    '没有备注时用群名称',
  )
  assert.equal(roomToGuild({} as any, 'fallback@chatroom').id, 'fallback@chatroom')
})

test('contactToGuildMember：群主 / 管理员映射成 title', () => {
  const owner = contactToGuildMember(contact({ is_owner: true }))
  assert.equal(owner.title, '群主')
  assert.ok(owner.user, '成员一定要带 user')

  const admin = contactToGuildMember(contact({ is_admin: true }))
  assert.equal(admin.title, '管理员')

  // 群主同时也是管理员时以群主为准
  assert.equal(contactToGuildMember(contact({ is_owner: true, is_admin: true })).title, '群主')
})

test('contactToGuildMember：两个标记整个缺失时不设 title', () => {
  // 协议说这两个字段取不到时**整个省略**，不是给 false —— 所以用真值判断
  assert.equal(contactToGuildMember(contact()).title, undefined)
})

test('contactToFriend：备注名进 nick', () => {
  const friend = contactToFriend(
    contact({ account_id: 'wxid_f', display_name: '好友一', remark: '老同学' }),
  )
  assert.equal(friend.user?.id, 'wxid_f')
  assert.equal(friend.nick, '老同学')
  assert.equal(contactToFriend(contact({ account_id: 'wxid_f' })).nick, undefined)
})

test('parseOffset：非法游标一律当第一页', () => {
  assert.equal(parseOffset(undefined), 0, '首次调用没有游标')
  assert.equal(parseOffset(''), 0)
  assert.equal(parseOffset('100'), 100)
  assert.equal(parseOffset('100.7'), 100, '游标要取整')
  for (const bad of ['abc', '-5', '0', 'NaN']) {
    assert.equal(parseOffset(bad), 0, `${bad} 应当当作第一页`)
  }
})

// ---------------------------------------------------------------------------
// 回调地址生成
// ---------------------------------------------------------------------------

test('buildWebSocketUrl：http(s) → ws(s)，保留路径前缀', () => {
  assert.equal(
    buildWebSocketUrl('http://192.168.1.4:5140', '/webridge/sekrit'),
    'ws://192.168.1.4:5140/webridge/sekrit',
  )
  assert.equal(
    buildWebSocketUrl('https://bot.example.com/koishi/', '/webridge/sekrit'),
    'wss://bot.example.com/koishi/webridge/sekrit',
    '反向代理的子路径前缀不能被吃掉',
  )
  assert.equal(
    buildWebSocketUrl('ws://host:5140', 'webridge/sekrit'),
    'ws://host:5140/webridge/sekrit',
    'endpoint 没有前导斜杠时也要能拼',
  )
})

test('buildWebSocketUrl：清掉查询串 / 锚点，默认端口省略', () => {
  assert.equal(
    buildWebSocketUrl('https://bot.example.com:443/koishi?token=1#x', '/webridge/sekrit'),
    'wss://bot.example.com/koishi/webridge/sekrit',
  )
})

test('parseCallbackAddress：拆 origin / path / secret', () => {
  assert.deepEqual(parseCallbackAddress('ws://192.168.1.4:5140/webridge/abc'), {
    origin: 'ws://192.168.1.4:5140',
    path: '/webridge',
    secret: 'abc',
  })
  assert.deepEqual(parseCallbackAddress('wss://example.com/koishi/webridge/abc'), {
    origin: 'wss://example.com',
    path: '/koishi/webridge',
    secret: 'abc',
  })
  assert.deepEqual(parseCallbackAddress('http://host:5140/webridge'), {
    origin: 'http://host:5140',
    path: '/webridge',
    secret: '',
  })
  assert.deepEqual(parseCallbackAddress('ws://host:5140/'), {
    origin: 'ws://host:5140',
    path: '/webridge',
    secret: '',
  })
})

test('parseCallbackAddress：拒绝非法协议 / secret', () => {
  assert.throws(() => parseCallbackAddress('ftp://host/x/y'), /ws/)
  assert.throws(() => parseCallbackAddress('ws://host/x/a.b'), /secret/)
})

test('buildWebSocketUrl：拒绝非 http/ws 协议', () => {
  assert.throws(() => buildWebSocketUrl('ftp://example.com', '/x'), /基地址/)
})

test('buildHttpUrl：ws(s) 基地址换成手机可下载的 http(s)', () => {
  assert.equal(
    buildHttpUrl('ws://192.168.1.4:5140', '/webridge/media/relay/id/token'),
    'http://192.168.1.4:5140/webridge/media/relay/id/token',
  )
  assert.equal(
    buildHttpUrl('wss://bot.example.com/koishi/', '/webridge/media/relay/id/token'),
    'https://bot.example.com/koishi/webridge/media/relay/id/token',
    '反向代理子路径要保留，供手机下载托管媒体',
  )
  assert.equal(
    buildHttpUrl('https://bot.example.com:443/koishi?token=1#x', '/webridge/media/relay/id/abc'),
    'https://bot.example.com/koishi/webridge/media/relay/id/abc',
    '查询串和锚点不能进入托管地址',
  )
})

test('formatHost：IPv6 加方括号，IPv4 / 主机名保持原样', () => {
  assert.equal(formatHost('192.168.1.4'), '192.168.1.4')
  assert.equal(formatHost('bot.example.com'), 'bot.example.com')
  assert.equal(formatHost('::1'), '[::1]')
  assert.equal(formatHost('[::1]'), '[::1]', '已经带方括号的不要重复加')
})

test('isLoopbackHost：只把 loopback 判成本机地址', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('127.0.0.53'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('192.168.1.4'), false)
  assert.equal(isLoopbackHost('bot.example.com'), false)
})

test('selectLanAddress：优先 192.168，忽略 loopback 与 IPv6', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    wifi: [{ address: '192.168.1.4', family: 'IPv4', internal: false }],
    v6: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  } as any
  assert.equal(selectLanAddress(interfaces), '192.168.1.4')
  assert.equal(selectLanAddress({} as any), undefined)
})

// ---------------------------------------------------------------------------
// secret 生成与持久化
// ---------------------------------------------------------------------------

test('generateSecret：32 位且只含 URL 安全字符', () => {
  const first = generateSecret()
  assert.match(first, /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(generateSecret(), first)
})

test('loadOrCreateSecret：配置优先 / 文件复用 / 坏文件重建', () => {
  const cache = join(process.cwd(), 'cache')
  mkdirSync(cache, { recursive: true })
  const dir = mkdtempSync(join(cache, 'webridge-secret-'))
  const file = join(dir, 'secret.json')
  try {
    assert.equal(loadOrCreateSecret(file, 'from-config').secret, 'from-config')

    const first = loadOrCreateSecret(file, '')
    assert.equal(first.source, 'generated')
    assert.ok(existsSync(file), '生成的 secret 应当写盘')

    const second = loadOrCreateSecret(file, '')
    assert.equal(second.source, 'file')
    assert.equal(second.secret, first.secret, '重启后要沿用同一个 secret')

    writeFileSync(file, 'not-json', 'utf8')
    const third = loadOrCreateSecret(file, '')
    assert.equal(third.source, 'generated')
    assert.notEqual(third.secret, first.secret, '坏文件应当重新生成')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    try {
      rmdirSync(cache)
    } catch {
      // cache 里还有别的东西就保留
    }
  }
})

// ---------------------------------------------------------------------------
// 群成员事件（协议 15.6）与目录同步要用的纯函数
// ---------------------------------------------------------------------------

test('isMemberWxid：wxid_ 与自定义微信号都算合法成员', () => {
  // 自定义微信号也可能作为成员 ID，不能要求 wxid_ 前缀。
  for (const id of ['wxid_example', 'custom_user', 'custom.name', 'custom-user', 'a.b_c-d']) {
    assert.equal(isMemberWxid(id), true, `${id} 应当算合法成员`)
  }
})

test('isMemberWxid：挡掉群 ID 与整段 XML', () => {
  assert.equal(isMemberWxid('1234567890@chatroom'), false, '群 ID 不是成员')
  assert.equal(isMemberWxid('<msg><appmsg>…</appmsg></msg>'), false, 'XML 不是成员')
  assert.equal(isMemberWxid(''), false)
  assert.equal(isMemberWxid('   '), false)
  assert.equal(isMemberWxid(null), false)
  assert.equal(isMemberWxid(undefined), false)
  assert.equal(isMemberWxid(123), false)
  // 超长（> 64）挡掉
  assert.equal(isMemberWxid('a'.repeat(65)), false)
  assert.equal(isMemberWxid('a'.repeat(64)), true, '64 位正好是上限')
})

test('groupMemberId：正常取 member_id，异常时兜底其它键', () => {
  const base = { event_name: 'group_member_join', body: {} } as any
  assert.equal(
    groupMemberId({ ...base, body: { member_id: 'wxid_member' } }),
    'wxid_member',
  )
  // 入站解析异常时可能塞进别的键
  assert.equal(groupMemberId({ ...base, body: { wxid: 'custom_user' } }), 'custom_user')
  // 群 ID 不算成员
  assert.equal(groupMemberId({ ...base, body: { member_id: '1@chatroom' } }), undefined)
  // 什么都没有
  assert.equal(groupMemberId({ ...base, body: {} }), undefined)
})

test('groupMemberRoomId：只认 @chatroom 结尾的 room_id', () => {
  const base = { event_name: 'group_member_join', body: {} } as any
  assert.equal(groupMemberRoomId({ ...base, body: { room_id: '1@chatroom' } }), '1@chatroom')
  assert.equal(groupMemberRoomId({ ...base, body: { room_id: 'wxid_x' } }), undefined)
  assert.equal(groupMemberRoomId({ ...base, body: {} }), undefined)
})

test('groupMemberProfile：取不到的字段不放进结果（不填空串覆盖好数据）', () => {
  const base = { event_name: 'group_member_join', body: {} } as any
  const full = groupMemberProfile({
    ...base,
    body: {
      member_id: 'wxid_m',
      member_nick_name: '张三',
      member_display_name: '张三(备注)',
      member_remark: '备注',
      member_alias: 'zhangsan',
      room_nick_name: '群里的张三',
    },
  })
  assert.equal(full.nickname, '张三')
  assert.equal(full.remark, '备注')
  assert.equal(full.alias, 'zhangsan')
  assert.equal(full.displayName, '张三(备注)')
  assert.equal(full.roomNickname, undefined, '入群顶层群名不能当作成员群昵称')

  // 空串不进结果
  const partial = groupMemberProfile({
    ...base,
    body: { member_nick_name: '张三', room_nick_name: '', member_remark: '   ' },
  })
  assert.equal(partial.nickname, '张三')
  assert.equal('roomNickname' in partial, false, '空串不能进结果')
  assert.equal('remark' in partial, false, '纯空白不能进结果')
})

test('groupMemberProfile：昵称变更事件用 new_room_nick_name 覆盖 roomNickname', () => {
  const profile = groupMemberProfile({
    event_name: 'group_member_nickname_change',
    body: {
      member_id: 'wxid_m',
      old_room_nick_name: 'lumen',
      new_room_nick_name: 'lumen123',
      room_nick_name: '旧值不该用',
    },
  } as any)
  assert.equal(profile.roomNickname, 'lumen123', '应取 new_room_nick_name')
  assert.equal(profile.oldRoomNickname, 'lumen')
})

// ---------------------------------------------------------------------------
// 协议 15.1 七种事件的分类与兜底
// ---------------------------------------------------------------------------

function ev(name: string, body: Record<string, unknown> = {}): any {
  return { type: 'event', event_name: name, event_id: 'e:1', captured_at_ms: 1, body }
}

test('frameKind：七种协议事件都能分类', () => {
  assert.equal(frameKind(ev('message', { msg_type: 'text' })), 'message')
  assert.equal(frameKind(ev('message', { msg_type: 'system' })), 'system-message')
  assert.equal(frameKind(ev('group_member_join')), 'group-member')
  assert.equal(frameKind(ev('group_member_leave')), 'group-member')
  assert.equal(frameKind(ev('group_member_nickname_change')), 'group-member')
  assert.equal(frameKind(ev('red_packet_received')), 'red-packet')
  assert.equal(frameKind(ev('transfer_received')), 'transfer')
  assert.equal(frameKind(ev('friend_request')), 'friend-request')
})

test('frameKind：清单外的事件归 unknown，不能当消息处理', () => {
  assert.equal(frameKind(ev('group_dismissed')), 'unknown')
  assert.equal(frameKind(ev('')), 'unknown')
})

test('frameKind：msg_type=system 与普通 message 区分开', () => {
  // 系统消息（撤回/群名修改）不该进消息会话流，但要能单独识别
  assert.equal(frameKind(ev('message', { msg_type: 'system' })), 'system-message')
  assert.equal(frameKind(ev('message', { msg_type: 'text' })), 'message')
})

test('buildEventPayload：原样带上 body 与 event_id', () => {
  const frame = ev('transfer_received', { transfer_id: 't1', amount_fen: 2 })
  const payload = buildEventPayload(frame)
  assert.equal(payload.eventName, 'transfer_received')
  assert.equal(payload.kind, 'transfer')
  assert.equal(payload.eventId, 'e:1')
  assert.equal(payload.body.transfer_id, 't1')
  assert.equal(payload.body.amount_fen, 2)
  assert.equal(payload.frame, frame, '完整原始帧要保留')
})

test('buildEventPayload：event_id 缺失时给 undefined（让调用方兜底去重）', () => {
  const frame = { type: 'event', event_name: 'friend_request', captured_at_ms: 5, body: {} } as any
  const payload = buildEventPayload(frame)
  assert.equal(payload.eventId, undefined)
})

test('canAcceptFriendRequest：缺 ticket 或 encrypt_username 都不能同意', () => {
  // 协议 15.7 明确要求同意前校验这两个字段
  assert.equal(canAcceptFriendRequest({ encrypt_username: 'v3_x', ticket: 't1' } as any), true)
  assert.equal(canAcceptFriendRequest({ encrypt_username: 'v3_x' } as any), false)
  assert.equal(canAcceptFriendRequest({ ticket: 't1' } as any), false)
  assert.equal(canAcceptFriendRequest({ encrypt_username: '', ticket: 't1' } as any), false)
  assert.equal(canAcceptFriendRequest({ encrypt_username: 'v3_x', ticket: '  ' } as any), false)
  assert.equal(canAcceptFriendRequest(undefined), false)
  assert.equal(canAcceptFriendRequest({} as any), false)
})

// ---------------------------------------------------------------------------
// 协议 15.2 的十种 msg_type 全覆盖
// ---------------------------------------------------------------------------

test('frameKind：unknown 与协议外的 msg_type 归 unknown-message', () => {
  // 协议 15.2 明确列了 unknown 这一行
  assert.equal(frameKind(ev('message', { msg_type: 'unknown' })), 'unknown-message')
  // 将来作者加的新类型也会落这里 —— 不能静默丢
  assert.equal(frameKind(ev('message', { msg_type: 'live_photo' })), 'unknown-message')
  assert.equal(frameKind(ev('message', {})), 'unknown-message', 'msg_type 缺失也算认不出')
})

test('frameKind：协议十种 msg_type 都算 message（除 system）', () => {
  for (const t of ['text', 'image', 'voice', 'video', 'contact_card', 'emoji', 'app', 'pat']) {
    assert.equal(frameKind(ev('message', { msg_type: t })), 'message', t + ' 应算 message')
  }
  assert.equal(frameKind(ev('message', { msg_type: 'system' })), 'system-message')
})

test('KNOWN_MSG_TYPES：正好是协议 15.2 列出的十种', () => {
  const expected = ['text', 'image', 'voice', 'video', 'contact_card', 'emoji', 'app', 'pat', 'system', 'unknown']
  assert.equal(KNOWN_MSG_TYPES.size, expected.length)
  for (const t of expected) assert.ok(KNOWN_MSG_TYPES.has(t), t + ' 应在清单里')
})

test('inboundMedia：app 只给数字 app_msg_type 也能细分', () => {
  // msg_subtype 缺失时用数字兜底（协议 15.2 条件字段表）
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', app_msg_type: 5 })), ['link'])
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', app_msg_type: 6 })), ['file'])
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', app_msg_type: 8 })), ['file'])
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', app_msg_type: 19 })), ['merged_records'])
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', app_msg_type: 33 })), ['mini_program'])
  // 都不认识时退化成「应用消息」
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', app_msg_type: 999 })), ['app'])
})

test('inboundMedia：字符串 msg_subtype 优先于数字', () => {
  assert.deepEqual(inboundMedia(ev('message', { msg_type: 'app', msg_subtype: 'link', app_msg_type: 6 })), ['link'])
})

test('inboundText：app 引用两种形态都能取到正文', () => {
  const xml = '<msg><appmsg><title>这是引用</title></appmsg></msg>'
  // 形态一：给了 msg_subtype
  assert.equal(inboundText(ev('message', { msg_type: 'app', msg_subtype: 'quote', content: xml })), '这是引用')
  // 形态二：只给了 app_msg_type=57
  assert.equal(inboundText(ev('message', { msg_type: 'app', app_msg_type: APP_MSG_TYPE_QUOTE, content: xml })), '这是引用')
  // 不是引用时不返回正文
  assert.equal(inboundText(ev('message', { msg_type: 'app', app_msg_type: 5, content: xml })), null)
})

// ---------------------------------------------------------------------------
// 协议 13 的 capabilities 约定
// ---------------------------------------------------------------------------

test('命令常量：与文档 14.2 的拼写逐字一致', () => {
  // 这些名字写错不会报错、只会在运行时得到 unsupported command_name，
  // 所以拿文档里的原样拼写钉一次。
  const expected: Record<string, string> = {
    CMD_ACCEPT_FRIEND_REQUEST: 'accept_friend_request',
    CMD_RECEIVE_RED_PACKET: 'receive_red_packet',
    CMD_RED_PACKET_DETAIL: 'red_packet_detail',
    CMD_RECEIVE_TRANSFER: 'receive_transfer',
    CMD_DELETE_SESSION: 'delete_session',
    CMD_SEND_PAT: 'send_pat',
    CMD_SEND_SIGNAL: 'send_signal',
    CMD_SEND_XML: 'send_xml',
    CMD_FORWARD_MESSAGE: 'forward_message',
    CMD_UPLOAD_MESSAGE_MEDIA: 'upload_message_media',
    CMD_SEND_LINK_CARD: 'send_link_card',
    CMD_SEND_MUSIC_CARD: 'send_music_card',
    CMD_SEND_LIVEPHOTO: 'send_livephoto',
    CMD_PROFILE_NICKNAME: 'profile_nickname',
    CMD_PROFILE_UPDATE: 'profile_update',
    CMD_PROFILE_GENDER: 'profile_gender',
    CMD_PROFILE_REGION: 'profile_region',
    CMD_PROFILE_SIGNATURE: 'profile_signature',
    CMD_PROFILE_PAT_SUFFIX: 'profile_pat_suffix',
    CMD_PROFILE_REGION_CODES: 'profile_region_codes',
    CMD_CLEAR_GENDER_REGION: 'clear_gender_region',
  }
  for (const [name, value] of Object.entries(expected)) {
    assert.equal((protocol as unknown as Record<string, unknown>)[name], value, name + ' 应与文档一致')
  }
})

// ---------------------------------------------------------------------------
// 出站媒体命令映射（图片必须走 send_image，不是 send_emoji）
// ---------------------------------------------------------------------------

test('MEDIA_COMMANDS：图片走 send_image + image_path', () => {
  // 协议文档《插件HTTP接口（v0.8.79）》POST /send_image 写明
  // image_path 支持本地绝对路径或远程 URL；发送图片不能替换成表情命令。
  assert.equal(MEDIA_COMMANDS.img.command, 'send_image')
  assert.equal(MEDIA_COMMANDS.img.arg, 'image_path')
  assert.equal(MEDIA_COMMANDS.image.command, 'send_image')
  assert.equal(MEDIA_COMMANDS.image.arg, 'image_path')
  // 语音 / 视频 / 文件仍然是各自的 URL 入口
  assert.equal(MEDIA_COMMANDS.audio.command, 'send_voice')
  assert.equal(MEDIA_COMMANDS.video.command, 'send_video_from_url')
  assert.equal(MEDIA_COMMANDS.file.command, 'send_file_from_url')
  assert.equal(MEDIA_COMMANDS.file.arg, 'file_url')
  // 语音 / 视频 / 文件保持 URL 入口的参数名
  const constants = protocol as unknown as Record<string, string>
  assert.equal(constants.CMD_SEND_IMAGE, 'send_image')
  assert.equal(constants.CMD_SEND_EMOJI, 'send_emoji')
  assert.equal(constants.CMD_SEND_FILE_FROM_URL, 'send_file_from_url')
})

test('数字形态引用只提取正文，不额外生成应用消息占位', () => {
  const frame = { event_name: 'message', body: {
    msg_type: 'app', app_msg_type: 57,
    content: '<msg><appmsg><title>help</title></appmsg></msg>',
  } } as EventFrame
  assert.equal(inboundText(frame), 'help')
  assert.deepEqual(inboundMedia(frame), [])
})

// ---------------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${(error as Error).message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`)
if (failed) process.exit(1)
