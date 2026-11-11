/**
 * WeBridge 服务端 WebSocket 协议的帧类型定义。
 *
 * 字段名一律保持协议原文的 snake_case —— 这些类型描述的是**网线上**的结构，
 * 不跟着 TS 的命名习惯走，免得写代码时把 `event_id` 记成 `eventId` 发出去。
 *
 * 协议来源：WeBridge 插件作者提供的《服务端 WebSocket 协议说明》（v8.0.80）。
 */

/** `hello.state` —— 注意 WebSocket 模式下只有这 4 个字段（长轮询模式有 20 个）。 */
export interface WebridgeState {
  is_logged_in: boolean
  account_id: string
  auth_authorized: boolean
  plugin_enabled: boolean
}

/**
 * 每个请求都会带的身份与版本字段。
 *
 * `device_id` 首次启动生成后持久化（重启不变），适合做设备主键；
 * `session_id` 每次插件进程启动重新生成，只适合做本次连接关联键。
 */
export interface WebridgeCommon {
  device_id: string
  session_id: string
  account_id: string
  runtime_version: string
  build_marker: string
  ts_ms: number
}

/** 插件 → 服务端：握手。必须在 10 秒内回 `hello_ack`。 */
export interface HelloFrame extends WebridgeCommon {
  type: 'hello'
  capabilities: string[]
  state: WebridgeState
}

/**
 * `event` 帧的 body。
 *
 * 大部分字段都是可选的 —— 协议里说同一字段在不同事件类型下可能整个不存在，
 * 而不是给个空值。别用 `!` 断言，一律走可选链 + 兜底。
 */
export interface EventBody {
  message_id?: string
  msg_type?: string
  raw_message_type?: number
  msg_subtype?: string
  chat_id?: string
  room_id?: string
  sender_id?: string
  is_group?: boolean
  is_at?: boolean
  at_all?: boolean
  at_user_list?: string[]
  create_time?: number
  content?: string
  // content 能被识别为 XML 时出现
  content_xml?: string
  /** XML 之前的非空文本前缀。真机引用消息里是 `"<对方 wxid>:"`。 */
  content_prefix?: string
  // App 类消息（msg_type === 'app'）的细分。引用是 app_msg_type=57 / msg_subtype='quote'
  app_msg_type?: number
  app_msg_title?: string
  app_msg_url?: string
  voice_url?: string
  voice_aes_key?: string
  voice_md5?: string
  voice_data_length?: number
  voice_length_ms?: number
  emoji_cdn_url?: string
  emoji_encrypt_url?: string
  emoji_aes_key?: string
  emoji_md5?: string
  emoji_length?: number
  // 部分设备可能提供；没有这些字段时，从媒体 XML 读取引用，不假定一定存在。
  video_url?: string
  video_aes_key?: string
  video_md5?: string
  video_length?: number
  file_url?: string
  file_aes_key?: string
  file_md5?: string
  file_name?: string
  file_size?: number
  // 被引用时出现（真机实测只在 msg_subtype === 'quote' 时给出）
  quote_msg_id?: string
  quote_from_user?: string
  quote_chat_user?: string
  quote_display_name?: string
  quote_content?: string
  quote_msg_type?: number
  quote_create_time?: number
  // 群成员事件
  member_id?: string
  old_room_nick_name?: string
  new_room_nick_name?: string
  // 红包 / 转账 / 好友申请
  red_packet_id?: string
  transfer_id?: string
  encrypt_username?: string
  ticket?: string
  // 转账退还结果事件（协议 v8.0.80 23.5）的业务结果字段；类型与 14.6 的结果表一致
  ok?: boolean
  accepted?: boolean
  confirmed?: boolean
  status?: string
  native_status?: number | null
  ret_code?: number | null
  error_code?: string
  /** 本次结果事件的独立标识；`event_id` 形如 `transfer_refund:<refund_result_id>`。 */
  refund_result_id?: string
  /** 来源诊断字段，**不用于业务判断**。 */
  source?: string
  // 以下字段只在转账状态查询（get_transfer_status）里出现
  can_refund?: boolean
  status_description?: string
  native_status_name?: string
  wx_error_type?: number | null
  [key: string]: unknown
}

