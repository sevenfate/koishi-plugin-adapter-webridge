/**
 * WeBridge 服务端 WebSocket 协议的纯函数层。
 *
 * 这一层**不做任何 IO**，全部是纯函数，方便直接单测。
 *
 * 协议来源：WeBridge 插件作者提供的《服务端 WebSocket 协议说明》（v8.0.80）。
 */

import type { CommandFrame, EventBody, EventFrame, HelloAckFrame } from './types.js'
import { isForwardedEmoji } from './media-reference.js'

// ---------------------------------------------------------------------------
// 帧类型（顶层 "type" 字段）
// ---------------------------------------------------------------------------

export const FRAME_HELLO = 'hello'
export const FRAME_HELLO_ACK = 'hello_ack'
export const FRAME_EVENT = 'event'
export const FRAME_COMMAND = 'command'
export const FRAME_COMMAND_RESULT = 'command_result'
export const FRAME_PING = 'ping'
export const FRAME_PONG = 'pong'

// ---------------------------------------------------------------------------
// 事件名（"event_name" 字段）
// ---------------------------------------------------------------------------

export const EVENT_MESSAGE = 'message'
export const EVENT_MOMENTS_RESULT = 'moments_result'

// ---------------------------------------------------------------------------
// 群成员变更事件（协议文档 15.6）
// ---------------------------------------------------------------------------

/**
 * 群成员进群 / 退群 / 改群昵称。
 *
 * 这三个事件**没有** `msg_type` / `raw_message_type` / `sender_id` / `chat_id`
 * 字段（协议 15.6 明确说它们被主动剥掉了），只能用 `room_id` + `member_id`。
 * 所以它们永远不会进消息会话流，但**必须**派发成 satori 标准的
 * `guild-member-*` 事件，否则群成员目录永远收不到增量更新。
 */
export const EVENT_GROUP_MEMBER_JOIN = 'group_member_join'
export const EVENT_GROUP_MEMBER_LEAVE = 'group_member_leave'
export const EVENT_GROUP_MEMBER_NICKNAME = 'group_member_nickname_change'

/** 三个群成员变更事件 → 对应的 satori 标准事件名。 */
export const GROUP_MEMBER_EVENT_MAP: Record<string, string> = {
  [EVENT_GROUP_MEMBER_JOIN]: 'guild-member-added',
  [EVENT_GROUP_MEMBER_LEAVE]: 'guild-member-removed',
  [EVENT_GROUP_MEMBER_NICKNAME]: 'guild-member-updated',
}

// ---------------------------------------------------------------------------
// 其余非消息事件（协议 15.4 / 15.5 / 15.7）
// ---------------------------------------------------------------------------

/**
 * 收红包。协议 15.4 建议**至少持久化** `red_packet_id` 等字段，
 * 并明确「去重请用它」。注意它挂的 `message_id` 与来源 app 消息**相同** ——
 * 不应只按 message_id 对不同类型事件建唯一约束。
 */
export const EVENT_RED_PACKET = 'red_packet_received'

/**
 * 收转账。协议 15.5 建议至少持久化
 * `transfer_id` / `message_id` / `control_transaction_id` /
 * `amount_text` / `amount_fen` / `sender_id` / `chat_id`，用 `transfer_id` 去重。
 * 金额计算要用 `amount_fen`（整数分），别用浮点。
 */
export const EVENT_TRANSFER = 'transfer_received'

/**
 * 转账退还结果事件（协议 v8.0.80 23.5 末尾）。
 *
 * `event_id` 形如 `transfer_refund:<refund_result_id>`，去重必须用完整 `event_id`，
 * **不能按 `transfer_id` 去重** —— 同笔转账的查询或后续结果会被吞掉。
 *
 * 事件名**不代表退还成功**：只有 `native_status=2002` 且 `status='refunded'`
 * 才确认已退还。事件只在退还提交且操作结束时才可能产生，未收到事件不代表没退还，
 * 所以必须保留 `get_transfer_status` 主动查询路径。
 */
export const EVENT_TRANSFER_REFUND_RESULT = 'transfer_refund_result'

/**
 * 好友申请。协议 15.7 明确说**这个事件的 body 结构有明显不确定性**
 * （`event_id` 有三种生成形态，body 字段"至少包含其中一部分"）。
 * 同意申请前必须校验 `encrypt_username` 和 `ticket` 是否都存在。
 */
export const EVENT_FRIEND_REQUEST = 'friend_request'

/** 系统消息（撤回、群名修改等）的 `msg_type`，协议 15.2 的类型对照表。 */
export const MSG_TYPE_SYSTEM = 'system'

/**
 * 协议 15.1「事件类型总表」里列出的全部事件。
 *
 * ⚠️ **作者没有承诺这是闭合列表**，所以不在这个集合里的 `event_name` 要按
 * 「未知事件」处理并原样透传，兼容设备后续新增的事件。
 */
export const KNOWN_EVENTS = new Set([
  EVENT_MESSAGE,
  EVENT_MOMENTS_RESULT,
  EVENT_RED_PACKET,
  EVENT_TRANSFER,
  EVENT_TRANSFER_REFUND_RESULT,
  EVENT_GROUP_MEMBER_JOIN,
  EVENT_GROUP_MEMBER_LEAVE,
  EVENT_GROUP_MEMBER_NICKNAME,
  EVENT_FRIEND_REQUEST,
])

export const NON_MESSAGE_EVENTS = new Set([
  EVENT_MOMENTS_RESULT,
  EVENT_RED_PACKET,
  EVENT_TRANSFER,
  EVENT_TRANSFER_REFUND_RESULT,
  EVENT_GROUP_MEMBER_JOIN,
  EVENT_GROUP_MEMBER_LEAVE,
  EVENT_GROUP_MEMBER_NICKNAME,
  EVENT_FRIEND_REQUEST,
])

