/**
 * Webridge 的**内部接口**（挂到 `bot.internal`）。
 *
 * 为什么不直接把这些方法加在 Bot 类上 —— 官方指引（`guide/adapter/bot` 的
 * 「为什么不能直接在 Bot 类上添加方法？」）给了两条理由：
 *
 * 1. 插件拿到的是通用 `Bot` 类型，它无法确定背后是哪个适配器，想用原生能力本来
 *    就要做类型断言；
 * 2. **通用接口将来可能扩展出同名方法**（比如 satori 哪天加了 `getGuildNotice`），
 *    直接挂在 Bot 上就会撞名，而且是升级 Koishi 时才炸。
 *
 * 所以这里的划分是：
 *
 * - **satori `Methods` 里有的**（`getGuild*` / `getFriendList` / `getUser` /
 *   `kickGuildMember` / `deleteFriend` / `deleteMessage` / `getLogin`）留在 Bot 上，
 *   插件不必知道 WeBridge 的存在就能调用；
 * - **协议有、但 satori 没有对应概念的**（改群名、退群、读群公告、设备状态……）
 *   放在这里，走 `bot.internal.xxx()`。
 *
 * 和官方例子一样，`internal` 里的方法不直接下发命令，而是复用 `bot` 上的
 * `sendCommand` / `query` —— 那才是"怎么跟设备说话"的机制层。
 */

import { GROUP_OPERATION_TIMEOUT, TRANSFER_OPERATION_TIMEOUT, WebridgeNativeApi } from './native.js'
import {
  CMD_ACCEPT_FRIEND_REQUEST,
  CMD_ACCOUNT_STATUS,
  CMD_ADD_GROUP_MEMBER,
  CMD_BRIDGE_STATUS,
  CMD_CLEAR_GENDER_REGION,
  CMD_CREATE_GROUP,
  CMD_DELETE_SESSION,
  CMD_DEVICE_STATUS,
  CMD_FORWARD_MESSAGE,
  CMD_GET_GROUP_NOTICE,
  CMD_GET_TRANSFER_STATUS,
  CMD_INVITE_GROUP_MEMBER,
  CMD_PROFILE_GENDER,
  CMD_PROFILE_NICKNAME,
  CMD_PROFILE_PAT_SUFFIX,
  CMD_PROFILE_REGION,
  CMD_PROFILE_REGION_CODES,
  CMD_PROFILE_SIGNATURE,
  CMD_PROFILE_UPDATE,
  CMD_QUIT_GROUP,
  CMD_RECEIVE_RED_PACKET,
  CMD_RECEIVE_TRANSFER,
  CMD_RED_PACKET_DETAIL,
  CMD_REFUND_TRANSFER,
  CMD_RENAME_GROUP,
  CMD_SEND_FILE,
  CMD_SEND_IMAGE,
  CMD_SEND_LINK_CARD,
  CMD_SEND_LIVEPHOTO,
  CMD_SEND_MUSIC_CARD,
  CMD_SEND_PAT,
  CMD_SEND_SIGNAL,
  CMD_SEND_VIDEO,
  CMD_SEND_XML,
  CMD_SET_GROUP_NAME,
} from './protocol.js'
import type { InboundMediaContent } from './media.js'
import type {
  AccountStatusResult,
  CommandResultFrame,
  DeviceStatusResult,
  GroupNoticeResult,
  GroupOperationOutcome,
  RoomMembersResult,
  TransferOutcome,
} from './types.js'

export class WebridgeInternal extends WebridgeNativeApi {

  // ------------------------------------------------------------------
  // 业务结果合并（协议 v8.0.80：失败也要保留 result）
  // ------------------------------------------------------------------