/**
 * 插件 → 服务端：事件上报。服务端不需要回响应。
 *
 * `event_id` **可能整个字段缺失**（拼不出关键业务 ID 时会被省略），
 * 所以去重时必须准备兜底组合键。它是不透明的，**不要解析它**。
 */
export interface EventFrame extends WebridgeCommon {
  type: 'event'
  event_name: string
  event_id?: string
  captured_at_ms: number
  enqueued_at_ms?: number
  body: EventBody
}

/** 插件 → 服务端：命令执行结果。 */
export interface CommandResultFrame extends WebridgeCommon {
  type: 'command_result'
  request_id: string
  command_name: string
  ok: boolean
  /** 命令**执行**耗时，不含网络往返。 */
  duration_ms?: number
  /** 恒为对象；无内容时是 `{}`。失败时也可能带诊断信息。 */
  result?: Record<string, unknown>
  /** 失败原因；成功时是**空串**，不是缺失。 */
  error?: string
}

/** 插件 → 服务端：应用层心跳响应（我们不发 `ping`，但解析时要认这个 type）。 */
export interface PongFrame {
  type: 'pong'
  ts_ms: number
}

/** 服务端 → 插件：握手确认。 */
export interface HelloAckFrame {
  type: 'hello_ack'
  server_version?: string
}

/** 服务端 → 插件：命令下发。 */
export interface CommandFrame {
  type: 'command'
  request_id: string
  command_name: string
  args: Record<string, unknown>
}

/** 从网线上收到的任意帧。 */
export type InboundFrame =
  | HelloFrame
  | EventFrame
  | CommandResultFrame
  | PongFrame
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// 命令返回里的数据结构（协议文档 14.4 「查询结果结构」）
// ---------------------------------------------------------------------------

/**
 * 联系人摘要 —— `friends` / `friends_all` / `groups_all` / `room_members`
 * 的数组元素**共用同一套结构**。
 *
 * 恒有字段按文档标注；`is_owner` / `is_admin` / `is_self` **取不到时会被整个省略**，
 * 不是给 `false`（文档明确写了），所以是可选的。
 */
export interface ContactSummary {
  /** wxid；群聊场景下就是群 ID。 */
  account_id: string
  /** 展示名：优先备注名，其次昵称。 */
  display_name: string
  /** 备注名；无则空串。 */
  remark: string
  /** 微信号；未设置则空串。 */
  alias: string
  /** 微信昵称。 */
  nick_name: string
  /** 群成员快照中的群昵称；空串表示未设置。 */
  room_nick_name?: string
  /** 头像地址；取不到则空串。 */
  avatar_url: string
  /** `0` 未知 / `1` 男 / `2` 女。 */
  sex: number
  province: string
  city: string
  signature: string
  /** 好友添加时间，Unix 秒；未知为 null。仅 friends/friends_all 提供。 */
  add_time?: number | null
  /** 北京时间格式的添加时间；未知为 null。 */
  add_time_text?: string | null
  is_starred?: boolean
  is_blacklisted?: boolean
  /** 好友查询只读取缓存，不触发支付姓名查询。 */
  pay_name_last_char?: string
  pay_name_status?: 'not_queried' | 'querying' | 'ok' | 'unavailable' | 'failed'
  /** 是否在本地通讯录找到。 */
  contact_found: boolean
  /** 仅群成员场景。 */
  is_owner?: boolean
  /** 仅群成员场景。 */
  is_admin?: boolean
  /** 仅群成员场景。 */
  is_self?: boolean
  [key: string]: unknown
}

/** `groups_all` 的返回。无分页字段，一次给全。 */
export interface GroupsAllResult {
  keyword: string
  total: number
  items: ContactSummary[]
}

/**
 * `friends_all` 的返回。
 *
 * `items` 只含过滤后的普通好友；`total`、`friend_count` 与数组长度一致。
 * 其余分类仅提供计数，不混入好友数组（2026-10-23 作者文档）。
 */
export interface FriendsAllResult {
  keyword: string
  total: number
  friend_count: number
  official_account_count: number
  work_account_count: number
  system_account_count: number
  chatroom_count: number
  stranger_count: number
  cached_contact_count: number
  items: ContactSummary[]
}