// ---------------------------------------------------------------------------
// 消息类型（"body.msg_type" 字段）
// ---------------------------------------------------------------------------

export const MSG_TYPE_TEXT = 'text'

// 注意：协议里**没有** file / link 两种 msg_type，它们是 app 下的子分类，
// 靠 body.msg_subtype（link / file / upload / merged_records / mini_program /
// quote / app_unknown）区分。不要写 `msg_type === 'file'`。

/** App 类消息（链接、文件、小程序、合并转发、引用都在这一类）。 */
export const MSG_TYPE_APP = 'app'

/**
 * 未能识别的消息类型（协议 15.2 类型对照表的最后一行）。
 *
 * **不能当「没有内容」丢掉**：它是协议明确列出的类型，将来作者加了新类型
 * 也会落在这里。丢掉的后果是「升级后某些消息凭空消失」，而且只能翻日志发现。
 */
export const MSG_TYPE_UNKNOWN = 'unknown'

/** 协议 15.2 列出的全部 `msg_type`。清单外的值一律当 `unknown` 处理。 */
export const KNOWN_MSG_TYPES = new Set([
  MSG_TYPE_TEXT,
  'image',
  'voice',
  'video',
  'contact_card',
  'emoji',
  MSG_TYPE_APP,
  'pat',
  MSG_TYPE_SYSTEM,
  MSG_TYPE_UNKNOWN,
])

/**
 * 引用回复的 `msg_subtype`。
 *
 * **真机实测**（2026-10-14）：用户「引用某条消息 + 打一句话」发出来时，
 * `msg_type` 是 **`app`** 而不是 `text`：
 *
 * ```
 * msg_type=app  app_msg_type=57  msg_subtype=quote
 * content="wxid_xxx:\n<?xml version="1.0"?>\n<msg>\n\t<appmsg …>\n\t\t<title>这是引用</title>…
 * ```
 *
 * 所以只认 `msg_type === 'text'` 会把引用消息整个丢掉。
 */
export const MSG_SUBTYPE_QUOTE = 'quote'

/** 从 XML 里取第一个 `<title>` 的内容。 */
const XML_TITLE = /<title>([\s\S]*?)<\/title>/

/**
 * 还原 XML 实体。
 *
 * `&amp;` 必须**最后**替换 —— 否则 `&amp;lt;` 会被先还原成 `&lt;`、
 * 再被当成转义还原成 `<`，凭空多出尖括号。
 */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 从引用消息的 XML 里取「用户实际打的那句话」。
 *
 * 真机帧里 `content` 是完整引用 XML，外层 `<appmsg>` 的第一个 `<title>`
 * 就是用户新打的字（实测样例 `<title>这是引用</title>`）；被引用的那条原文
 * 在 `quote_content` 里，是另一个字段。
 *
 * 取不到时返回空串，调用方会把它当成「不是可进入会话的文本」。
 */
export function extractQuoteText(content: unknown, contentXml?: unknown): string {
  for (const source of [content, contentXml]) {
    if (typeof source !== 'string' || !source) continue
    const match = XML_TITLE.exec(source)
    if (match) return unescapeXml(match[1]).trim()
  }
  return ''
}

/**
 * 入站媒体的种类。
 *
 * 此处只识别类型，不把加密 CDN 引用当成可读取地址；图片内容由媒体接收器向手机取件。
 */
export type InboundMediaKind =
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'emoji'
  | 'contact_card'
  | 'link'
  | 'mini_program'
  | 'merged_records'
  | 'pat'
  | 'app'

/** 媒体种类 → 中文可读名。日志与占位文本都用它。 */
export const MEDIA_LABELS: Record<InboundMediaKind, string> = {
  image: '图片',
  voice: '语音',
  video: '视频',
  file: '文件',
  emoji: '表情',
  contact_card: '名片',
  link: '链接',
  mini_program: '小程序',
  merged_records: '合并转发',
  pat: '拍一拍',
  app: '应用消息',
}

/**
 * `msg_type` → 媒体种类。
 *
 * `app` 要再按 `msg_subtype` 细分（协议文档：`link`/`file`/`upload`/
 * `merged_records`/`mini_program`/`quote`/`app_unknown`）。注意协议里**没有**
 * `file` / `link` 这两种 `msg_type`，它们都是 `app` 下的子类。
 */
const MSG_TYPE_MEDIA: Record<string, InboundMediaKind> = {
  image: 'image',
  voice: 'voice',
  video: 'video',
  emoji: 'emoji',
  contact_card: 'contact_card',
  pat: 'pat',
}

const APP_SUBTYPE_MEDIA: Record<string, InboundMediaKind> = {
  link: 'link',
  file: 'file',
  // 真机上「上传」也是文件
  upload: 'file',
  mini_program: 'mini_program',
  merged_records: 'merged_records',
}

/**
 * `app_msg_type`（数字）→ 媒体种类。
 *
 * 协议 15.2 的条件字段表给了这组映射：`5` 链接、`6` 文件、`8` 上传、
 * `19` 合并转发、`33` 小程序、`57` 引用。
 *
 * 为什么要这份：协议同时给 `app_msg_type`（数字）和 `msg_subtype`（字符串），
 * 但**没有保证两者一定同时出现**。只认字符串的话，遇到只给数字的帧
 * 就会把整条消息判成「认不出的 app」，退化成 [应用消息] 占位。
 */
