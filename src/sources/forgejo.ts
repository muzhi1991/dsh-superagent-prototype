/** Forgejo source; domain authorization and assignment lifecycle remain in the original engine. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { CliError } from '../infra/commands.ts'
import { ForgejoConfig } from './forgejo-api.ts'
import { githubKind } from './github.ts'
import { githubThreadContext, pullChecks, ciSummary } from './github-read.ts'
import { ciTrigger, commentTrigger, issueTrigger, CommentSchema, IssueSchema } from './github-trigger.ts'
import { observePull, readPull } from './forgejo-pull.ts'
import { sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'

export function asForgejo(t: Trigger): Trigger {
  return { ...t, id: key('forgejo', t.id), source: 'forgejo', actor: { ...t.actor, source: 'forgejo' },
    threads: t.threads.map(x => ({ ...x, source: 'forgejo' })),
    ...t.channel ? { channel: { ...t.channel, source: 'forgejo', thread: t.channel.thread?.replace(/^github:/, 'forgejo:') } } : {} }
}
export const forgejoKind: SourceKind<z.infer<typeof ForgejoConfig>> = {
  kind: 'forgejo', title: { zh: 'Forgejo', en: 'Forgejo' }, description: { zh: '自建仓库的 Issue、PR、讨论与提交状态。', en: 'Self-hosted repository issues, pull requests, conversations and commit status.' },
  schema: ForgejoConfig, health: ['forgejo'],
  fields: [
    { key: 'repository', type: 'text', label: { zh: '仓库 owner/name', en: 'Repository owner/name' } },
    { key: 'credentialsFile', type: 'text', label: { zh: '私有凭据文件路径', en: 'Private credentials file path' } },
    { key: 'cli', type: 'text', label: { zh: '机器人专用 tea 命令', en: 'Isolated agent tea CLI' } },
    { key: 'pollSeconds', type: 'number', min: 10, max: 3600, label: { zh: '轮询间隔（秒）', en: 'Poll interval (seconds)' } },
    ...['observeIssues', 'observeComments', 'observeCi'].map(key => ({ key, type: 'switch' as const, label: { zh: key === 'observeIssues' ? '观察新 Issue / PR' : key === 'observeComments' ? '观察评论' : '观察默认分支 CI', en: key } })),
  ],
  scope: ({ meta }, c) => ({ listened: true, observed: meta.ci === true ? c.observeCi : ['issue','pull'].includes(String(meta.kind)) ? c.observeIssues : c.observeComments, row: 'repository' }),
  policy: { ...githubKind.policy!,
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) })).default([]), bots: z.array(z.object({ id: z.string() })).optional() }),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '可交办任务的 Forgejo 账号', en: 'Allowed Forgejo accounts' }, columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } }] }],
    rows: () => [{ id: 'repository', label: 'Forgejo', note: { zh: 'Issue / PR', en: 'Issue / PR' }, cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } }] },
  threadContext: githubThreadContext,
  find: query => ({ threads: /^#?\d+$/.test(query) ? [`forgejo:${query.replace('#','')}`] : [], terms: [query] }),
  channel: {
    link: address => ({ url: address.url ?? '', label: { zh: `Forgejo #${address.number}`, en: `Forgejo #${address.number}` } }),
    async send({ commands }, message) {
      const n = Number(message.channel.address.number)
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid Forgejo issue number')
      const marker = `<!-- dsh-superagent:${message.id} -->`
      const comments = await commands.pages(CommentSchema, `issues/${n}/comments`)
      if (!comments.some(c => c.user.login === commands.deployment.forgejo!.login && c.body?.includes(marker))) {
        await commands.api(z.unknown(), `issues/${n}/comments`, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
      }
      return 'sent'
    },
  },
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_FORGEJO_REPOSITORY', description: { zh: 'Forgejo 仓库', en: 'Forgejo repository' } }, { key: 'DSH_SUPERAGENT_FORGEJO_URL', description: { zh: 'Forgejo 地址', en: 'Forgejo origin' } }],
    values: ({ deployment }) => ({ DSH_SUPERAGENT_FORGEJO_REPOSITORY: deployment.repository, DSH_SUPERAGENT_FORGEJO_URL: deployment.forgejo?.url ?? '' }),
  },
}
export async function pollForgejo(ctx: SourceContext, signal?: AbortSignal): Promise<void> {
  const config = ctx.config<z.infer<typeof ForgejoConfig>>('forgejo')
  if (!config || !ctx.deployment.forgejo) return
  const commands = ctx.commands.withSignal(signal), login = ctx.deployment.forgejo.login
  const until = new Date().toISOString(), since = ctx.state.get(KV.forgejo.since) ?? until
  if (!ctx.state.get(KV.forgejo.since)) ctx.state.set(KV.forgejo.since, since)
  const numbers = new Set<number>()
  const issues = await commands.pages(IssueSchema, `issues?state=all&type=all&since=${encodeURIComponent(since)}`)
  for (const issue of issues) {
    numbers.add(issue.number)
    // Do not turn old issue descriptions into new requests merely because a new comment updated the issue.
    if (issue.created_at >= since && issue.user.login !== login) {
      const trigger = asForgejo(issueTrigger(issue, login)); trigger.meta.isPr = !!issue.pull_request
      if (issue.pull_request) trigger.meta.kind = 'pull'
      await ctx.receive(trigger)
    }
  }
  const comments = await commands.pages(CommentSchema.extend({ issue_url: z.string().optional(), pull_request_url: z.string().optional() }), `issues/comments?since=${encodeURIComponent(since)}`)
  for (const comment of comments) {
    if (comment.user.login === login) continue
    const number = Number((comment.issue_url ?? comment.pull_request_url ?? comment.html_url ?? '').match(/\/(?:issues|pulls)\/(\d+)/)?.[1])
    if (number) numbers.add(number)
  }
  for (const thread of ctx.threads.subscribed('forgejo')) { const number = Number(thread.ref.id); if (number) numbers.add(number) }
  // Open agent PRs must be discovered before ready can accidentally complete their tickets.
  const pulls = await commands.pages(z.object({ number: z.number() }), 'pulls?state=open')
  for (const pull of pulls) numbers.add(pull.number)
  for (const number of numbers) {
    try {
    const issue = await commands.api(IssueSchema, `issues/${number}`)
    const isPr = !!issue.pull_request
    const listed = await commands.pages(CommentSchema, `issues/${number}/comments?since=${encodeURIComponent(since)}`)
    for (const comment of listed) if (comment.user.login !== login) await ctx.receive(asForgejo(commentTrigger(comment, { number, isPr }, 'conversation', login)))
    if (isPr) {
      const pr = await readPull(ctx, number, signal)
      await observePull(ctx, pr)
      const reviews = await commands.pages(CommentSchema, `pulls/${number}/reviews`)
      for (const review of reviews) {
        if (review.user.login !== login && (review.updated_at ?? review.submitted_at ?? review.created_at ?? '') >= since) {
          await ctx.receive(asForgejo(commentTrigger(review, { number, isPr: true }, 'review', login)))
        }
        if (Number(review.comments_count) > 0) {
          const inline = await commands.pages(CommentSchema, `pulls/${number}/reviews/${review.id}/comments`)
          for (const comment of inline) if (comment.user.login !== login && (comment.updated_at ?? comment.created_at ?? '') >= since) {
            await ctx.receive(asForgejo(commentTrigger({ ...comment, line: comment.line ?? (Number(comment.position) || null) }, { number, isPr: true }, 'inline', login)))
          }
        }
      }
      if (pr.state === 'open') {
        const snapshot = await pullChecks(commands, pr.head.sha)
        const fingerprint = JSON.stringify(snapshot), k = KV.forgejo.ci(`pr:${number}`), old = ctx.state.get(k)
        if (old && old.fingerprint !== fingerprint) {
          const revision = old.revision + 1
          await ctx.receive(asForgejo(ciTrigger(pr, revision, ciSummary(snapshot, pr.head.sha, 'pull request commit status'))))
          ctx.state.set(k, { fingerprint, revision })
        } else if (!old) ctx.state.set(k, { fingerprint, revision: 0 })
      }
    }
    ctx.threads.describe(`forgejo:${number}`, { label: issue.title, url: issue.html_url })
    } catch (error) { if (!(error instanceof CliError && [404, 410].includes(error.code ?? 0))) throw error }
  }
  if (config.observeCi) {
    const repo = await commands.api(z.object({ default_branch: z.string() }), '')
    const snapshot = await pullChecks(commands, encodeURIComponent(repo.default_branch))
    const fingerprint = JSON.stringify(snapshot.statuses), k = KV.forgejo.ci(repo.default_branch), old = ctx.state.get(k)
    if (old && old.fingerprint !== fingerprint) {
      const revision = old.revision + 1
      await ctx.receive({ id: key('forgejo-ci', repo.default_branch, String(revision)), source: 'forgejo', threads: [{ source: 'forgejo', id: `ci:${repo.default_branch}` }],
        actor: { source: 'forgejo', id: '' }, human: false, at: until, text: ciSummary(snapshot, repo.default_branch, 'repository commit status'), meta: { ci: true, branch: repo.default_branch } })
      ctx.state.set(k, { fingerprint, revision })
    } else if (!old) ctx.state.set(k, { fingerprint, revision: 0 })
  }
  ctx.state.set(KV.forgejo.since, new Date(Date.parse(until) - 5000).toISOString())
  ctx.report('forgejo', { state: 'ready', detail: `Watching ${ctx.deployment.repository}`, at: until })
}
export const name = 'dsh-superagent-forgejo'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(forgejoKind))
  ctx.effect(() => {
    const controller = new AbortController(), source = sourceContext(ctx.orchestrator, forgejoKind)
    const run = async () => {
      await source.ready
      while (!controller.signal.aborted) {
        const config = source.config<z.infer<typeof ForgejoConfig>>('forgejo')
        if (source.configured() && config) {
          try { await pollForgejo(source, controller.signal) }
          catch { if (!controller.signal.aborted) source.report('forgejo', { state: 'error', detail: 'Forgejo poll failed; cursor retained for retry' }) }
        }
        await delay((config?.pollSeconds ?? 60) * 1000, undefined, { signal: controller.signal }).catch(() => {})
      }
    }
    const running = run()
    return async () => { controller.abort(); await running }
  })
}
