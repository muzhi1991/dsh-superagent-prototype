/** WeCom consumes only delivered bot messages. No group-history or implicit conversation access. */
import type { Context } from '@deepseek-ai/cordis'
import { WSClient } from '@wecom/aibot-node-sdk'
import { readFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export const WecomConfig = z.object({ credentialsFile: z.string().refine(s => !s || s.startsWith('/')).default(''), directMessages: z.boolean().default(true), chats: z.array(z.string()).default([]) }).strict()
const Message = z.object({ msgid: z.string().min(1), aibotid: z.string().min(1), chattype: z.enum(['single','group']), chatid: z.string().optional(),
  from: z.object({ userid: z.string().min(1) }), create_time: z.number().optional(), msgtype: z.string(),
  text: z.object({ content: z.string() }).optional(), voice: z.object({ content: z.string() }).optional(),
  mixed: z.object({ msg_item: z.array(z.object({ msgtype: z.string(), text: z.object({ content: z.string() }).optional() })) }).optional(),
  quote: z.object({ text: z.object({ content: z.string() }).optional() }).optional() })
export function wecomTrigger(input: unknown, botId: string, config: z.infer<typeof WecomConfig>): Trigger | undefined {
  const m = Message.parse(input)
  if (m.aibotid !== botId || m.from.userid === botId) return
  const direct = m.chattype === 'single', chat = direct ? m.from.userid : m.chatid
  if (!chat || (direct ? !config.directMessages : config.chats.length > 0 && !config.chats.includes(chat))) return
  const text = m.text?.content ?? m.voice?.content ?? m.mixed?.msg_item.flatMap(item => item.text?.content ?? []).join('\n') ?? ''
  if (!text.trim()) return // Non-text media is explicitly unsupported in the first version.
  const id = key('wecom', botId, m.msgid), thread = `${chat}:${m.msgid}`
  return { id, source: 'wecom', threads: [{ source: 'wecom', id: thread }], actor: { source: 'wecom', id: m.from.userid }, human: true,
    addressed: direct ? 'direct' : 'mention', at: new Date(m.create_time ? m.create_time * 1000 : Date.now()).toISOString(),
    text: text + (m.quote?.text?.content ? `\n\n[Quoted text supplied in this message; not independently retrieved history]\n${m.quote.text.content}` : ''),
    channel: { source: 'wecom', thread: `wecom:${thread}`, address: { chat, direct: String(direct) } },
    meta: { direct, chat, messageId: m.msgid } }
}
export function wecomKind(send: NonNullable<SourceKind['channel']>['send']): SourceKind<z.infer<typeof WecomConfig>> {
  return {
    kind: 'wecom', title: { zh: '企业微信', en: 'WeCom' }, description: { zh: '只接收机器人实际收到的私聊和群内 @ 消息；不读取群聊历史。', en: 'Only bot-delivered direct messages and group mentions; no group history.' },
    schema: WecomConfig, health: ['wecom'], fields: [
      { key: 'credentialsFile', type: 'text', label: { zh: '私有机器人凭据文件', en: 'Private bot credentials file' } },
      { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Receive direct messages' } },
    ],
    scope: ({ meta }, config) => (meta.direct === true ? config.directMessages : !config.chats.length || config.chats.includes(String(meta.chat))) ? { listened: true, observed: false, row: meta.direct === true ? 'direct' : 'group' } : { listened: false, reason: 'chat_not_allowed' },
    policy: { schema: z.object({ allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]) }),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '可交办任务的成员', en: 'Allowed senders' }, columns: [{ key: 'id', type: 'text', label: { zh: '成员标识', en: 'Member identity' } }, { key: 'name', type: 'text', optional: true, label: { zh: '姓名', en: 'Name' } }] }],
      explicit: { zh: '白名单成员发给机器人的消息交给 Router 判断，不保证创建任务。', en: 'Messages from allowed people are routed, not automatically accepted.' },
      rows: () => ['direct','group'].map(id => ({ id, label: id, note: { zh: '仅实际收到的消息', en: 'Delivered messages only' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
    },
    channel: { send, allowed: (address, config) => address.direct === 'true' ? config.directMessages : !config.chats.length || config.chats.includes(address.chat ?? ''),
      link: () => ({ url: '', label: { zh: '企业微信', en: 'WeCom' } }) },
    threadContext: { messageId: t => t.id, read: async (_commands, trigger) => {
      const messages = [{ id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text }]
      return { messages, body: { messages, limitation: 'Only this delivered message is available. No surrounding group history.' } }
    } },
  }
}
export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  let client: WSClient | undefined, source: SourceContext
  const kind = wecomKind(async (_host, message) => {
    if (source.state.get(KV.wecom.sent(message.id))) return 'sent'
    if (!client?.isConnected) throw new Error('WeCom is disconnected')
    if (Buffer.byteLength(message.text, 'utf8') > 20480) throw new Error('WeCom reply exceeds 20480 bytes')
    await client.sendMessage(message.channel.address.chat!, { msgtype: 'markdown', markdown: { content: message.text } })
    source.state.set(KV.wecom.sent(message.id), true)
    return 'sent'
  })
  ctx.effect(() => ctx.orchestrator.sources.register(kind))
  source = sourceContext(ctx.orchestrator, kind)
  ctx.effect(() => {
    const controller = new AbortController(); let current = '', chain = Promise.resolve()
    const run = async () => {
      await source.ready
      while (!controller.signal.aborted) {
        const config = source.config<z.infer<typeof WecomConfig>>('wecom')
        const signature = config ? JSON.stringify(config) : ''
        if (signature !== current) {
          client?.disconnect(); client = undefined; current = ''
          if (config?.credentialsFile) {
            try {
              if ((await stat(config.credentialsFile)).mode & 0o077) throw new Error('WeCom credentials must have mode 0600')
              const account = z.object({ botId: z.string(), secret: z.string() }).parse(JSON.parse(await readFile(config.credentialsFile, 'utf8')))
              client = new WSClient({ ...account, maxReconnectAttempts: -1, logger: { debug() {}, info() {}, warn() {}, error() {} } })
              client.on('authenticated', () => source.report('wecom', { state: 'ready', detail: 'Connected; only bot-delivered messages are visible' }))
              client.on('error', () => source.report('wecom', { state: 'error', detail: 'WeCom connection error; reconnecting' }))
              client.on('disconnected', () => source.report('wecom', { state: 'error', detail: 'WeCom disconnected' }))
              for (const event of ['message.text', 'message.voice', 'message.mixed'] as const) client.on(event, frame => {
                chain = chain.then(async () => {
                  const latest = source.config<z.infer<typeof WecomConfig>>('wecom')
                  if (controller.signal.aborted || !latest) return
                  const trigger = wecomTrigger(frame.body, account.botId, latest)
                  if (trigger) await source.receive(trigger)
                }).catch(() => source.report('wecom', { state: 'error', detail: 'A delivered message could not be recorded' }))
              })
              client.connect(); current = signature
            } catch { source.report('wecom', { state: 'error', detail: 'Cannot initialize WeCom; check private credentials file' }) }
          } else source.report('wecom', { state: 'paused', detail: 'Disabled' })
        }
        await delay(3000, undefined, { signal: controller.signal }).catch(() => {})
      }
    }
    const running = run()
    return async () => { controller.abort(); client?.disconnect(); await running; await chain }
  })
}