const APP_MSG_TYPE_MEDIA: Record<number, InboundMediaKind> = {
  5: 'link',
  6: 'file',
  8: 'file',
  19: 'merged_records',
  33: 'mini_program',
}

/** 协议 15.2 里 `app_msg_type = 57` 就是引用。 */
export const APP_MSG_TYPE_QUOTE = 57

/**
 * 取出一条消息事件携带的媒体种类；没有媒体（或不是消息事件）时返回空数组。
 *
 * `msg_subtype === 'quote'`（引用回复）不走这里 —— 它带的是用户打的字，
 * 由 `inboundText` 处理。
 */
export function inboundMedia(frame: EventFrame): InboundMediaKind[] {
  if (frame?.event_name !== EVENT_MESSAGE) return []
  const body = frame.body
  if (!body || typeof body !== 'object') return []

  const direct = MSG_TYPE_MEDIA[String(body.msg_type ?? '')]
  if (direct) return [direct]

  if (body.msg_type === MSG_TYPE_APP && !isQuoteApp(body)) {
    if (isForwardedEmoji(body)) return ['emoji']
    // 优先按字符串 msg_subtype 细分；缺失/认不出时用数字 app_msg_type 兜底。
    // 两者都没有就归到「应用消息」，别硬塞成链接/文件那种具体名目。
    const bySubtype = APP_SUBTYPE_MEDIA[String(body.msg_subtype ?? '')]
    if (bySubtype) return [bySubtype]
    const byNumber = APP_MSG_TYPE_MEDIA[Number(body.app_msg_type)]
    return [byNumber ?? 'app']
  }

  return []
}

/**
 * 取出一条消息事件里「用户实际打出来的正文」；不是用户打的文本时返回 `null`。
 *
 * 这是判定「这条消息该不该进会话流」的**唯一入口**，两种形态：
 *
 * - `msg_type === 'text'` —— 正文在 `content`；
 * - `msg_type === 'app'` + `msg_subtype === 'quote'` —— 引用回复，正文在
 *   `content` 的 XML `<title>` 里（真机实测）。
 */
export function inboundText(frame: EventFrame): string | null {
  if (frame?.event_name !== EVENT_MESSAGE) return null
  const body = frame.body
  if (!body || typeof body !== 'object') return null

  if (body.msg_type === MSG_TYPE_TEXT) {
    const text = String(body.content ?? '').trim()
    return text || null
  }

  if (body.msg_type === MSG_TYPE_APP && isQuoteApp(body)) {
    const text = extractQuoteText(body.content, body.content_xml)
    return text || null
  }

  return null
}

/**
 * 这条 app 消息是不是「引用回复」。
 *
 * 真机上 `msg_subtype === 'quote'`；但协议的条件字段表里
 * `app_msg_type = 57` 同样表示引用，两者不一定同时给。
 * 只认字符串会把「只有数字形态」的引用消息整条丢掉。
 */
function isQuoteApp(body: EventBody): boolean {
  if (body?.msg_type !== MSG_TYPE_APP) return false
  if (body.msg_subtype === MSG_SUBTYPE_QUOTE) return true
  return Number(body.app_msg_type) === APP_MSG_TYPE_QUOTE && !body.msg_subtype
}

// ---------------------------------------------------------------------------
// 命令名（"command_name" 字段）
// ---------------------------------------------------------------------------

/**
 * 命令名统一在这里定义。
 *
 * 命令名是**写错也不会报错**的那种失误 —— 设备对不认识的名字只回一句
 * `unsupported command_name`，所以集中一处比散在调用点上更容易核对
 * （核对基准：协议文档 14.2「命令总表」）。
 */
export const CMD_SEND_MESSAGE = 'send_message'
export const CMD_SEND_EMOJI = 'send_emoji'
export const CMD_SEND_VOICE = 'send_voice'
export const CMD_SEND_VIDEO_FROM_URL = 'send_video_from_url'
export const CMD_SEND_FILE_FROM_URL = 'send_file_from_url'
export const CMD_REVOKE_MESSAGE = 'revoke_message'

export const CMD_GROUPS_ALL = 'groups_all'
export const CMD_ROOM_MEMBERS = 'room_members'
export const CMD_GET_GROUP_NOTICE = 'get_group_notice'
export const CMD_KICK_GROUP_MEMBER = 'kick_group_member'
export const CMD_INVITE_GROUP_MEMBER = 'invite_group_member'
export const CMD_QUIT_GROUP = 'quit_group'

/**
 * 创建普通群聊（协议 v8.0.80 第 16 节）。
 *
 * 命令信封的 `request_id` 必填：同 ID 只用于查询／重放原业务，**换 ID 重发不等于安全重试**。
 * 成员 ID 由设备再去重、排除本人并排序，去重后至少 2 位其他好友。
 */
export const CMD_CREATE_GROUP = 'create_group'

/**
 * 直接添加群成员（协议 v8.0.80 第 16 节）。
 *
 * 能否直接加入由微信服务端和群设置决定，插件**不会**把添加失败自动转成发送邀请；
 * 原生方法返回成功也不代表成员已经入群，必须看业务 status。
 */
export const CMD_ADD_GROUP_MEMBER = 'add_group_member'

/**
 * 改**我在本群的群昵称**。
 *
 * ⚠️ 别和 `set_group_name` 搞混：协议文档 14.2 里 `rename_group` /
 * `set_group_self_nickname` / `set_group_nickname` 是**同一条命令**的三个名字，
 * 改的都是「我在本群的昵称」；改**整个群名称**的是后面那条 `set_group_name`。
 */
export const CMD_RENAME_GROUP = 'rename_group'
export const CMD_SET_GROUP_NAME = 'set_group_name'

