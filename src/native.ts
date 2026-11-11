import type { WebridgeBot } from './bot.js'
import type { MessageMediaKind } from './media-format.js'

type Page = { direction?: 'head' | 'tail'; cursor?: string }
type Post = { sns_id: string }
type Visibility = { visibility?: 'public' | 'private' | 'include' | 'exclude'; wxids?: string[] }
type PermissionTarget = { type: 'friend'; wxid: string } | { type: 'recent' } | ({ type: 'post' } & Post)
export type MessageMediaArgs = { message_id: string; media_type?: MessageMediaKind; timeout_seconds?: number }
export type CdnUploadArgs = ({ file_path: string; file_url?: never } | { file_url: string; file_path?: never }) & { timeout_seconds?: number }
export type MediaProbeArgs = { message_id: string; request_id?: never } | { request_id: string; message_id?: never }

/**
 * 群操作（创建群 / 直接加人 / 邀请）的命令等待上限（毫秒）。
 *
 * 协议 v8.0.80 第 16 节：服务端等待真实原生回包约 30 秒、外层等待保护约 31 秒，
 * 客户端建议至少等 40 秒；iOS 挂起、通信排队或断线可能更久，连接超时不能直接当业务失败。
 */
export const GROUP_OPERATION_TIMEOUT = 45_000

/**
 * 转账退还／状态查询的命令等待上限（毫秒）。
 *
 * 协议 v8.0.80 14.6：新操作在本次命令内短等待约 5 秒，客户端建议至少等 15 秒。
 */
export const TRANSFER_OPERATION_TIMEOUT = 20_000

/** 新版作者文档中的命令参数；ID 和游标保持字符串，避免 UInt64 精度丢失。 */
export interface WebridgeNativeArgs {
  download_message_media: MessageMediaArgs
  upload_message_media: MessageMediaArgs & { upload_url?: string }
  upload_file_to_wechat_cdn: CdnUploadArgs
  message_media_probe: MediaProbeArgs
  official_accounts: { type?: 'all' | 'subscription' | 'service'; keyword?: string; limit?: number; offset?: number }
  official_account_search: { keyword: string }
  official_account_follow: { id: string }
  official_account_unfollow: { id: string }
  official_account_articles: { id: string; limit?: number; cursor?: string }
  get_self_qrcode: Record<string, never>
  get_chatroom_qrcode: { room_id: string }
  group_admin_operate: { room_id: string; oper_type: 1 | 2 | 3; member_ids: string[] }
  /**
   * 群操作（协议 v8.0.80 第 16 节）。
   *
   * 成员与群 ID 必须去掉首尾空白、内部不能含空白；设备还会再去重、排序并自动排除本人。
   * 创建群的成员字段由设备做首版范围校验（至少 2 位其他好友），不接受群名 / 主题。
   *
   * ⚠️ 这三条命令的业务失败（如 requires_invitation / partial / unknown）也带结构化
   * `result`，通用 `call()` 走 `bot.query()` 时会把 ok=false 翻成异常并丢掉它；
   * 需要读取业务状态时优先用 `internal.createGroup` / `addGroupMember` / `inviteGroupMembers`，
   * 或自行从 `WebridgeCommandError.result` 取。
   */
  create_group: { member_ids: string[]; member_id?: string }
  add_group_member: { room_id: string; member_id?: string; member_ids?: string[]; reason?: string }
  /** 邀请入群；旧别名（user_name／wxid／user_names／wxids、chatroom_id／group_id／to_user_name）可合并，这里原样透出。 */
  invite_group_member: {
    room_id?: string
    chatroom_id?: string
    group_id?: string
    to_user_name?: string
    member_id?: string
    member_ids?: string[]
    user_name?: string
    wxid?: string
    user_names?: string[]
    wxids?: string[]
  }
  /** 退还待收取转账（协议 v8.0.80 14.6）：transfer_id 与 message_id 至少一项非空。 */
  refund_transfer: { transfer_id?: string; message_id?: string }
  /** 只查询转账资金状态，不执行收款或退还（协议 v8.0.80 14.6）。 */
  get_transfer_status: { transfer_id?: string; message_id?: string }
  set_group_msg_silence: { room_id: string; silence: boolean }
  set_friend_remark: { id: string; remark: string }
  set_friend_star: { id: string; starred: boolean }
  set_friend_blacklist: { id: string; blacklisted: boolean }
  friend_pay_name: { id: string; refresh?: boolean }
  search_contact: { keyword: string }
  add_friend: { contact_ref: string; say_content?: string }
  add_room_friend: { room_id: string; wxid: string; say_content?: string }
  friend_add_probe: { contact_ref?: string; room_id?: string; wxid?: string }
  get_group_invitation: { message_id: string }
  accept_group_invitation: { message_id: string }
  group_invitation_probe: { message_id: string; stage?: string }
  send_contact_card: { receiver: string; contact_id: string }
  send_location: { receiver: string; latitude: number; longitude: number; title?: string; address?: string }
  location_geocode_probe: { latitude: number; longitude: number }
  favorites_list: { limit?: number; refresh?: boolean; cursor?: string }
  favorites_send: { fav_id: string; receiver: string }
  favorites_delete: { fav_id: string }
  moments_list: Page
  moments_user: Page & { wxid: string; check_visibility?: boolean }
  moments_detail: Post
  moments_refresh: Page & ({ scope?: 'timeline' } | { scope: 'user'; wxid: string; check_visibility?: boolean })
  moments_like: Post
  moments_unlike: Post
  moments_comment: Post & { content: string; reply_comment_id?: string }
  moments_delete_comment: Post & { comment_id: string }
  moments_publish: Visibility & ({ type?: 'text'; content: string } | { type: 'images'; images: string[]; content?: string }
    | { type: 'video'; video: string; thumb?: string; content?: string })
  moments_delete: Post
  moments_permissions_query: PermissionTarget
  moments_permissions_update: ({ type: 'friend'; wxid: string; direction: 'hide_from' | 'dont_see'; enabled: boolean }
    | { type: 'recent'; period: 'three_days' | 'one_month' | 'half_year' | 'all' } | ({ type: 'post' } & Post & Visibility))
  moments_operation: { operation_id: string }
  moments_probe: { video?: string; thumb?: string }
  moments_media_download: Post & { media_id: string; upload?: {
    url: string; resource_id: string; method?: 'PUT' | 'POST'; headers?: Record<string, string>
  } }
}

