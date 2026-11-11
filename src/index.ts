/**
 * Koishi 插件入口。
 *
 * ⚠️ **不要 `export default`**：loader 的 `unwrapExports` 会优先取 `default`，
 * 一旦导出 default，下面的 `name` / `Config` / `inject` 就全部失效了。
 */

// 从 `@satorijs/core` 导入而不是 `koishi`：`koishi` 这个 meta 包在 ESM 下会经由
// `@koishijs/loader` 的具名入口，那条路径目前是坏的（`lib/index.mjs` 默认导入 CJS 的
// `shared.js`，拿到的是命名空间对象而不是类，一 import 就 `Class extends value #<Object>`
// 崩掉）。只要用到 `Schema` / `Context` 的地方都从 `@satorijs/core` 拿，就完全绕开了它。
import { type Context, Schema, type Session } from '@satorijs/core'
import { WebridgeBot } from './bot.js'
import type { WebridgeEventPayload } from './protocol.js'
import type { WebridgeSessionInternal } from './internal.js'

export * from './adapter.js'
export * from './bot.js'
export * from './internal.js'
export * from './types.js'
export * from './native.js'
export * from './error.js'
export { WebridgeDirectory } from './directory.js'
export { ArchiveService } from './archive/index.js'
export type { MessageMediaKind } from './media-format.js'
export type { InboundMediaContent } from './media.js'

export const name = 'adapter-webridge'
export const reusable = true

/** 需要 Koishi 的 server 服务来挂 WebSocket 路由。缺了它插件不会加载。 */
export const inject = ['server']

export interface Config extends WebridgeBot.Config {}

/**
 * 插件配置的 Schema。
 *
 * schema 本体定义在 `WebridgeBot.Config` 上（静态属性 —— Koishi 取插件配置读的正是
 * `Plugin.Config`），这里再以顶层 `Config` 导出一次：两处指同一个对象，
 * loader / 控制台 / 用户 import 都能取到。
 */
export const Config: Schema<Config> = WebridgeBot.Config as Schema<Config>

export function apply(ctx: Context, config: WebridgeBot.Config): void {
  ctx.plugin(WebridgeBot, config)
}

/**
 * 把 `session.webridge` 加进 satori 的 `Session` 类型。
 *
 * Bot 在造会话时调了 `session.setInternal('webridge', {...})`（见 `bot.ts` 的 `onEvent`），
 * satori 会把这一帧的字段挂成会话上的一个属性 —— 但那是运行时的行为，类型系统不知道。
 * 官方指南（`guide/adapter/bot` 的「设置内部接口」一节）给的例子正是在适配器入口里
 * 声明模块增强来补上这个缺口，所以这里照做。
 *
 * 这段声明编译进 `lib/index.d.ts` 之后，**装了本插件的用户**也能在编辑器里直接
 * 拿到 `session.webridge.msg_type` 的补全和类型检查，不必自己断言。
 */
declare module '@satorijs/core' {
  interface Session {
    /** 当前事件帧的原始字段 + `bot.internal` 的方法，详见 `WebridgeSessionInternal`。 */
    webridge: WebridgeSessionInternal
  }

  /**
   * 自定义事件。
   *
   * satori 的标准事件里没有红包 / 转账 / 系统消息的对应结构，而协议 v8.0.80 23.1
   * 明明定义了它们。硬塞进 `message-created` 之类的标准事件会让监听方拿到
   * 一个形状对不上的 Session，所以另开一组事件、原样透传协议字段。
   *
   * `webridge/unknown-event` 是兜底：协议**没有承诺**事件清单是闭合的，
   * 插件版本比我们新时会出现清单外的 `event_name`，走这里而不是被丢掉。
   */
  interface Events {
    /** 归档专用：经过连接内去重，早于自发消息、时效和媒体过滤。 */
    'webridge/archive-event'(session: Session): void
    /** 收红包（协议 15.4）。去重用 `body.red_packet_id`。 */
    'webridge/red-packet'(payload: WebridgeEventPayload): void
    /** 收转账（协议 15.5）。去重用 `body.transfer_id`，金额用 `body.amount_fen`。 */
    'webridge/transfer'(payload: WebridgeEventPayload): void
    /**
     * 转账退还结果（协议 v8.0.80 23.5 转账退还结果事件）。
     *
     * ⚠️ 去重必须用**完整 `event_id`**（形如 `transfer_refund:<refund_result_id>`），
     * **不能按 `transfer_id` 去重** —— 同一笔转账的查询结果与后续结果各有独立的
     * `refund_result_id`，按 transfer_id 去重会把后面的结果吞掉。
     *
     * ⚠️ 事件名**不代表退还成功**：只有 `body.status === 'refunded'` 且
     * `body.native_status === 2002` 才确认已退还，`refund_pending` / `refund_unknown`
     * 等都不是成功终态。退还提交后也可能不产生事件，**未收到事件也要主动查询**
     * （`internal.getTransferStatus()`），不能只等这一条事件。
     */
    'webridge/transfer-refund-result'(payload: WebridgeEventPayload): void
    /** 好友申请（协议 15.7）。同意前必须校验 `encrypt_username` 与 `ticket`。 */
    'webridge/friend-request'(payload: WebridgeEventPayload): void
    /** 系统消息（`msg_type === 'system'`）：撤回、群名修改等。 */
    'webridge/system-message'(payload: WebridgeEventPayload): void
    /**
     * 认不出内容的 `message` 事件（`msg_type` 是 `unknown` 或协议十种之外）。
     *
     * 它仍然是消息，只是类型不认识 —— 与 `webridge/unknown-event`（事件名不认识）分开，
     * 归档方可以按「要不要当作聊天记录」自己决定。
     */
    'webridge/unknown-message'(payload: WebridgeEventPayload): void
    /** 协议清单之外的未知事件，原样透传。 */
    'webridge/unknown-event'(payload: WebridgeEventPayload): void
    /** 朋友圈操作结果；按 operation_id 和 revision 关联最终结果。 */
    'webridge/moments-result'(payload: WebridgeEventPayload): void
  }
}