export const CMD_FRIENDS = 'friends'
export const CMD_FRIENDS_ALL = 'friends_all'
export const CMD_DELETE_FRIEND = 'delete_friend'

export const CMD_ACCOUNT_STATUS = 'account_status'
export const CMD_DEVICE_STATUS = 'device_status'
export const CMD_BRIDGE_STATUS = 'bridge_status'
export const CMD_DELETE_SESSION = 'delete_session'

// ---- 消息发送（本地路径入口 / 卡片 / 原始 XML / 拍一拍）----
export const CMD_SEND_IMAGE = 'send_image'
export const CMD_SEND_VIDEO = 'send_video'
export const CMD_SEND_FILE = 'send_file'
export const CMD_SEND_LINK_CARD = 'send_link_card'
export const CMD_SEND_MUSIC_CARD = 'send_music_card'
export const CMD_SEND_XML = 'send_xml'
export const CMD_SEND_SIGNAL = 'send_signal'
export const CMD_SEND_PAT = 'send_pat'
export const CMD_SEND_LIVEPHOTO = 'send_livephoto'

// ---- 消息操作 ----
export const CMD_FORWARD_MESSAGE = 'forward_message'
export const CMD_DOWNLOAD_MESSAGE_MEDIA = 'download_message_media'
export const CMD_UPLOAD_MESSAGE_MEDIA = 'upload_message_media'
export const CMD_MESSAGE_MEDIA_PROBE = 'message_media_probe'
export const CMD_UPLOAD_FILE_TO_WECHAT_CDN = 'upload_file_to_wechat_cdn'

// ---- 好友申请 ----
/**
 * 同意好友申请。
 *
 * ⚠️ **重名陷阱**（协议 14.2 专门警告）：这个命令的 `args.request_id` 是
 * **好友申请的业务 ID**，与命令信封上的 `request_id`（用于结果关联）同名但完全是两回事。
 * 本适配器在下发时把业务 ID 放在 `args` 里，信封的 `request_id` 由 `buildCommand()` 生成。
 *
 * 必需参数 `encrypt_username` + `ticket`（协议 15.7 要求先校验存在性）。
 */
export const CMD_ACCEPT_FRIEND_REQUEST = 'accept_friend_request'

// ---- 红包与转账 ----
export const CMD_RECEIVE_RED_PACKET = 'receive_red_packet'
export const CMD_RED_PACKET_DETAIL = 'red_packet_detail'
/**
 * 确认收款。
 *
 * ⚠️ 成功判据（协议 v8.0.80 14.6）：只有 `ok == true` **且** `result.confirmed == true`
 * 才算确认收款。`status == "confirm_invoked"` 表示已发起收款但等待超时
 * （`confirmed=false`），**不能认定到账**；`callback_received` 只是辅助信号，
 * 失败时同样要读 `result`。结果未知时先查 `get_transfer_status`，不要直接重试。
 */
export const CMD_RECEIVE_TRANSFER = 'receive_transfer'

/**
 * 退还待收取转账（协议 v8.0.80 14.6）。
 *
 * 只有 `status == 'refunded'` 且 `native_status == 2002` 才代表已退还；
 * `refund_pending` / `refund_unknown` 都不能重提，先查状态。
 */
export const CMD_REFUND_TRANSFER = 'refund_transfer'

/** 只查询转账资金状态，不执行收款或退还（协议 v8.0.80 14.6）。 */
export const CMD_GET_TRANSFER_STATUS = 'get_transfer_status'

// ---- 资料管理 ----
export const CMD_CLEAR_GENDER_REGION = 'clear_gender_region'
export const CMD_PROFILE_NICKNAME = 'profile_nickname'
export const CMD_PROFILE_UPDATE = 'profile_update'
export const CMD_PROFILE_GENDER = 'profile_gender'
export const CMD_PROFILE_REGION = 'profile_region'
export const CMD_PROFILE_SIGNATURE = 'profile_signature'
export const CMD_PROFILE_PAT_SUFFIX = 'profile_pat_suffix'
export const CMD_PROFILE_REGION_CODES = 'profile_region_codes'

// ---------------------------------------------------------------------------
// 能力清单缺口（协议 v8.0.80 第 13 节）
// ---------------------------------------------------------------------------

/**
 * 分发器**可执行**、但没有出现在 `hello.capabilities` 里的命令。
 *
 * 协议 v8.0.80 第 13 节明确列出这份缺口：`favorites_list` / `favorites_send` /
 * `favorites_delete` / `set_friend_star` / `set_friend_blacklist` 是可以执行的业务命令，
 * 另有 8 个兼容别名未声明。**清单缺省不等于不支持** —— 只按 capabilities 过滤会误判。
 *
 * 这里只记录缺口；调用后仍须按各命令自己的参数与返回判断业务结果。
 */
export const UNDECLARED_COMMANDS = new Set([
  'favorites_list',
  'favorites_send',
  'favorites_delete',
  'set_friend_star',
  'set_friend_blacklist',
  // 兼容别名，与主命令共用参数和结果（协议 v8.0.80 附录）
  'group_invite_member',
  'group_invite_member_probe',
  'set_group_nickname',
  'set_group_self_nickname',
  'set_group_nickname_probe',
  'set_group_self_nickname_probe',
  'update_nickname',
  'update_nickname_probe',
])

// ---------------------------------------------------------------------------
// @ 相关常量
// ---------------------------------------------------------------------------

/** @所有人的协议标记。它不是 wxid，不要展开成全体成员名单。 */
export const MENTION_ALL = 'notify@all'