/** `friends` 的返回。这个才带分页。 */
export interface FriendsResult {
  keyword: string
  limit: number
  offset: number
  total: number
  has_more: boolean
  items: ContactSummary[]
}

/** `room_members` 的返回。 */
export interface RoomMembersResult {
  room_id: string
  room_name: string
  room_remark: string
  current_user: string
  owner_user_name: string
  admin_count: number
  admin_user_names: string[]
  admin_members: ContactSummary[]
  self_is_owner: boolean
  self_is_admin: boolean
  member_count: number
  members: ContactSummary[]
}

/** `get_group_notice` 的返回。读的是**本机缓存**，不触发下载。 */
export interface GroupNoticeResult {
  room_id: string
  /** 本地没读到公告项时为 `false` —— 这**不能**证明群里没有公告。 */
  cached_notice_found: boolean
  summary: string | null
  html: string | null
  html_cached: boolean
}

/** `account_status` 的返回。 */
export interface AccountStatusResult {
  is_logged_in: boolean
  account_id: string
  user_name: string
  display_name: string
  remark: string
  alias: string
  nick_name: string
  avatar_url: string
  sex: number
  province: string
  city: string
  signature: string
  mobile: string
  country: string
  email: string
  has_profile_data: boolean
  wechat_version: string
}

