/**
 * 入站媒体托管。
 *
 * 关闭时的 data: 路径由 tests/media.spec.ts 覆盖。这里只验证打开后的
 * http(s) 地址、路径令牌、TTL、容量，以及转发出站时命令里拿到的就是这个地址。
 *
 * CI 能跑通本地 server 上的 GET（和手机下载同一处理函数）。真实手机是否能访问
 * 公网或局域网地址取决于部署，这里不启动手机。
 *
 * 直接跑：`npx tsx tests/relay.spec.ts`
 */

import assert from 'node:assert/strict'
import { App, h } from '@koishijs/core'
import server from '@koishijs/plugin-server'
import Logger from 'reggol'
import { WebSocket } from 'ws'
import { createHash } from 'node:crypto'
import { encode } from 'silk-wasm'
import * as webridge from '../src/index.js'
import { MAX_MEDIA_URL_LENGTH } from '../src/message.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
let port = 16231

assert.equal(webridge.WebridgeBot.defaults.inboundMediaRelay, false)
assert.equal(webridge.WebridgeBot.defaults.inboundMediaRelayTtl, 300_000)
assert.equal(webridge.WebridgeBot.defaults.inboundMediaRelayMaxItems, 32)
assert.equal(webridge.WebridgeBot.defaults.inboundMediaRelayMaxBytes, 64 * 1024 * 1024)

interface Env {
  app: App
  origin: string
  secret: string
  fork: { dispose(): boolean | Promise<void> }
  bot: any
  logs: string[]
  send: (type: string, id: string, channel?: string, fields?: object) => void
  upload: (url: string, bytes?: Buffer, options?: { field?: string; messageId?: string; fields?: Record<string, string> }) => Promise<Response>
  reply: (cmd: any, result?: object, ok?: boolean) => void
  next: <T>(queue: T[]) => Promise<T>
  sessions: any[]
  commands: any[]
  uploads: Map<string, any>
  socket: WebSocket
}

async function withBot(selfId: string, options: Record<string, unknown>, run: (env: Env) => Promise<void>) {
  const current = port++
  const origin = `http://127.0.0.1:${current}`
  const secret = `${selfId}-secret`
  const address = `${origin.replace('http:', 'ws:')}/webridge/${secret}`
  const app = new App()
  const logs: string[] = []
  const target = {
    colors: 0,
    levels: { base: 3 },
    record(record: { content: string }) { logs.push(record.content) },
  }
  Logger.targets.push(target)
  const serverFork = app.plugin(server, { host: '127.0.0.1', port: current })
  const fork = app.plugin(webridge, {
    address,
    selfId,
    inboundMediaTimeout: 1000,
    ...options,
  })
  const sessions: any[] = []
  const commands: any[] = []
  const uploads = new Map<string, any>()
  app.on('message', session => { sessions.push(session) })
  let socket!: WebSocket
  const reply = (cmd: any, result: object = { uploaded: true, asset_id: String(cmd.args?.upload_url ?? '').split('/').pop() }, ok = true) => {
    socket.send(JSON.stringify({
      type: 'command_result', request_id: cmd.request_id, command_name: cmd.command_name, ok, result,
    }))
  }
  async function next<T>(queue: T[]): Promise<T> {
    const end = Date.now() + 4000
    while (!queue.length && Date.now() < end) await sleep(10)
    assert.ok(queue.length, '等待事件或命令超时')
    return queue.shift()!
  }
  async function connect() {
    socket = new WebSocket(address)
    await withTimeout(new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) }), 3000, '连接')
    const ack = new Promise<void>(resolve => socket.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame.type === 'hello_ack') resolve()
      else if (frame.command_name === 'account_status') reply(frame, { nick_name: '托管测试' })
      else if (frame.command_name === 'room_members') reply(frame, { room_id: frame.args.room_id, members: [] })
      else {
        commands.push(frame)
        if (frame.args?.upload_url) uploads.set(frame.args.upload_url, frame)
      }
    }))
    socket.send(JSON.stringify({
      type: 'hello', device_id: `${selfId}-device`, session_id: `${selfId}-session`,
      account_id: 'wxid_bot', capabilities: ['upload_message_media'], state: { is_logged_in: true },
    }))
    await withTimeout(ack, 3000, 'hello_ack')
  }
  function send(type: string, id: string, channel = 'wxid_user', fields: object = {}) {
    socket.send(JSON.stringify({
      type: 'event', event_name: 'message', event_id: `event-${id}`, account_id: 'wxid_bot',
      body: {
        message_id: id, sender_id: channel, chat_id: channel, is_group: false, msg_type: type,
        create_time: Date.now() / 1000, content: type === 'text' ? id : '', ...fields,
      },
    }))
  }
  async function upload(url: string, bytes = png, options: { field?: string; messageId?: string; fields?: Record<string, string> } = {}) {
    const form = new FormData()
    form.append(options.field ?? 'file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), 'image_upload.bin')
    const command = uploads.get(url)
    if (command) {
      const fields = {
        message_id: options.messageId ?? command.args.message_id,
        command_request_id: command.request_id,
        media_type: command.args.media_type,
        account_id: 'wxid_bot',
        file_size: String(bytes.length),
        md5: createHash('md5').update(bytes).digest('hex'),
        file_name: 'media.bin',
        ...options.fields,
      }
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
    }
    return fetch(url, { method: 'POST', body: form })
  }
  try {
    await app.start()
    await connect()
    await run({
      app, origin, secret, fork, bot: app.bots[0], logs, send, upload, reply, next, sessions, commands, uploads, socket,
    })
  } finally {
    socket?.close()
    await fork.dispose()
    await serverFork.dispose()
    await app.stop()
    const index = Logger.targets.indexOf(target)
    if (index >= 0) Logger.targets.splice(index, 1)
  }
}