/**
 * @所有人在正文里必须出现的字样。
 *
 * 真机实测：名单里放 `notify@all`
 * 但正文不含这四个字时，设备回执照样 `ok=true`、平台侧照样标记成功，
 * **但微信端显示成红色感叹号**。两个条件必须同时满足，所以补字样的逻辑放在这里，
 * 而不是指望调用方记得。
 */
export const MENTION_ALL_TEXT = '@所有人'

/** 服务端版本号，回在 `hello_ack` 里，插件会记进日志。与 package.json 的 version 保持一致。 */
export const SERVER_VERSION = '2.0.0'

/**
 * 等 `command_result` 的默认超时（毫秒）。
 *
 * 放在这里而不是只写在 Schema 里，是因为**两处都要用**：Schema 的 `default()` 给控制台填值，
 * 而 `message.ts` 里类型收窄时需要一个非 undefined 的兜底值。写成一个常量就不会出现
 * 「Schema 改了、代码里的兜底没改」。
 */
export const DEFAULT_COMMAND_TIMEOUT = 15000

/**
 * 发媒体时的默认超时（毫秒）。设备要先把 URL 下载下来再转码 / 上传，
 * 协议文档说 `send_voice` / `send_video_from_url` 这类命令耗时可达数秒以上，
 * 所以和普通命令分开、放宽到 2 分钟。
 */
export const DEFAULT_MEDIA_TIMEOUT = 120000

/**
 * 发完消息后等「设备回推自己那条消息」的默认超时（毫秒）。
 *
 * 微信的 `send_message` 回执里**没有** `message_id`，而 `revoke_message` 只认它；
 * 唯一来源是设备会把机器人自己发出的消息当成 `message` 事件回推一遍，
 * 那一帧里带着 `message_id`（真机实测只比 `command_result` 晚约 2ms）。
 *
 * 所以 `sendMessage()` 会在这个窗口内等回推；等不到就不填 id（不伪造）。
 * 真机上基本是 0 成本，窗口只兜底设备异常的情况。
 */
export const DEFAULT_ECHO_TIMEOUT = 1000

// ---------------------------------------------------------------------------
// 出站帧构造
// ---------------------------------------------------------------------------

/** 构造 `hello_ack`。除 `type` 外都不是必需字段。 */
export function buildHelloAck(serverVersion: string = SERVER_VERSION): HelloAckFrame {
  const frame: HelloAckFrame = { type: FRAME_HELLO_ACK }
  if (serverVersion) frame.server_version = serverVersion
  return frame
}

/**
 * 构造 `command` 帧。
 *
 * @throws 当 `requestId` 或 `commandName` 为空时。插件对这两者为空的帧会
 *   **静默丢弃、不回任何结果**，在这里炸掉远好过业务侧永远等一个不会来的响应。
 */
export function buildCommand(
  requestId: string,
  commandName: string,
  args: Record<string, unknown> = {},
): CommandFrame {
  if (!requestId) throw new Error('requestId must not be empty')
  if (!commandName) throw new Error('commandName must not be empty')
  return { type: FRAME_COMMAND, request_id: requestId, command_name: commandName, args }
}

/**
 * 构造一条发文本消息的 `(命令名, 参数)`。
 *
 * @所有人 的双条件在这里统一处理：只要名单里出现了 `notify@all`，
 * 就保证正文里含 `@所有人` 字样，缺了就补到最前面。
 *
 * @throws 当 `receiver` 或 `content`（判空要 trim）为空时。
 */
export function buildSendMessage(
  receiver: string,
  content: string,
  mentionUserList: readonly string[] = [],
  quoteMessageId?: string,
): [string, Record<string, unknown>] {
  if (!receiver || !receiver.trim()) throw new Error('receiver must not be empty')

  const mentions: string[] = []
  for (const raw of mentionUserList) {
    const item = (raw ?? '').trim()
    if (item && !mentions.includes(item)) mentions.push(item)
  }

  let text = content ?? ''
  // 判空必须 trim：全空白串在微信里就是一条空消息，不如在这里拒掉。
  if (!text.trim()) throw new Error('content must not be empty')

  if (mentions.includes(MENTION_ALL) && !text.includes(MENTION_ALL_TEXT)) {
    text = `${MENTION_ALL_TEXT} ${text}`.trimEnd()
  }

  const args: Record<string, unknown> = { receiver, content: text }
  if (mentions.length) args.mention_user_list = mentions
  if (quoteMessageId) args.quote_message_id = String(quoteMessageId)
  return [CMD_SEND_MESSAGE, args]
}

// ---------------------------------------------------------------------------
// 入站帧判定
// ---------------------------------------------------------------------------

/** 判断一个 `event` 帧是否为「可进入事件流的文本消息」（含引用回复）。 */
export function isTextMessageEvent(frame: EventFrame): boolean {
  return inboundText(frame) !== null
}

/**
 * 算出一个 `event` 帧的去重键。
 *
 * 协议规定事件**会重复**（连接抖动、重连补发都会导致同一事件推两次），必须去重。
 * 正常情况下用 `event_id`；但协议明确说它**可能整个字段缺失**，所以要有兜底组合键。
 * `transfer_refund_result` 的 `event_id` 由 `refund_result_id` 拼成，缺 `event_id`
 * 时用 `refund_result_id` 兜底（协议 v8.0.80 23.5）。
 *
 * 注意 `event_id` 是不透明的，**不要解析它的格式**，整体当键即可。
 */
export function dedupKey(frame: EventFrame): string {
  if (frame?.event_id) return String(frame.event_id)
  const body: EventBody = frame?.body ?? {}
  return [
    frame?.event_name,
    frame?.captured_at_ms,
    body.message_id,
    body.room_id,
    body.member_id,
    body.refund_result_id,
    ...(frame?.event_name === EVENT_MOMENTS_RESULT ? [frame.account_id, body.operation_id, body.revision] : []),
  ].join('|')
}