/** `device_status` 的返回。 */
export interface DeviceStatusResult {
  ok: boolean
  ts_ms: number
  version: string
  build_marker: string
  /** 0.8.79 起才有。机型是 `iPhone14,3` 这类标识符，插件**不做商名映射**。 */
  device?: { ios_version: string; device_model: string }
  process_memory?: Record<string, number>
  system_memory?: Record<string, number>
  battery?: { percent: number; state: string }
  power?: Record<string, unknown>
  thermal?: Record<string, unknown>
  application?: Record<string, unknown>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// 命令返回里的业务结果结构（协议 v8.0.80）
// ---------------------------------------------------------------------------

/**
 * `receive_transfer` / `refund_transfer` / `get_transfer_status` 的业务 `result`。
 *
 * `status` 与 `can_refund` 的语义见 WS 文档 14.6：`status` 是规范化业务状态
 * （`waiting_receive` / `received` / `refunded` / `expired` / `unknown` /
 * `refund_pending` / `refund_unknown` / `failed`）；`can_refund=true` 只表示
 * 服务器状态待收取、双方匹配且无同笔未决操作，**不包含有效发送状态**，也不保证
 * 后续风控允许退还。只有 `status='refunded'` 且 `native_status=2002` 才代表已退还。
 *
 * 字段全部可选：通道鉴权、插件禁用等更早的拒绝可能只返回通用错误外壳，
 * 此时不能假定业务字段齐全；失败同样要读这些字段。
 */
export interface TransferResult {
  /** 本笔转账与消息编号；未能解析时可能为空字符串。 */
  transfer_id?: string
  message_id?: string
  /** 已进入现有业务流程的状态标记；不能代替 `confirmed` 判断到账／退还。 */
  accepted?: boolean
  /** 是否已确认收款成功；查询／退还语境下表示是否取得原生终态。 */
  confirmed?: boolean
  status?: string
  /** 微信原生资金状态；未取得为 null，未知数值保留原值。 */
  native_status?: number | null
  /** 微信回包错误码；未取得为 null。 */
  ret_code?: number | null
  /** 业务错误码；成功时为空字符串，不省略。 */
  error_code?: string
  /** 错误说明；成功时为空字符串。 */
  error?: string
  // 仅查询（get_transfer_status）可能返回
  can_refund?: boolean
  status_description?: string
  /** 微信回包原生状态名称，可能为空。 */
  native_status_name?: string
  wx_error_type?: number | null
  [key: string]: unknown
}

/**
 * 命令信封的 `ok`／`error` 与业务 `result` 合并后的转账结果。
 *
 * 合并方式：`{ ...(frame.result ?? {}), ok: frame.ok, error: frame.error ?? '' }`；
 * 文档保证 `result` 内不再重复 `ok`／`error`，实现仍让信封的同名字段覆盖 result。
 */
export type TransferOutcome = TransferResult & { ok: boolean; error: string }

/**
 * 逐成员操作结果（协议 v8.0.80 第 16 节 `member_results` 的元素）。
 *
 * `native_status=0` **不能**独立判断加入成功，必须与总返回码一起解释。
 */
export interface GroupMemberOperationResult {
  /** 成员内部 ID（wxid 形态）。 */
  member_id?: string
  /** 逐成员状态：`added` / `already_in_room` / `requires_invitation` / `requires_verification` / `approval_pending` / `failed` / `unknown`。 */
  status?: string
  native_status?: number | null
  [key: string]: unknown
}

/**
 * `create_group` / `add_group_member` / `invite_group_member` 的业务 `result`。
 *
 * 字段取自 WS 文档第 16 节「返回字段与成功判断」，除命令信封的 `ok`／`error`
 * 之外的全部业务字段（最终结果类型见 `GroupOperationOutcome`）。服务内初始失败
 * 可能尚未解析到成员或群 ID，前置拒绝的 `result` 也可能为空，所以字段全部可选，
 * 调用方不得假定成员或提交状态字段存在。
 *
 * `status` 取值与 `ok`：`created` / `added` / `invitation_sent` / `already_in_room` 为 true；
 * `requires_invitation` / `requires_verification` / `approval_pending` / `partial` /
 * `processing` / `failed` / `unknown` 为 false。
 */
export interface GroupOperationResult {
  status?: string
  /** `create`／`add`／`invite`。 */
  mode?: string
  /** 本次规范化后的业务请求 ID，须保存用于查询和重试去重。 */
  request_id?: string
  /** 添加／邀请的目标群；创建成功后为微信实际返回的新群 ID。 */
  room_id?: string
  member_ids?: string[]
  member_count?: number
  /** 筛选出的本次原生目标成员；是否实际提交还须看 `request_submitted`。 */
  submitted_member_ids?: string[]
  /** 提交前本机快照已确认在群的成员。 */
  already_in_room_member_ids?: string[]
  /** 微信原生方法的布尔返回值，不代表发出、成功或成员已入群。 */
  accepted?: boolean
  /** 已取得本次原生事件 ID；不代表微信服务端接受。 */
  request_submitted?: boolean
  /** 已收到与本请求匹配的原生回包；内容仍可能不完整。 */
  response_received?: boolean
  /** 本动作已由微信服务端确认成功；拒绝、需邀请、待审批或全部原已在群时为 false。 */
  server_confirmed?: boolean
  /** 本次原生请求类型：创建 119、添加 120、邀请 610；尚未提交时可能为 null。 */
  request_cgi?: number | null
  /** 本次原生事件编号，仅用于诊断；不是事件拉取编号或单独查询入口。 */
  event_id?: number | null
  /** 微信业务返回码；不能把缺失值按 0 处理。 */
  wechat_ret?: number | null
  wechat_error_message?: string
  message_type?: number | null
  transport_error_type?: number | null
  transport_error_code?: number | null
  /** 是否确认本次创建了群；只对 `create_group` 为 true。 */
  created?: boolean
  /** 是否确认所有目标均已加入或已在群；发出邀请不会因此变成 true。 */
  all_members_added?: boolean
  member_results?: GroupMemberOperationResult[]
  /** 完整回包确认可进一步发送邀请的成员；由调用方显式发起新邀请操作。 */
  invite_required_member_ids?: string[]
  /** 为 true 时表示读取了同 ID 的已登记操作，没有重新提交原生请求。 */
  replayed?: boolean
  /** 成功后的补充说明。 */
  message?: string
  error_code?: string
  [key: string]: unknown
}

/**
 * 命令信封的 `ok`／`error` 与业务 `result` 合并后的群操作结果。
 *
 * 合并方式：`{ ...(frame.result ?? {}), ok: frame.ok, error: frame.error ?? '' }`；
 * 文档保证 `result` 内不再重复 `ok`／`error`，实现仍让信封的同名字段覆盖 result。
 */
export type GroupOperationOutcome = GroupOperationResult & { ok: boolean; error: string }