  /**
   * 下发命令，并把**命令信封**的 `ok`／`error` 合并进业务 `result`。
   *
   * 为什么新接口不用 `bot.query()`：它会把 `ok=false` 直接翻成异常，失败时
   * `result` 里的业务状态（`confirmed`、`status`、`member_results`、
   * `invite_required_member_ids` 等）就丢了。群操作与转账的失败本身带业务语义，
   * 调用方必须能读到。
   *
   * 合并顺序按「信封优先」：`result` 里的同名字段不覆盖外层 `ok`／`error`。
   * 协议 v8.0.80 保证 `result` 内不再重复这两个字段，这里仍以信封为准。
   */
  private async outcome<T extends Record<string, unknown>>(
    command: string,
    args: Record<string, unknown>,
    timeout: number,
    requestId?: string,
  ): Promise<T & { ok: boolean; error: string }> {
    const frame: CommandResultFrame = await this.bot.sendCommand(command, args, timeout, requestId)
    const result = frame.result && typeof frame.result === 'object' && !Array.isArray(frame.result) ? frame.result : {}
    return { ...result, ok: frame.ok, error: frame.error ?? '' } as T & { ok: boolean; error: string }
  }

  /** 完整目录快照，保留通用 Guild/GuildMember 无法表达的微信字段。 */
  async getGroupSnapshot(guildId: string, force = false): Promise<RoomMembersResult> {
    if (!guildId.endsWith('@chatroom')) throw new Error('需要有效的群 ID')
    return this.bot.directory.snapshot(guildId, force)
  }

  /**
   * 改**整个群聊的名称**（协议命令 `set_group_name`，0.8.79 新增）。
   *
   * ⚠️ 与 `setGuildSelfNickname` 严格区分：那个改的是「我在本群的昵称」。
   * 参数先在本地按协议校验，让调用方立刻看出是自己传的值不对，
   * 而不是等设备回一句 `error`。
   */
  async setGuildName(guildId: string, name: string): Promise<void> {
    const roomId = String(guildId ?? '').trim()
    if (!roomId.endsWith('@chatroom')) {
      throw new Error(`set_group_name 要求群 ID 以 @chatroom 结尾，收到 ${JSON.stringify(guildId)}`)
    }
    // 协议明确：群名不接受空串（能传空串清空的是「我在本群的昵称」）。
    const newName = String(name ?? '').trim()
    if (!newName) throw new Error('群名称不能为空')
    await this.bot.query<Record<string, unknown>>(CMD_SET_GROUP_NAME, { room_id: roomId, new_name: newName })
  }

  /**
   * 改**我在本群的群昵称**（协议命令 `rename_group`）。
   *
   * 传空串表示清空昵称 —— 这是协议允许的，与群名不同，所以不做非空校验。
   */
  async setGuildSelfNickname(guildId: string, name = ''): Promise<void> {
    await this.bot.query<Record<string, unknown>>(CMD_RENAME_GROUP, { room_id: guildId, new_name: String(name ?? '') })
  }

  /** 退出群聊（协议命令 `quit_group`）。参数名是 `id`，和设备其他命令不一致。 */
  async leaveGuild(guildId: string): Promise<void> {
    await this.bot.query<Record<string, unknown>>(CMD_QUIT_GROUP, { id: guildId })
  }

  // ------------------------------------------------------------------
  // 群操作（协议 v8.0.80 第 16 节）
  // ------------------------------------------------------------------

  /**
   * 规范化群成员 ID 列表：接受单个字符串或数组，逐项 trim，
   * 拒绝非字符串、空串和内部含空白的值，按首次出现顺序去重。
   *
   * 为什么本地还要校验：协议要求成员 ID 去掉首尾空白、内部不能含空白，
   * 设备对不合规参数只会回一个业务失败，在本地挡住能让调用方立刻看出是参数问题。
   * 设备侧仍会再去重、按 ID 排序并自动排除本人；创建群时「至少 2 位其他好友」
   * 是本接口首版的支持范围，由设备校验，这里不猜人数下限。
   */
  private groupMemberIds(values: string | string[]): string[] {
    const list = Array.isArray(values) ? values : [values]
    const result: string[] = []
    for (const raw of list) {
      if (typeof raw !== 'string') {
        throw new Error(`群成员 ID 必须是字符串，收到 ${JSON.stringify(raw)}`)
      }
      const id = raw.trim()
      if (!id) throw new Error('群成员 ID 不能为空字符串')
      if (/\s/.test(id)) throw new Error(`群成员 ID 内部不能含空白：${JSON.stringify(raw)}`)
      if (!result.includes(id)) result.push(id)
    }
    if (!result.length) throw new Error('至少需要一个群成员 ID')
    return result
  }

