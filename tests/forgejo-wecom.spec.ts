import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgejoRequest, credentials } from '../src/sources/forgejo-api.ts'
import { wecomTrigger, WecomConfig } from '../src/sources/wecom.ts'
import { claimPull, observePull, pullEndNotices, type Pull } from '../src/sources/forgejo-pull.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { Ticket } from '../src/core/index.ts'
import { pullChecks } from '../src/sources/github-read.ts'
import { Commands } from '../src/infra/commands.ts'
import { asForgejo } from '../src/sources/forgejo.ts'
import { issueTrigger } from '../src/sources/github-trigger.ts'
import type { Deployment } from '../src/deployment.ts'

afterEach(() => vi.unstubAllGlobals())
describe('Forgejo boundaries', () => {
  it('preserves source identity and issue channel when adapting events', () => {
    const t = asForgejo(issueTrigger({ number: 5, title: 'Fix', body: '@bot fix typo', user: { login: 'alice' }, created_at: '2026-01-01T00:00:00Z', html_url: 'https://forge.example/a/b/issues/5' }, 'bot'))
    expect(t.source).toBe('forgejo'); expect(t.channel?.thread).toBe('forgejo:5'); expect(t.actor.source).toBe('forgejo'); expect(t.addressed).toBe('mention')
  })
  it('accepts Forgejo null statuses when no CI has run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-ci-')), file = join(dir, 'credentials.json')
    try {
      await writeFile(file, JSON.stringify({ url: 'https://forge.example', login: 'bot', token: 'x'.repeat(40) }), { mode: 0o600 })
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ statuses: null })))
      const commands = new Commands(() => ({ repository: 'a/b', forgejo: { credentialsFile: file } } as Deployment), {}, new AbortController().signal)
      expect(await pullChecks(commands, 'abc')).toEqual({ head: 'abc', checks: [], statuses: [] })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('translates pagination, stays repository scoped, and refuses unsafe credential permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-test-')), file = join(dir,'credentials.json')
    try {
      await writeFile(file, JSON.stringify({ url: 'https://forge.example:60443', login: 'bot', token: 'x'.repeat(40) }), { mode: 0o600 })
      const requests: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => { requests.push(url); return Response.json(requests.length === 1 ? Array.from({length:50}, (_,id)=>({id})) : [{id:50}]) }))
      const deployment = { repository: 'a/b', forgejo: { credentialsFile:file } } as Deployment
      const result = await forgejoRequest(deployment,'issues?per_page=100',['--paginate','--slurp']) as unknown[][]
      expect(result.map(x=>x.length)).toEqual([50,1]); expect(requests[0]).toContain('/api/v1/repos/a/b/issues?limit=50&page=1')
      await expect(forgejoRequest(deployment,'../user',[])).rejects.toThrow('restricted')
      await writeFile(join(dir,'public.json'), await (await import('node:fs/promises')).readFile(file), {mode:0o644})
      await expect(credentials(join(dir,'public.json'))).rejects.toThrow('0600')
    } finally { await rm(dir,{recursive:true,force:true}) }
  })
})
describe('WeCom delivered-message scope', () => {
  const config = WecomConfig.parse({credentialsFile:'/private/bot.json'})
  const message = {msgid:'message1',aibotid:'bot',chattype:'group',chatid:'project',from:{userid:'alice'},msgtype:'text',text:{content:'Please investigate'},create_time:1770000000}
  it('deduplicates by delivered message identity, not text or timestamp', () => {
    expect(wecomTrigger(message,'bot',config)?.id).toBe(wecomTrigger(message,'bot',config)?.id)
    expect(wecomTrigger({...message,msgid:'message2'},'bot',config)?.id).not.toBe(wecomTrigger(message,'bot',config)?.id)
  })
  it('does not invent history or collapse a whole group into a ticket thread', () => {
    const t = wecomTrigger(message,'bot',config)!
    expect(t.text).toBe('Please investigate'); expect(t.threads[0]?.id).not.toBe(wecomTrigger({...message,msgid:'message2'},'bot',config)?.threads[0]?.id)
    expect(t.addressed).toBe('mention')
  })
  it('rejects other bots, disabled DMs, and disallowed groups', () => {
    expect(wecomTrigger(message,'other',config)).toBeUndefined()
    expect(wecomTrigger(message,'bot',{...config,chats:['another']})).toBeUndefined()
    expect(wecomTrigger({...message,chattype:'single'},'bot',{...config,directMessages:false})).toBeUndefined()
  })
})

describe('Forgejo PR lifecycle', () => {
  it('binds only a ticket-owned PR and closes its Forgejo thread', async () => {
    const ticket = { id: 'ticket', origin: { triggerId: 'origin' }, execution: { name: 'work' }, follows: [] } as unknown as Ticket
    const pr = { number: 7, state: 'open', html_url: 'https://forge/a/b/pulls/7', user: { login: 'bot' }, head: { sha: 'abc', ref: 'agent/work', repo: { full_name: 'a/b' } } } as Pull
    const bindThread = vi.fn(), patch = vi.fn(), describe = vi.fn(), threadClosed = vi.fn()
    const ctx = { deployment: { repository: 'a/b', github: { login: 'bot' } },
      atomic: (f: () => unknown) => f(), triggers: { get: () => undefined },
      tickets: { get: () => ticket, open: () => [ticket], bindThread, threadClosed }, threads: { patch, describe },
    } as unknown as SourceContext
    expect(claimPull(ctx, ticket.id, { ...pr, user: { login: 'other' } })).toContain('does not belong')
    expect(bindThread).not.toHaveBeenCalled()
    expect(claimPull(ctx, ticket.id, pr)).toBeUndefined()
    expect(bindThread).toHaveBeenCalledWith('ticket', { source: 'forgejo', id: '7' }, true)
    expect(patch).toHaveBeenCalledWith('forgejo:7', expect.objectContaining({ isPr: true }))
    ticket.follows = [{ thread: 'forgejo:7', own: true }]
    await observePull(ctx, { ...pr, state: 'closed', merged: true, merged_at: '2026-11-12T00:00:00Z' })
    expect(threadClosed).toHaveBeenCalledWith({ source: 'forgejo', id: '7' }, 'merged', '2026-11-12T00:00:00Z')
    expect(describe).toHaveBeenCalledWith('forgejo:7', expect.anything())
  })
  it('sends terminal notices to IM using the configured Forgejo origin', () => {
    const ticket = { id: 'ticket', ended: { outcome: 'closed' }, follows: [{ thread: 'forgejo:7', own: true, closed: { at: '2026-11-12', outcome: 'closed' } }], channels: [{ source: 'wecom', address: { chat: 'project' } }, { source: 'forgejo', address: { number: '7' } }] } as unknown as Ticket
    const notices = pullEndNotices(ticket, '请修复', 'a/b', 'https://forge.example:60443')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toContain('https://forge.example:60443/a/b/pulls/7')
    expect(notices[0]?.channel.source).toBe('wecom')
  })
})
