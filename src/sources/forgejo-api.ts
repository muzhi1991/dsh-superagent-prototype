/** Repository-scoped Forgejo transport. Credentials stay in an owner-only file, never in settings or logs. */
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { Deployment, Machine } from '../deployment.ts'
import { CliError } from '../infra/commands.ts'
import { SetupError } from '../setup.ts'

export const ForgejoConfig = z.object({
  repository: z.string().regex(/^(?:[\w.-]+\/[\w.-]+)?$/).default(''), credentialsFile: z.string().refine(s => !s || s.startsWith('/')).default(''),
  cli: z.string().default(''),
  pollSeconds: z.number().int().min(10).max(3600).default(60),
  observeIssues: z.boolean().default(false), observeComments: z.boolean().default(false), observeCi: z.boolean().default(false),
}).strict()
const Credentials = z.object({ url: z.string().url(), login: z.string(), token: z.string().min(20) })
export async function credentials(file: string) {
  const info = await stat(file)
  if (info.mode & 0o077) throw new Error('Forgejo credentials file must have mode 0600')
  const value = Credentials.parse(JSON.parse(await readFile(file, 'utf8')))
  const url = new URL(value.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Forgejo URL must be an HTTPS origin')
  return { ...value, url: url.origin }
}
export async function forgejoFetch(file: string, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (/^\/|\.\.|^[a-z]+:/i.test(path)) throw new Error('Invalid Forgejo API path')
  const account = await credentials(file)
  const response = await fetch(`${account.url}/api/v1/${path}`, { method, redirect: 'error',
    headers: { Authorization: `token ${account.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([AbortSignal.timeout(30000), ...signal ? [signal] : []]) })
  if (!response.ok) throw new CliError(`Forgejo ${method} ${path.split('?')[0]} returned HTTP ${response.status}`, response.status)
  return response.status === 204 ? null : response.json()
}
export async function resolveForgejo(machine: Machine, raw: unknown): Promise<Deployment> {
  try {
    const config = ForgejoConfig.parse(raw), account = await credentials(config.credentialsFile)
    const user = z.object({ login: z.string() }).parse(await forgejoFetch(config.credentialsFile, 'user'))
    if (user.login !== account.login) throw new Error('Forgejo token belongs to a different user')
    const repo = z.object({ full_name: z.string(), permissions: z.object({ push: z.boolean() }) }).parse(await forgejoFetch(config.credentialsFile, `repos/${config.repository}`))
    if (!repo.permissions.push) throw new Error('Forgejo agent needs repository write access')
    return { ...machine, repository: repo.full_name, forgejo: { url: account.url, login: user.login, credentialsFile: config.credentialsFile, cli: config.cli },
      github: { cli: 'tea', login: user.login, noreply: `${user.login}@${new URL(account.url).hostname}` } }
  } catch (error) { throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : 'Forgejo setup failed' }) }
}
/** Shared readers use GitHub-shaped per_page parameters; translate only supported operations explicitly. */
export async function forgejoRequest(deployment: Deployment, path: string, flags: string[], signal?: AbortSignal): Promise<unknown> {
  const forge = deployment.forgejo!
  if (/^\/|\.\.|^[a-z]+:/i.test(path)) throw new Error('Forgejo calls are restricted to the configured repository')
  const uri = new URL(path, 'https://scope.invalid/')
  if (uri.searchParams.has('per_page')) { uri.searchParams.set('limit', uri.searchParams.get('per_page')!); uri.searchParams.delete('per_page') }
  let method = 'GET'; const body: Record<string, unknown> = {}; let raw = false
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!
    if (flag === '--method' || flag === '-X') method = flags[++i]!
    else if (flag === '-f' || flag === '-F') { const field = flags[++i]!; const pos = field.indexOf('='); body[field.slice(0,pos)] = field.slice(pos+1); if (method === 'GET') method = 'POST' }
    else if (flag === '-H') { const header = flags[++i]!; if (header.includes('application/vnd.github.raw')) raw = true; else throw new Error('Unsupported Forgejo header') }
    else if (!['--paginate', '--slurp'].includes(flag)) throw new Error(`Unsupported Forgejo option: ${flag}`)
  }
  const pages: unknown[] = []; const paginate = flags.includes('--paginate')
  if (paginate) uri.searchParams.set('limit', '50')
  let page = Number(uri.searchParams.get('page') ?? 1)
  for (;;) {
    if (paginate) uri.searchParams.set('page', String(page))
    const endpoint = `repos/${deployment.repository}${uri.pathname === '/' ? '' : uri.pathname}${uri.search}`
    const result = await forgejoFetch(forge.credentialsFile, endpoint, method, Object.keys(body).length ? body : undefined, signal)
    if (raw) { const file = z.object({ content: z.string(), encoding: z.literal('base64') }).parse(result); return Buffer.from(file.content, 'base64').toString('utf8') }
    if (!paginate) return normalize(result)
    if (!Array.isArray(result)) throw new Error('Forgejo pagination expected an array')
    pages.push(result.map(normalize))
    if (result.length < 50) return flags.includes('--slurp') ? pages : pages.flat()
    if (++page > 1000) throw new Error('Forgejo pagination exceeded limit; cursor was not advanced')
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.pull_request && typeof record.pull_request === 'object') return { ...record, pull_request: { ...record.pull_request, url: (record.pull_request as Record<string,unknown>).url ?? record.url ?? record.html_url ?? '' } }
  }
  return value
}