  /** 校验群 ID：去掉首尾空白后非空，且内部不含空白（协议第 16 节的参数要求）。 */
  private roomIdArg(roomId: string): string {
    const id = String(roomId ?? '').trim()
    if (!id) throw new Error(`群 ID 不能为空，收到 ${JSON.stringify(roomId)}`)
    if (/\s/.test(id)) throw new Error(`群 ID 内部不能含空白：${JSON.stringify(roomId)}`)
    return id
  }

  /**
   * 创建普通群聊（协议命令 `create_group`，协议 v8.0.80 第 16 节）。
   *
   * 返回值是**合并后的业务结果**，业务失败不抛错：只有 `ok=true` 且
   * `status='created'` 才确认建成群；部分成员失败时**不要再次建群**，
   * 应读取 `member_results` 与 `invite_required_member_ids` 分别处理。
   * 成员去重、排序、排除本人以及「至少 2 位其他好友」的校验都由设备完成。
   *
   * `options.requestId` 是**命令信封**的 request_id（协议要求必填，不传则随机生成）。
   * 同 ID 只用于查询／重放原业务；**换 ID 不等于安全重试**。结果未知
   * （`processing` / `unknown`）时用相同参数、相同 ID 读取迟到结果，
   * 必要时再核实真实群状态。
   */
  async createGroup(memberIds: string | string[], options: { requestId?: string } = {}): Promise<GroupOperationOutcome> {
    const members = this.groupMemberIds(memberIds)
    return this.outcome<GroupOperationOutcome>(
      CMD_CREATE_GROUP,
      { member_ids: members },
      GROUP_OPERATION_TIMEOUT,
      options?.requestId,
    )
  }

  /**
   * 尝试**直接添加**群成员（协议命令 `add_group_member`，协议 v8.0.80 第 16 节）。
   *
   * 是否可直接加入由微信服务端和群设置决定，插件**不会**把添加失败自动转成发送邀请；
   * `ok=true` 只表示目标均已加入或本来就在群。各状态的处理：
   * - `requires_invitation`：只对 `invite_required_member_ids` 里的成员显式调用
   *   `inviteGroupMembers`，并使用新的业务 ID，不要换 ID 重发本命令；
   * - `requires_verification` / `approval_pending`：先补好友关系或等群主／管理员确认；
   * - `partial`：逐人看 `member_results`，含 `unknown` 时保留同群占用，不自动重发整批；
   * - `processing` / `unknown`：用相同参数、相同 ID 读取迟到结果，不自动重发。
   *
   * `options.requestId` 传入命令信封；同 ID 只用于查询／重放，换 ID 不等于安全重试。
   */
  async addGroupMember(
    roomId: string,
    memberIds: string | string[],
    options: { reason?: string; requestId?: string } = {},
  ): Promise<GroupOperationOutcome> {
    const room = this.roomIdArg(roomId)
    const members = this.groupMemberIds(memberIds)
    // 协议允许 `member_id` / `member_ids` 二选一，这里统一传数组形态。
    const args: Record<string, unknown> = { room_id: room, member_ids: members }
    // `reason` 选填（入群申请说明），没传就不下发。
    if (options?.reason) args.reason = String(options.reason)
    return this.outcome<GroupOperationOutcome>(
      CMD_ADD_GROUP_MEMBER,
      args,
      GROUP_OPERATION_TIMEOUT,
      options?.requestId,
    )
  }

  /**
   * 发送入群邀请（协议命令 `invite_group_member`，协议 v8.0.80 第 16 节）。
   *
   * `ok=true` / `status='invitation_sent'` 仅确认本批邀请**已发出**，
   * 对方接受后才入群；`already_in_room` 表示目标本来全在群，没有新请求。
   * `processing` / `unknown` 时用相同参数、相同 ID 读取迟到结果，
   * 换 request_id 不等于安全重试。
   */
  async inviteGroupMembers(
    roomId: string,
    memberIds: string | string[],
    options: { requestId?: string } = {},
  ): Promise<GroupOperationOutcome> {
    const room = this.roomIdArg(roomId)
    const members = this.groupMemberIds(memberIds)
    return this.outcome<GroupOperationOutcome>(
      CMD_INVITE_GROUP_MEMBER,
      { room_id: room, member_ids: members },
      GROUP_OPERATION_TIMEOUT,
      options?.requestId,
    )
  }