/**
 * 算一个 `event` 帧「迟到」了多少秒。
 *
 * 业务时间要用 `captured_at_ms`（事件被捕获的时刻），**不要用** `ts_ms`
 * 或 `enqueued_at_ms` —— 那两个在补发时是入队时间，会显得很新。
 *
 * @returns 迟到秒数；`captured_at_ms` 缺失或不是数字时返回 `null`。
 */
export function eventAgeSeconds(frame: EventFrame, nowMs: number): number | null {
  const captured = frame?.captured_at_ms
  if (typeof captured !== 'number' || !Number.isFinite(captured)) return null
  return (nowMs - captured) / 1000
}

/** 日志里展示的正文最大长度。够看清前导 `@名字`、也能看出是不是 XML 串。 */
const LOG_PREVIEW_LENGTH = 80

/**
 * 把正文压成一行短预览，供日志使用。
 *
 * 换行会把一条日志拆成好几行，所以先压平；超长则截断并标出还剩多少字，
 * 免得一条图片/转发的 XML 把日志刷爆。
 */
export function previewContent(value: unknown, limit = LOG_PREVIEW_LENGTH): string {
  const text = typeof value === 'string' ? value : ''
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…(+${flat.length - limit})`
}

/**
 * 给非消息事件拼一句日志用的关键信息。
 *
 * 除了 ID，还会带上**为什么它被判成非文本**：`msg_type` / `app_msg_type` /
 * `msg_subtype` 能把「引用回复」这类被误判的消息直接指出来，正文预览则用来
 * 确认字段到底装了什么。没有这些字段时（群成员变动之类的通知事件）不会多打印内容。
 */
export function nonMessageEventLabel(frame: EventFrame): string {
  const body: EventBody = frame?.body ?? {}
  const parts: string[] = [String(frame?.event_name ?? '?')]
  const keys: Array<[string, string]> = [
    ['room_id', 'room_id'],
    ['member_id', 'member_id'],
    ['red_packet_id', 'red_packet_id'],
    ['transfer_id', 'transfer_id'],
    ['encrypt_username', 'encrypt_username'],
  ]
  for (const [label, key] of keys) {
    const value = body[key]
    if (value) parts.push(`${label}=${value}`)
  }
  if (body.msg_type) parts.push(`msg_type=${body.msg_type}`)
  if (body.app_msg_type !== undefined) parts.push(`app_msg_type=${body.app_msg_type}`)
  if (body.msg_subtype) parts.push(`msg_subtype=${body.msg_subtype}`)
  const preview = previewContent(body.content)
  if (preview) parts.push(`content="${preview}"`)
  return parts.join(' ')
}

/**
 * 这条消息是不是机器人自己发出去的。
 *
 * **真机实测**（2026-10-14）：机器人发出去的消息会作为事件**绕回来**，而且
 * `sender_id` 就是机器人自己的 `account_id` —— 回复完 0 毫秒后收到一条
 * `sender=<机器人 wxid>`、内容与刚发出的回复逐字相同的消息。
 *
 * 协议文档说明 `from_user` / `to_user` / `self_user` 等方向字段会被设备**主动剥掉**，
 * 服务端只能靠 `sender_id` 与 `account_id` 比较来判断方向 —— 这正是官方给的做法。
 *
 * 不丢的话，机器人会把自己的输出当成用户输入：若回复内容以指令名开头，
 * 或有中间件对任何消息都回复，就会**无限自我回环**。
 */
export function isSelfMessage(frame: EventFrame, accountId?: string): boolean {
  if (!accountId) return false
  const sender = String(frame?.body?.sender_id ?? '')
  return Boolean(sender) && sender === accountId
}

/** 清洗设备上报的 @ 名单，避免空 CDATA 被 Koishi 当成真实的 at 段。 */
export function inboundMentions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    const wrapped = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(text)
    const id = (wrapped ? wrapped[1] : text).trim()
    // ID 不包含 XML 标记或空白；保留普通微信号和 notify@all，不限定 wxid_ 前缀。
    if (id && !/[<>\s]/u.test(id)) result.add(id)
  }
  return [...result]
}

/** 给「进入会话流」的消息拼一句日志。`is_at` / `at_user_list` 用来确认 @ 有没有被解析。 */
export function inboundMessageLabel(
  frame: EventFrame,
  effectiveText?: string,
  mediaLabels?: readonly string[],
): string {
  const body: EventBody = frame?.body ?? {}
  const room = body.room_id || body.chat_id || '-'
  const parts = [`room=${room}`, `sender=${body.sender_id || '-'}`]
  if (body.is_at) parts.push('is_at=true')
  const mentions = Array.isArray(body.at_user_list) ? body.at_user_list.filter(Boolean) : []
  if (mentions.length) parts.push(`at=[${mentions.join(',')}]`)
  if (body.at_all) parts.push('at_all=true')
  if (mediaLabels?.length) parts.push(`media=[${mediaLabels.join(',')}]`)

  // 媒体原始正文是带密钥的 XML；日志只显示已解析正文，不打印取件凭据。
  const raw = previewContent(mediaLabels?.length ? effectiveText ?? '' : body.content)
  parts.push(`content="${raw}"`)
  // 同时打出「生效后的正文」。只打 content（设备原始值）的话，
  // 「前导 @名字 到底剥没剥掉」在日志里根本看不出来。
  if (effectiveText !== undefined) {
    const effective = previewContent(effectiveText)
    if (effective !== raw) parts.push(`text="${effective}"`)
  }
  return parts.join(' ')
}

/** 正文开头连续的 `@某人`。真机里 @ 与名字之间会夹 U+2005 之类的空白。 */
const LEADING_MENTIONS = /^(?:@[^\s@]+\s*)+/

/**
 * 剥掉正文开头的 `@某人`。
 *
 * **真机实测**：群里 @ 人时，设备会把「@显示名」也拼进 `content`
 * （样例 `"@阿飞"`，另有 `"@凌 /echo 你好"`），而同一批 @ 已经在
 * `at_user_list` 里了。正文里这一份是重复的，更麻烦的是它会插在指令名前面，
 * 让「以指令名开头」的匹配彻底失效 —— 表现就是机器人「不理人」。
 *
 * 整条正文都被剥光时**保留原文**：那说明这条消息只是单纯 @人没有正文，
 * 留个空字符串会让会话内容凭空消失。
 *
 * 调用方**无条件**调用它 —— 设备有时不给 `at_user_list`（真机实测有一条 @ 消息
 * 完全没有 `is_at` / `at_user_list`），按「有没有名单」决定剥不剥会漏掉那种情况。
 */
export function stripLeadingMentions(text: string): string {
  const stripped = text.replace(LEADING_MENTIONS, '')
  return stripped.trim() ? stripped : text
}

/**
 * 引用消息的完整诊断串 —— 只在 `msg_subtype === 'quote'` 的排查日志里用。
 *
 * 为什么需要它：引用消息的 `msg_type` 是 `app`，正文既可能在 `content`
 * （开头是 `<对方 wxid>: <?xml …`，真机实测约 1000 字），也可能在 `quote_*`
 * 系列字段里。只看截断的预览判断不出「用户打的那句话在哪」，所以这里把
 * 相关字段、正文长度和**首尾两段**都打出来 —— 微信的引用正文有的在 XML 之后，
 * 只看开头会误判成「正文不在 content 里」。
 */
export function quoteEventDetail(frame: EventFrame): string {
  const body: EventBody = frame?.body ?? {}
  const parts: string[] = []
  const keys = [
    'quote_msg_id',
    'quote_from_user',
    'quote_display_name',
    'quote_content',
    'quote_msg_type',
    'quote_create_time',
    'content_prefix',
  ]
  for (const key of keys) {
    const value = body[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${JSON.stringify(value)}`)
  }

  const content = typeof body.content === 'string' ? body.content : ''
  parts.push(`content_len=${content.length}`)
  if (content) {
    parts.push(`content_head=${JSON.stringify(content.slice(0, 200))}`)
    if (content.length > 200) parts.push(`content_tail=${JSON.stringify(content.slice(-200))}`)
  }
  // body 的真实键名可能超出协议文档列出的范围，一并打出来便于发现漏掉的字段。
  parts.push(`body_keys=[${Object.keys(body).sort().join(',')}]`)
  return parts.join(' ')
}