function tokenOf(url: string): string {
  return new URL(url).pathname.split('/').pop() ?? ''
}

function assertNoSecret(env: Env, src: string) {
  const token = tokenOf(src)
  assert.match(token, /^[a-f0-9]{48}$/)
  assert.ok(src.length <= MAX_MEDIA_URL_LENGTH)
  assert.match(src, /^https?:\/\/\S+$/)
  assert.equal(new URL(src).search, '')
  assert.ok(!src.includes(env.secret), '托管地址不能带上 WebSocket 密钥')
  assert.ok(env.logs.every(line => !line.includes(token) && !line.includes(src) && !line.includes('base64,')), '日志不能出现令牌、托管地址或 data URL')
}

async function receive(env: Env, type: string, id: string, bytes: Buffer, fields: Record<string, unknown> = {}, uploadFields: Record<string, string> = {}) {
  env.send(type, id, 'wxid_user', fields)
  const command = await env.next(env.commands)
  assert.equal(command.command_name, 'upload_message_media')
  assert.equal((await env.upload(command.args.upload_url, bytes, { fields: uploadFields })).status, 200)
  env.reply(command)
  return env.next(env.sessions)
}

async function forward(env: Env, session: any, elementType: string, commandName: string, arg: string) {
  const element = session.elements.find((item: h) => item.type === elementType)
  const src = String(element.attrs.src)
  assert.equal(h.parse(session.content).find(item => item.type === elementType)?.attrs.src, src)
  assert.equal(session.webridge.media[0].src, src)
  const sending = env.bot.sendMessage(session.channelId, session.content)
  const outbound = await env.next(env.commands)
  assert.equal(outbound.command_name, commandName)
  assert.equal(outbound.args[arg], src, '出站命令必须原样使用托管地址')
  assert.equal(outbound.args.receiver, session.channelId)
  env.reply(outbound, {})
  await sending
  return src
}

await withBot('relay-off', { inboundMediaRelay: false }, async (env) => {
  const session = await receive(env, 'image', 'off', png)
  const src = session.elements.find((item: h) => item.type === 'img').attrs.src
  assert.equal(src, `data:image/png;base64,${png.toString('base64')}`)
  assert.ok(!env.logs.some(line => line.includes('入站媒体托管已开启')))
  assert.equal((await fetch(`${env.origin}/webridge/media/relay/not-a-token`)).status, 404)
  console.log('PASS 关闭托管时仍是 data: URL，且不注册可用的托管路由')
})