  /**
   * 邀请某人入群（保留旧签名，内部委托 `inviteGroupMembers`）。
   *
   * 返回类型放宽为 `GroupOperationOutcome`：邀请成功只代表发送成功，
   * 必须看业务 `status`，不能据此认为对方已入群。
   */
  async inviteGuildMember(guildId: string, userId: string): Promise<GroupOperationOutcome> {
    return this.inviteGroupMembers(guildId, userId)
  }

  /**
   * 读**本机缓存**的群公告（协议命令 `get_group_notice`，0.8.79 新增）。
   *
   * ⚠️ 原样透传协议结构，不做「有没有公告」的判断：缓存可能不存在或已过期，
   * `cached_notice_found` 为 `false` **不能**证明群里没有公告。
   */
  async getGuildNotice(guildId: string): Promise<GroupNoticeResult> {
    return this.bot.query<GroupNoticeResult>(CMD_GET_GROUP_NOTICE, { room_id: guildId })
  }

  // 注：`mark_session_read`（把会话标记为已读）已在协议 v8.0.80 移除，
  // 下发只会得到 `unsupported command_name`，且没有替代入口，因此不再提供。

  /**
   * 手机端 WeBridge 设置里要填的完整 WebSocket 地址。
   *
   * 与启动日志里打印的是同一个值；`address` 改了之后也会跟着变。
   * 用户拿这个地址去手机里粘贴，不用自己拼主机 / 端口 / 路径 / secret。
   */
  getCallbackUrl(): string {
    return this.bot.callbackUrl()
  }

  /**
   * 当前登录账号的资料（协议命令 `account_status`）。
   *
   * 握手帧里**没有**昵称字段，所以「机器人叫什么」只能问这条。
   * `bot.getLogin()` 内部用的也是它。
   */
  async getAccountStatus(): Promise<AccountStatusResult> {
    return this.bot.query<AccountStatusResult>(CMD_ACCOUNT_STATUS)
  }

  /**
   * 设备运行状态（电量、内存、前后台等）。
   * `device.ios_version` / `device.device_model` 是 0.8.79 起才有的字段。
   */
  async getDeviceStatus(): Promise<DeviceStatusResult> {
    return this.bot.query<DeviceStatusResult>(CMD_DEVICE_STATUS)
  }

  /**
   * 插件的完整诊断快照。
   * 协议明确说「字段随内部状态变化，不要依赖其中任何字段做业务判断」，
   * 所以只做类型上的透传，不解读内容。
   */
  async getBridgeStatus(): Promise<Record<string, unknown>> {
    return this.bot.query<Record<string, unknown>>(CMD_BRIDGE_STATUS)
  }

  // ------------------------------------------------------------------
  // 好友申请（协议 14.2 / 15.7）
  // ------------------------------------------------------------------

  /**
   * 同意好友申请。
   *
   * 协议 15.7 明确要求：**同意前先校验 `encrypt_username` 和 `ticket` 是否都存在**，
   * 缺失时不要盲调。这里在本地就挡住，让调用方立刻看出是自己参数不对，
   * 而不是等设备回一个看不懂的失败。
   */
  async acceptFriendRequest(args: {
    encryptUsername: string
    ticket: string
    requestId?: string
    scene?: number
    sayContent?: string
  }): Promise<Record<string, unknown>> {
    const encryptUsername = String(args?.encryptUsername ?? '').trim()
    const ticket = String(args?.ticket ?? '').trim()
    if (!encryptUsername || !ticket) {
      throw new Error('accept_friend_request 需要 encrypt_username 与 ticket（协议 15.7）')
    }
    const payload: Record<string, unknown> = {
      encrypt_username: encryptUsername,
      ticket,
    }
    // 注意：这里的 request_id 是**好友申请的业务 ID**，不是命令信封那个 request_id
    // （协议 14.2 专门警告过这个重名陷阱）
    if (args.requestId) payload.request_id = String(args.requestId)
    if (args.scene !== undefined) payload.scene = args.scene
    if (args.sayContent) payload.say_content = String(args.sayContent)
    return this.bot.query(CMD_ACCEPT_FRIEND_REQUEST, payload)
  }