/**
 * 把协议里的 `create_time` 归一到「秒」。
 *
 * 协议规定它是秒，但实际出现过毫秒值，所以对明显偏大的数除以 1000。
 */
export function createTimeToSeconds(value: unknown): number {
  const now = Math.floor(Date.now() / 1000)
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num <= 0) return now
  return num > 10_000_000_000 ? Math.floor(num / 1000) : Math.floor(num)
}

// ---------------------------------------------------------------------------
// 群成员相关（目录同步要用）
// ---------------------------------------------------------------------------

/**
 * 群成员 ID（wxid 或自定义微信号）允许的字符集。
 */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_.\-]+$/
const MEMBER_ID_MAX_LENGTH = 64

/**
 * 这个 ID 像不像一个群成员账号。
 *
 * ⚠️ **不能用前缀白名单**。真机实测 `member_id` 既可能是 `wxid_` 开头的内部 ID，
 * 也可能是用户自定义微信号，因此不能要求 wxid_ 前缀。
 *
 * 真正要挡的只有两种非成员形态：
 * 1. **群 ID**（`...@chatroom` 结尾）—— 有些事件会把 room_id 塞进 member_id；
 * 2. **整段 XML**（`<msg ...>`）—— 入站解析异常时会被塞进 member_id。
 */
export function isMemberWxid(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const candidate = value.trim()
  if (!candidate || candidate.length > MEMBER_ID_MAX_LENGTH) return false
  if (candidate.endsWith('@chatroom')) return false
  return MEMBER_ID_PATTERN.test(candidate)
}

/**
 * 从群成员变更事件里取出被变更的成员 ID。
 *
 * 协议 15.6 说字段名是 `member_id`，但入站解析异常时可能塞进别的键，
 * 因此需要兼容备用字段；取到的值必须通过 `isMemberWxid()`。
 *
 * 取不到就返回 `undefined`（而不是空串）—— 空串会被下游当成合法 ID 存进去。
 */
export function groupMemberId(frame: EventFrame): string | undefined {
  const body: EventBody = frame?.body ?? {}
  for (const key of ['member_id', 'wxid', 'user_name', 'id'] as const) {
    const value = body[key]
    if (isMemberWxid(value)) return String(value).trim()
  }
  return undefined
}

/**
 * 群成员变更事件里带的展示资料。
 *
 * 字段来源见协议 15.6 的样例：`member_nick_name` / `member_remark` /
 * `member_alias` / `member_display_name` / `room_nick_name`。
 * 昵称变更事件额外带 `old_room_nick_name` / `new_room_nick_name`。
 *
 * 取不到的字段**不放进返回值**（而不是填空串）—— 空串会覆盖掉已有的好数据。
 */