await withBot('relay-on', {
  inboundMediaRelay: true,
  inboundMediaRelayTtl: 60_000,
  inboundMediaRelayMaxItems: 8,
  inboundMediaRelayMaxBytes: 1024 * 1024,
}, async (env) => {
  assert.ok(env.logs.some(line => line.includes('入站媒体托管已开启')))
  const image = await receive(env, 'image', 'image-1', png)
  const src = await forward(env, image, 'img', 'send_image', 'image_path')
  assertNoSecret(env, src)
  const first = await fetch(src)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('content-type'), 'image/png')
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff')
  assert.match(first.headers.get('cache-control') ?? '', /no-store/)
  assert.match(first.headers.get('content-disposition') ?? '', /^inline/)
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png)
  const again = await fetch(src)
  assert.equal(again.status, 200, '有效期内允许多次下载，供插件预览和手机重试')
  await again.arrayBuffer()

  const token = tokenOf(src)
  const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
  const wrong = new URL(src)
  wrong.pathname = wrong.pathname.replace(/\/[a-f0-9]{48}$/, `/${flipped}`)
  const denied = await fetch(wrong)
  assert.equal(denied.status, 404)
  assert.ok(!(await denied.text()).includes(token))
  const queried = new URL(src)
  queried.pathname = queried.pathname.replace(/\/[a-f0-9]{48}$/, '/unknown')
  queried.search = `?token=${token}`
  assert.equal((await fetch(queried)).status, 404, '查询串不能代替路径令牌')
  assert.equal((await fetch(src, { method: 'POST', body: 'x' })).status, 404)
  assert.equal((await fetch(`${env.origin}/webridge/media/relay/${token}`)).status, 404)
  console.log('PASS 托管地址可转发、可重复下载，错误令牌与查询串不能读取')

  const file = await receive(env, 'app', 'file-1', Buffer.from('file content'), { msg_subtype: 'file' }, { file_name: 'C:\\temp\\report.txt' })
  const fileSrc = await forward(env, file, 'file', 'send_file_from_url', 'file_url')
  const downloaded = await fetch(fileSrc)
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream')
  const disposition = downloaded.headers.get('content-disposition') ?? ''
  assert.match(disposition, /attachment/)
  assert.match(disposition, /filename="report\.txt"/)
  assert.ok(!disposition.includes('temp') && !disposition.includes('\\') && !disposition.includes('C:'))
  assert.equal(await downloaded.text(), 'file content')
  assertNoSecret(env, fileSrc)

  const silk = Buffer.from((await encode(Buffer.alloc(4800), 24_000)).data)
  const voice = await receive(env, 'voice', 'voice-1', silk)
  const voiceSrc = await forward(env, voice, 'audio', 'send_voice', 'source')
  const wav = Buffer.from(await (await fetch(voiceSrc)).arrayBuffer())
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(voice.elements.find((item: h) => item.type === 'audio').attrs.title, 'voice.wav')
  assertNoSecret(env, voiceSrc)
  console.log('PASS 文件名已净化，语音托管的是解码后的 WAV')

  const siblingSecret = 'sibling-relay-secret'
  const siblingAddress = `${env.origin.replace('http:', 'ws:')}/webridge/${siblingSecret}`
  const sibling = env.app.plugin(webridge.WebridgeBot as any, {
    address: siblingAddress, selfId: 'sibling-relay', inboundMediaTimeout: 1000,
    inboundMediaRelay: true, inboundMediaRelayTtl: 60_000,
  })
  const other = new WebSocket(siblingAddress)
  const otherCommands: any[] = []
  try {
    await withTimeout(new Promise<void>((resolve, reject) => { other.once('open', resolve); other.once('error', reject) }), 3000, 'sibling 连接')
    const otherReply = (command: any, result: object = { uploaded: true, asset_id: String(command.args?.upload_url ?? '').split('/').pop() }) => {
      other.send(JSON.stringify({
        type: 'command_result', request_id: command.request_id, command_name: command.command_name, ok: true, result,
      }))
    }
    const otherAck = new Promise<void>(resolve => other.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame.type === 'hello_ack') resolve()
      else if (frame.command_name === 'account_status') otherReply(frame, { nick_name: '另一个' })
      else if (frame.command_name === 'room_members') otherReply(frame, { room_id: frame.args.room_id, members: [] })
      else {
        otherCommands.push(frame)
        if (frame.args?.upload_url) env.uploads.set(frame.args.upload_url, frame)
      }
    }))
    other.send(JSON.stringify({
      type: 'hello', device_id: 'sibling-device', session_id: 'sibling-session',
      account_id: 'wxid_other_bot', capabilities: ['upload_message_media'], state: { is_logged_in: true },
    }))
    await withTimeout(otherAck, 3000, 'sibling hello_ack')
    other.send(JSON.stringify({
      type: 'event', event_name: 'message', event_id: 'sibling-image', account_id: 'wxid_other_bot',
      body: { message_id: 'sibling-image', msg_type: 'image', chat_id: 'wxid_friend', sender_id: 'wxid_friend', create_time: Date.now() / 1000 },
    }))
    const otherUpload = await env.next(otherCommands)
    assert.equal((await env.upload(otherUpload.args.upload_url, png, { fields: { account_id: 'wxid_other_bot' } })).status, 200)
    otherReply(otherUpload)
    const siblingSession = await env.next(env.sessions)
    assert.equal(siblingSession.bot.selfId, 'sibling-relay')
    const siblingSrc = String(siblingSession.elements.find((item: h) => item.type === 'img').attrs.src)
    assert.ok(!siblingSrc.includes(siblingSecret))
    const crossed = new URL(siblingSrc)
    crossed.pathname = crossed.pathname.replace(/\/[a-f0-9]{48}$/, `/${token}`)
    assert.equal((await fetch(crossed)).status, 404, '其他账号的路由不能用本账号令牌取件')
    assert.equal((await fetch(src)).status, 200)
  } finally {
    other.close()
    await sibling.dispose()
  }
  console.log('PASS 多账号托管路由隔离')

  await env.fork.dispose()
  assert.equal((await fetch(src)).status, 404, '卸载后托管路由必须关闭')
  assert.ok(env.logs.every(line => !line.includes(token) && !line.includes(src)))
  console.log('PASS 卸载清理托管路由，日志没有令牌')
})