  // ------------------------------------------------------------------
  // 红包与转账（协议 v8.0.80 14.6 / 15.4 / 15.5）
  // ------------------------------------------------------------------

  /** 领取红包。`red_packet_id` 就是事件里的同名字段，也是去重键。 */
  async receiveRedPacket(redPacketId: string): Promise<Record<string, unknown>> {
    const id = String(redPacketId ?? '').trim()
    if (!id) throw new Error('receive_red_packet 需要 red_packet_id')
    return this.bot.query(CMD_RECEIVE_RED_PACKET, { red_packet_id: id })
  }

  /** 查红包详情。 */
  async getRedPacketDetail(redPacketId: string): Promise<Record<string, unknown>> {
    const id = String(redPacketId ?? '').trim()
    if (!id) throw new Error('red_packet_detail 需要 red_packet_id')
    return this.bot.query(CMD_RED_PACKET_DETAIL, { red_packet_id: id })
  }

  /**
   * 校验单个转账编号：允许省略；给了就必须是非空字符串（去首尾空白后非空）。
   *
   * 协议 v8.0.80 14.6 明确「不得传数字、null、数组或对象」，所以非字符串一律拒绝。
   */
  private transferIdArg(name: 'transfer_id' | 'message_id', value?: string): string {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') throw new Error(`${name} 必须是字符串，收到 ${JSON.stringify(value)}`)
    // 协议 v8.0.80 14.6 的原文是「去除首尾空白后两个字段都为空时失败」：
    // 单个字段传空串等价于没提供，是否合法由 transferArgs() 汇总判断。
    return value.trim()
  }

  /**
   * 规范化转账定位参数：`transfer_id` / `message_id` 都可省略，但至少一项非空。
   *
   * 协议 v8.0.80 14.6：两个字段都按字符串原样保存、去掉首尾空白；可以省略未提供的字段；
   * 两个都给时必须指向同一笔转账，否则设备返回 `ID_MISMATCH`（本地无法校验，交给设备）。
   * 返回对象只包含**非空**字段，不让空串混进 args。
   */
  private transferArgs(transferId?: string, messageId?: string): Record<string, unknown> {
    const transfer = this.transferIdArg('transfer_id', transferId)
    const message = this.transferIdArg('message_id', messageId)
    if (!transfer && !message) {
      throw new Error('转账操作需要 transfer_id 或 message_id（至少一项非空）')
    }
    const args: Record<string, unknown> = {}
    if (transfer) args.transfer_id = transfer
    if (message) args.message_id = message
    return args
  }

  /**
   * 确认收款（协议命令 `receive_transfer`，协议 v8.0.80 14.6）。
   *
   * ⚠️ 成功判据**只有 `confirmed === true`** 一条（对应 `status='callback_ok'`，
   * 或独立查询取得原生状态 2001）：
   * - `status='confirm_invoked'` 表示「已发起收款、短等待超时」，此时 `confirmed=false`，
   *   **不能认定到账**，也不能当失败；`accepted` 只表示进入业务流程，
   *   `callback_received` 只是辅助信号；
   * - 结果未知（`callback_unknown`、等待超时、`confirm_invoked`）时，先调用
   *   `getTransferStatus` 查询资金状态（原生状态 2001 才确认已收取），
   *   **不要直接重试**，也不要换 request_id 重发。
   *
   * 本方法不因业务失败抛错：返回信封 `ok`／`error` 与 `result` 合并后的结果，
   * 失败时同样带 `status` / `confirmed` / `ret_code` 等诊断字段。
   */
  async receiveTransfer(transferId?: string, messageId?: string): Promise<TransferOutcome> {
    return this.outcome<TransferOutcome>(
      CMD_RECEIVE_TRANSFER,
      this.transferArgs(transferId, messageId),
      TRANSFER_OPERATION_TIMEOUT,
    )
  }