export function groupMemberProfile(frame: EventFrame): Record<string, string> {
  const body: EventBody = frame?.body ?? {}
  const profile: Record<string, string> = {}
  const mapping: Array<[string, string]> = [
    ['nickname', 'member_nick_name'],
    ['remark', 'member_remark'],
    ['alias', 'member_alias'],
    ['displayName', 'member_display_name'],
  ]
  for (const [target, source] of mapping) {
    const value = body[source]
    if (typeof value === 'string' && value.trim()) profile[target] = value.trim().slice(0, 255)
  }
  // 昵称变更事件专用的两个字段
  if (typeof body.old_room_nick_name === 'string') {
    profile.oldRoomNickname = body.old_room_nick_name.trim().slice(0, 255)
  }
  if (frame.event_name === EVENT_GROUP_MEMBER_NICKNAME && typeof body.new_room_nick_name === 'string') {
    profile.roomNickname = body.new_room_nick_name.trim().slice(0, 255)
  }
  return profile
}

/**
 * 群成员变更事件所属的群 ID。
 *
 * 群成员事件永远发生在群里（协议 15.6），`room_id` 就是会话。
 * 取不到或不像群 ID 时返回 `undefined`。
 */
export function groupMemberRoomId(frame: EventFrame): string | undefined {
  const body: EventBody = frame?.body ?? {}
  const value = typeof body.room_id === 'string' ? body.room_id.trim() : ''
  return value.endsWith('@chatroom') ? value : undefined
}

/**
 * 帧的分类 —— 决定它该派发成什么事件。
 *
 * 取值对应协议 v8.0.80 23.1 的九种事件（message、三个群成员变更、红包、转账、
 * 转账退还结果、好友申请、朋友圈结果），另加兜底：
 * - `system-message`：`message` 事件但 `msg_type === 'system'`（撤回、群名修改）；
 * - `unknown-message`：`message` 事件但 `msg_type` 是 `unknown` 或认不出的新类型；
 * - `unknown`：不在协议清单里的 `event_name`（插件版本比我们新）。
 *
 * **兜底不是可选的**：协议没有承诺事件清单是闭合的，静默丢弃会让升级后
 * 的新事件凭空消失，而且排查时只能翻日志。
 */
export type FrameKind =
  | 'message'
  | 'system-message'
  | 'unknown-message'
  | 'group-member'
  | 'red-packet'
  | 'transfer'
  | 'transfer-refund'
  | 'friend-request'
  | 'moments-result'
  | 'unknown'

export function frameKind(frame: EventFrame): FrameKind {
  const name = String(frame?.event_name ?? '')
  if (name === EVENT_MESSAGE) {
    const msgType = String(frame?.body?.msg_type ?? '')
    if (msgType === MSG_TYPE_SYSTEM) return 'system-message'
    // 以下两类都算「认不出的消息」，但仍然是 message 事件，要单独派发：
    // 1. 协议 15.2 里显式列出的 `unknown`（它是"认不出"，不是一种内容类型）；
    // 2. 协议十种之外的值（作者将来加的新类型）。
    if (msgType === MSG_TYPE_UNKNOWN || !KNOWN_MSG_TYPES.has(msgType)) return 'unknown-message'
    return 'message'
  }
  if (GROUP_MEMBER_EVENT_MAP[name]) return 'group-member'
  if (name === EVENT_RED_PACKET) return 'red-packet'
  if (name === EVENT_TRANSFER) return 'transfer'
  if (name === EVENT_TRANSFER_REFUND_RESULT) return 'transfer-refund'
  if (name === EVENT_FRIEND_REQUEST) return 'friend-request'
  if (name === EVENT_MOMENTS_RESULT) return 'moments-result'
  return 'unknown'
}

/**
 * 拼一个「原样透传」的事件载荷。
 *
 * 用于红包 / 转账 / 好友申请 / 未知事件：satori 里没有对应的标准结构，
 * 但又不能丢 —— 把这些字段原样交给监听方，由它决定怎么存。
 *
 * 刻意**不解析 content_xml**（协议 15.5 提醒它体积可观），
 * 原样保留在 `body` 里，需要的人自己取。
 */
export interface WebridgeEventPayload {
  /** 协议 `event_name`。 */
  eventName: string
  /** 帧分类，见 `frameKind()`。 */
  kind: FrameKind
  /** 协议 `event_id`，可能缺失（缺失时为 `undefined`，调用方要用 `dedupKey` 兜底）。 */
  eventId?: string
  /** 事件被捕获的毫秒时间戳。 */
  capturedAt: number
  /** 事件体，原样。 */
  body: EventBody
  /** 完整原始帧（含 device_id / runtime_version 等）。 */
  frame: EventFrame
}

export function buildEventPayload(frame: EventFrame): WebridgeEventPayload {
  return {
    eventName: String(frame?.event_name ?? ''),
    kind: frameKind(frame),
    eventId: frame?.event_id ? String(frame.event_id) : undefined,
    capturedAt: Number(frame?.captured_at_ms ?? Date.now()),
    body: (frame?.body ?? {}) as EventBody,
    frame,
  }
}

/**
 * 这个事件里够不够「同意好友申请」的必要字段。
 *
 * 协议 15.7 明确要求：**同意申请前请先校验 `encrypt_username` 和 `ticket`
 * 是否都存在**，缺失时不要盲调 `accept_friend_request`。
 */
export function canAcceptFriendRequest(body: EventBody | undefined): boolean {
  if (!body || typeof body !== 'object') return false
  const encrypt = typeof body.encrypt_username === 'string' ? body.encrypt_username.trim() : ''
  const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : ''
  return Boolean(encrypt) && Boolean(ticket)
}