export interface NativeCallOptions {
  /** 真实命令信封 ID；CDN 上传必须保存并复用。查询 moments_operation 每次使用新 ID。 */
  requestId?: string
  timeout?: number
}

/** 扩展能力只挂在 internal；不自动重试写操作，不把受理状态解释为业务完成。 */
export class WebridgeNativeApi {
  constructor(protected bot: WebridgeBot) {}

  call<K extends keyof WebridgeNativeArgs>(command: K, args: WebridgeNativeArgs[K], options: NativeCallOptions = {}): Promise<Record<string, unknown>> {
    if (command === 'upload_file_to_wechat_cdn' && !options.requestId) {
      throw new Error('CDN 上传必须显式提供 options.requestId；结果未知时用原 ID 查询或重试')
    }
    const media = ['download_message_media', 'upload_message_media', 'upload_file_to_wechat_cdn'].includes(command)
    const invitation = ['get_group_invitation', 'accept_group_invitation', 'group_invitation_probe'].includes(command)
    // 群操作在服务端后台等待真实回包约 30～31 秒，协议建议客户端至少等 40 秒。
    const group = ['create_group', 'add_group_member', 'invite_group_member'].includes(command)
    // 转账退还／查询在本次命令内短等待约 5 秒，协议建议客户端至少等 15 秒。
    const transfer = ['refund_transfer', 'get_transfer_status'].includes(command)
    const timeout = media ? 200_000 : invitation ? 75_000 : group ? GROUP_OPERATION_TIMEOUT : transfer ? TRANSFER_OPERATION_TIMEOUT
      : command.startsWith('favorites_') || command === 'friend_pay_name' ? 60_000 : 40_000
    return this.bot.query(command, args, options.timeout ?? timeout, options.requestId)
  }

  downloadMessageMedia(args: MessageMediaArgs, options?: NativeCallOptions) { return this.call('download_message_media', args, options) }
  uploadMessageMedia(args: MessageMediaArgs & { upload_url?: string }, options?: NativeCallOptions) { return this.call('upload_message_media', args, options) }
  probeMessageMedia(args: MediaProbeArgs, options?: NativeCallOptions) { return this.call('message_media_probe', args, options) }
  uploadFileToWechatCdn(args: CdnUploadArgs, options: NativeCallOptions & { requestId: string }) { return this.call('upload_file_to_wechat_cdn', args, options) }
}