  /**
   * 退还待收取转账（协议命令 `refund_transfer`，协议 v8.0.80 14.6）。
   *
   * **只有 `status === 'refunded'` 且 `native_status === 2002` 才是已退还。**
   * `ok=true`、`accepted=true`、命令传输成功都不能单独当退还成功判据。
   * `refund_pending` 表示已提交但还没拿到终态（继续查询）、`refund_unknown` 表示
   * 提交后异常或回包无法验证（不能直接认定失败）；这两者都**不能重提退还**，
   * 必须先 `getTransferStatus` 查到终态。同一笔转账的收款与退还互斥，
   * 未决操作会返回 `TRANSFER_BUSY`；退还被微信明确拒绝才解除本次提交的占用。
   */
  async refundTransfer(transferId?: string, messageId?: string): Promise<TransferOutcome> {
    return this.outcome<TransferOutcome>(
      CMD_REFUND_TRANSFER,
      this.transferArgs(transferId, messageId),
      TRANSFER_OPERATION_TIMEOUT,
    )
  }

  /**
   * 只查询转账资金状态（协议命令 `get_transfer_status`，协议 v8.0.80 14.6）。
   *
   * 只读：不收款、不退还，也不受「有效发送状态」限制（仍需通道鉴权、插件启用等前置条件）。
   * 判据：`status='received'` 且 `native_status=2001` 表示已收取；
   * `status='refunded'` 且 `native_status=2002` 表示已退还；`can_refund=true` 只表示
   * 服务器状态是待收取、双方匹配且无同笔未决操作，**不包含有效发送状态**，
   * 也不保证后续风控允许退还。每次查询使用新的外层 request_id。
   */
  async getTransferStatus(transferId?: string, messageId?: string): Promise<TransferOutcome> {
    return this.outcome<TransferOutcome>(
      CMD_GET_TRANSFER_STATUS,
      this.transferArgs(transferId, messageId),
      TRANSFER_OPERATION_TIMEOUT,
    )
  }

  // ------------------------------------------------------------------
  // 会话管理（协议 14.2）
  // ------------------------------------------------------------------