await withBot('relay-items', {
  inboundMediaRelay: true,
  inboundMediaRelayMaxItems: 1,
  inboundMediaRelayTtl: 60_000,
}, async (env) => {
  const first = await receive(env, 'image', 'keep', png)
  assert.match(String(first.elements.find((item: h) => item.type === 'img').attrs.src), /^http:\/\//)
  const second = await receive(env, 'image', 'drop', png)
  const src = String(second.elements.find((item: h) => item.type === 'img').attrs.src)
  assert.equal(src, `data:image/png;base64,${png.toString('base64')}`)
  assert.ok(env.logs.some(line => line.includes('reason=capacity')))
  assert.ok(env.logs.every(line => !line.includes('base64,')))
  console.log('PASS 达到条数上限时保留 data: URL，不挤掉尚未过期的条目')
})

const medium = Buffer.concat([png, Buffer.alloc(600 - png.length)])
await withBot('relay-bytes', {
  inboundMediaRelay: true,
  inboundMediaRelayMaxItems: 8,
  inboundMediaRelayMaxBytes: 1024,
  inboundMediaRelayTtl: 60_000,
}, async (env) => {
  const first = await receive(env, 'image', 'fits', medium)
  assert.match(String(first.elements.find((item: h) => item.type === 'img').attrs.src), /^http:\/\//)
  const second = await receive(env, 'image', 'overflow', medium)
  assert.equal(String(second.elements.find((item: h) => item.type === 'img').attrs.src).slice(0, 5), 'data:')
  assert.ok(env.logs.some(line => line.includes('reason=capacity')))
  assert.ok(!env.logs.some(line => line.includes('reason=too-large')))
  console.log('PASS 总字节放不下时回退 data: URL')
})

const oversized = Buffer.concat([png, Buffer.alloc(2048)])
await withBot('relay-large', {
  inboundMediaRelay: true,
  inboundMediaRelayMaxBytes: 1024,
  inboundMediaRelayTtl: 60_000,
}, async (env) => {
  assert.ok(oversized.length > 1024)
  const session = await receive(env, 'image', 'large', oversized)
  assert.equal(String(session.elements.find((item: h) => item.type === 'img').attrs.src).slice(0, 5), 'data:')
  assert.ok(env.logs.some(line => line.includes('reason=too-large')))
  assert.ok(env.logs.every(line => !line.includes('base64,')))
  console.log('PASS 单条超过托管上限时不保存字节')
})

await withBot('relay-ttl', {
  inboundMediaRelay: true,
  inboundMediaRelayTtl: 1000,
}, async (env) => {
  const session = await receive(env, 'image', 'expires', png)
  const src = String(session.elements.find((item: h) => item.type === 'img').attrs.src)
  const seen = Date.now()
  const fresh = await fetch(src)
  assert.equal(fresh.status, 200)
  assert.ok(Date.now() - seen < 1000)
  await fresh.arrayBuffer()
  await sleep(1100)
  const expired = await fetch(src)
  assert.equal(expired.status, 404)
  assert.ok(!(await expired.text()).includes(tokenOf(src)))
  assert.ok(env.logs.every(line => !line.includes(tokenOf(src))))
  console.log('PASS 超过有效期后返回 404，且不在日志中留下令牌')
})