  /** 删除会话。`id` 是会话 ID（群 ID 或 wxid）。 */
  async deleteSession(id: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_DELETE_SESSION, { id: String(id ?? '') })
  }

  // ------------------------------------------------------------------
  // 其他发送入口（satori 里没有对应元素类型，走 internal）
  // ------------------------------------------------------------------

  /**
   * 发送拍一拍（协议 14.2：`receiver` 必需，群聊要给 `room_id`）。
   *
   * ⚠️ satori 的元素模型里没有「拍一拍」，所以只能走这里。
   */
  async sendPat(receiver: string, roomId?: string): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_pat 需要 receiver')
    const args: Record<string, unknown> = { receiver: target }
    if (roomId) args.room_id = String(roomId)
    return this.bot.query(CMD_SEND_PAT, args)
  }

  /** 发送小信号（协议 14.2：只有 `receiver`）。 */
  async sendSignal(receiver: string): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_signal 需要 receiver')
    return this.bot.query(CMD_SEND_SIGNAL, { receiver: target })
  }

  /**
   * 发送原始 appmsg XML（协议 14.2：`receiver` / `xml` / `type`，可选 `forward`）。
   *
   * 适用于平台原生卡片等高级用法；返回受理结果不等于微信端展示成功。
   */
  async sendXml(
    receiver: string,
    xml: string,
    type: number,
    forward = false,
  ): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_xml 需要 receiver')
    if (!String(xml ?? '').trim()) throw new Error('send_xml 需要 xml')
    if (!Number.isFinite(Number(type))) throw new Error('send_xml 需要数字 type')
    return this.bot.query(CMD_SEND_XML, {
      receiver: target,
      xml: String(xml),
      type: Number(type),
      forward: Boolean(forward),
    })
  }

  /** 转发消息（协议 14.2：`receiver` + `message_id`）。 */
  async forwardMessage(receiver: string, messageId: string): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    const message = String(messageId ?? '').trim()
    if (!target || !message) throw new Error('forward_message 需要 receiver 与 message_id')
    return this.bot.query(CMD_FORWARD_MESSAGE, { receiver: target, message_id: message })
  }

  /**
   * 发送链接卡片（协议 14.2：`receiver` / `title` / `url` 必需）。
   *
   * satori 的元素模型里没有「链接卡片」，硬造自定义段名对调用方不友好，
   * 所以放在 internal 上。真机未验收。
   */
  async sendLinkCard(
    receiver: string,
    card: { title: string; url: string; description?: string; thumbUrl?: string },
  ): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_link_card 需要 receiver')
    if (!String(card?.title ?? '').trim() || !String(card?.url ?? '').trim()) {
      throw new Error('send_link_card 需要 title 与 url')
    }
    const args: Record<string, unknown> = { receiver: target, title: card.title, url: card.url }
    if (card.description) args.description = card.description
    if (card.thumbUrl) args.thumb_url = card.thumbUrl
    return this.bot.query(CMD_SEND_LINK_CARD, args)
  }

  /**
   * 发送音乐卡片（协议 14.2：`receiver` / `title` 必需）。
   *
   * 协议里 URL 相关字段有好几个（`url` / `data_url` / `song_album_url`），
   * 这里原样透出，不做猜测性映射。真机未验收。
   */
  async sendMusicCard(
    receiver: string,
    card: {
      title: string
      desc?: string
      url?: string
      dataUrl?: string
      songAlbumUrl?: string
      songLyric?: string
      appId?: string
      appName?: string
    },
  ): Promise<Record<string, unknown>> {
    const target = String(receiver ?? '').trim()
    if (!target) throw new Error('send_music_card 需要 receiver')
    if (!String(card?.title ?? '').trim()) throw new Error('send_music_card 需要 title')
    const args: Record<string, unknown> = { receiver: target, title: card.title }
    if (card.desc) args.desc = card.desc
    if (card.url) args.url = card.url
    if (card.dataUrl) args.data_url = card.dataUrl
    if (card.songAlbumUrl) args.song_album_url = card.songAlbumUrl
    if (card.songLyric) args.song_lyric = card.songLyric
    if (card.appId) args.app_id = card.appId
    if (card.appName) args.app_name = card.appName
    return this.bot.query(CMD_SEND_MUSIC_CARD, args)
  }

  /**
   * 按**设备本地路径**发图片（协议 14.2：`receiver` + `image_path`）。
   *
   * ⚠️ 路径必须是**手机上的**路径，Koishi 侧拿不到。日常发图请用
   * `h('img', { src })` —— 适配器会走 `send_image` 的 URL 入口。
   * 这个方法只服务于「知道设备上确实有那个文件」的场景。
   */
  async sendImageByPath(receiver: string, imagePath: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_SEND_IMAGE, {
      receiver: String(receiver ?? ''),
      image_path: String(imagePath ?? ''),
    })
  }

  /** 按**设备本地路径**发视频（协议 14.2：`receiver` + `source`）。 */
  async sendVideoByPath(receiver: string, source: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_SEND_VIDEO, { receiver: String(receiver ?? ''), source: String(source ?? '') })
  }

  /** 按**设备本地路径**发文件（协议 14.2：`receiver` + `file_path`）。 */
  async sendFileByPath(receiver: string, filePath: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_SEND_FILE, {
      receiver: String(receiver ?? ''),
      file_path: String(filePath ?? ''),
    })
  }

  /**
   * 发实况照片（协议 14.2：`receiver` + `video_path`，可选 `image_path` 等）。
   *
   * ⚠️ 设备上必须是**实况照片**。作者口径里其余参数都是可选的；
   * 带 `image_path` 的那版曾出现「设备全绿、微信端红色感叹号」，
   * 所以这里默认**只传必需参数**，额外字段由调用方显式给。
   */
  async sendLivePhoto(
    receiver: string,
    videoPath: string,
    options: { imagePath?: string; stillImageTimeMs?: number; preferredHevc?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {
      receiver: String(receiver ?? ''),
      video_path: String(videoPath ?? ''),
    }
    if (options.imagePath) args.image_path = options.imagePath
    if (options.stillImageTimeMs !== undefined) args.still_image_time_ms = options.stillImageTimeMs
    if (options.preferredHevc !== undefined) args.prefered_hevc = options.preferredHevc
    return this.bot.query(CMD_SEND_LIVEPHOTO, args)
  }

  // ------------------------------------------------------------------
  // 资料管理（协议 14.2）
  // ------------------------------------------------------------------

  /** 改账号昵称（`profile_nickname`）。 */
  async setProfileNickname(nickname: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_NICKNAME, { nickname: String(nickname ?? '') })
  }

  /** 设置或清空性别（`profile_gender`）：0 未知 / 1 男 / 2 女。 */
  async setProfileGender(sex: number): Promise<Record<string, unknown>> {
    const value = Number(sex)
    if (![0, 1, 2].includes(value)) throw new Error('profile_gender 的 sex 只能是 0 / 1 / 2')
    return this.bot.query(CMD_PROFILE_GENDER, { sex: value })
  }

  /** 设置或清空地区（`profile_region`）：`region_code` 与 `region` 二选一。 */
  async setProfileRegion(value: { regionCode?: string; region?: string }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {}
    if (value?.regionCode !== undefined) args.region_code = value.regionCode
    else if (value?.region) args.region = value.region
    else throw new Error('profile_region 需要 region_code 或 region')
    return this.bot.query(CMD_PROFILE_REGION, args)
  }

  /** 设置或清空签名（`profile_signature`）：空串表示清空。 */
  async setProfileSignature(signature: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_SIGNATURE, { signature: String(signature ?? '') })
  }

  /** 设置或清空拍一拍后缀（`profile_pat_suffix`）：空串表示清空。 */
  async setProfilePatSuffix(suffix: string): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_PAT_SUFFIX, { pat_suffix: String(suffix ?? '') })
  }

  /**
   * 批量设置性别 / 地区 / 签名（`profile_update`）：**至少给一项**。
   */
  async updateProfile(patch: {
    sex?: number
    regionCode?: string
    region?: string
    signature?: string
  }): Promise<Record<string, unknown>> {
    const args: Record<string, unknown> = {}
    if (patch?.sex !== undefined) args.sex = Number(patch.sex)
    if (patch?.regionCode !== undefined) args.region_code = patch.regionCode
    if (patch?.region !== undefined) args.region = patch.region
    if (patch?.signature !== undefined) args.signature = patch.signature
    if (!Object.keys(args).length) {
      throw new Error('profile_update 至少要给 sex / region_code / region / signature 之一')
    }
    return this.bot.query(CMD_PROFILE_UPDATE, args)
  }

  /** 清除性别与地区（`clear_gender_region`），无参数。 */
  async clearGenderRegion(): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_CLEAR_GENDER_REGION)
  }

  /**
   * 查询地区代码（`profile_region_codes`，只读）。
   *
   * 省略 `parentCode` 或传空串查国家。⚠️ 协议提醒：不要拼中文名称，
   * `name` 随微信语言变化；叶节点或不存在的父代码可能返回空列表。
   */
  async getRegionCodes(parentCode = ''): Promise<Record<string, unknown>> {
    return this.bot.query(CMD_PROFILE_REGION_CODES, parentCode ? { parent_code: parentCode } : {})
  }
}

/**
 * `session.webridge` 的类型：**帧里的原始字段 + `bot.internal` 的方法**。
 *
 * 两者的关系来自 satori 的实现（`@satorijs/core/src/session.ts` 的 `setInternal`）：
 *
 * ```js
 * setInternal(type, data) {
 *   this.event._type = type
 *   this.event._data = data
 *   const internal = Object.create(this.bot.internal)   // ← 原型指向 bot.internal
 *   defineProperty(this, type, Object.assign(internal, data))
 * }
 * ```
 *
 * 也就是说 `session.webridge` 的原型是 `bot.internal`，实例自己的属性是那一帧的
 * `body` —— 所以「原始字段」和「internal 的方法」在同一个对象上都能取到，
 * 类型上也必须交叉起来写，只写一半就会漏。
 *
 * 用索引签名是因为帧字段随设备版本变化（协议自己都说「不要依赖其中任何字段」），
 * 逐个列出既列不全、也会在设备升级后失准。
 */
export type WebridgeSessionInternal = WebridgeInternal & Record<string, any> & { media?: InboundMediaContent[] }

