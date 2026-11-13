#!/usr/bin/env node
/** Persistent Ticket -> Paseo binding. Optional deployment file: <stateDir>/paseo.json. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import lockfile from 'proper-lockfile'

const exec = promisify(execFile)
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const optional = async file => { try { return await json(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
const save = async (file, value) => {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temp, file)
}

export async function command(args) {
  const [action, ...rest] = args
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error('Expected --name value pairs')
    options[rest[i].slice(2)] = rest[i + 1]
  }
  if (!['ensure', 'send', 'wait', 'status', 'stop'].includes(action)) throw new Error('Use ensure|send|wait|status|stop')
  if (!options.state || !options.ticket || !/^[A-Za-z0-9_-]+$/.test(options.ticket)) throw new Error('--state and a valid --ticket are required')
  const state = resolve(options.state)
  const config = await optional(join(state, 'paseo.json'))
  if (!config) {
    if (action === 'stop') return { stopped: false, configured: false }
    throw new Error('Paseo is not configured for this deployment')
  }
  if (!config.cli || !config.home || !config.projectId || !config.workRoot || !config.provider || !config.mode) throw new Error('Incomplete paseo.json')
  const thinking = options.thinking ?? config.thinking
  const directory = join(state, 'paseo-bindings')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `${options.ticket}.json`)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('PASEO_') || key.startsWith('GIT_')) delete env[key]
  const cli = async (argv, timeout = 60_000) => {
    const { stdout } = await exec(config.cli, ['--home', config.home, ...argv, '--json'], { env, timeout, maxBuffer: 16 * 1024 * 1024 })
    return argv[0] === 'logs' ? stdout : JSON.parse(stdout)
  }
  const check = async binding => {
    if (binding.home !== config.home || binding.projectId !== config.projectId) throw new Error('Binding belongs to a different Paseo deployment; explicit migration required')
    const agent = await cli(['inspect', binding.agentId])
    if (await realpath(agent.Cwd) !== binding.cwd || agent.Archived) throw new Error('Bound Paseo agent is archived or its directory changed')
    return agent
  }
  const readBinding = async () => {
    const binding = await optional(file)
    if (!binding?.agentId) throw new Error('No completed binding; run ensure with the original task to reconcile creation')
    return binding
  }
  // Wait never holds the mutation lock: cancellation must remain available while a turn runs.
  if (action === 'wait' || action === 'status') {
    const binding = await readBinding()
    const agent = await check(binding)
    if (action === 'status') return { binding, agent }
    const seconds = Number(options.seconds ?? 1200)
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1500) throw new Error('--seconds must be 1..1500')
    const result = await cli(['wait', binding.agentId, '--timeout', `${seconds}s`], (seconds + 15) * 1000)
    const activity = await cli(['logs', binding.agentId, '--tail', '30'])
    return { binding, result, activity }
  }
  // Serialize create/send/stop; persist intents before network calls so uncertain outcomes never duplicate work.
  const release = await lockfile.lock(directory, { retries: { retries: 65, minTimeout: 1000, maxTimeout: 1000 }, stale: 120_000, realpath: true })
  try {
    let binding = await optional(file)
    if (action === 'stop') {
      if (!binding) return { stopped: false, bound: false }
      if (!binding.agentId) {
        const matches = await cli(['ls', '--all', '--global', '--label', `superagent-binding=${binding.label}`])
        if (matches.length > 1) throw new Error('Multiple agents match this Ticket; stop them explicitly')
        if (matches.length === 1) binding.agentId = matches[0].id
      }
      binding.cancelled = true
      await save(file, binding)
      if (!binding.agentId) return { stopped: false, bound: false, cancelled: true }
      await check(binding)
      return { binding, result: await cli(['stop', binding.agentId]) }
    }
    if (action === 'send') {
      binding = await readBinding()
      const agent = await check(binding)
      if (agent.Status !== 'idle') throw new Error(`Agent is ${agent.Status}; wait before sending another task`)
      if (!options['prompt-file'] || !options.request) throw new Error('send needs --prompt-file and a unique --request (use the source input/job ID)')
      binding.requests ??= {}
      if (binding.requests[options.request]) return { binding, duplicate: true, receipt: binding.requests[options.request] }
      if (options.thinking) await cli(['agent', 'update', binding.agentId, '--thinking', options.thinking])
      binding.requests[options.request] = 'dispatching; inspect history before any retry'
      await save(file, binding)
      const result = await cli(['send', binding.agentId, '--prompt-file', resolve(options['prompt-file']), '--behavior', 'steer', '--no-wait'])
      binding.requests[options.request] = result
      binding.cancelled = false
      await save(file, binding)
      return { binding, result }
    }
    if (binding?.agentId) {
      if (options.directory && await realpath(options.directory) !== binding.cwd) throw new Error('Ticket directory changed')
      return { binding, agent: await check(binding), reused: true }
    }
    if (binding?.cancelled) throw new Error('Creation was cancelled; inspect the binding before restarting')
    if (!options.directory || !options['prompt-file']) throw new Error('ensure needs --directory and --prompt-file')
    const cwd = await realpath(options.directory)
    const root = await realpath(config.workRoot)
    const rel = relative(root, cwd)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Ticket directory is outside the configured workRoot')
    if (binding && binding.cwd !== cwd) throw new Error('Ticket directory changed')
    const title = options.title ?? `Superagent ${options.ticket}`
    binding ??= { ticketId: options.ticket, home: config.home, projectId: config.projectId, cwd, provider: config.provider, label: `${config.bindingPrefix ?? 'superagent'}-${options.ticket}`, title, requests: {} }
    await save(file, binding)
    if (!binding.workspaceId) {
      const workspaces = await cli(['workspace', 'ls'])
      const matching = []
      for (const workspace of workspaces) {
        if (await realpath(workspace.cwd).catch(() => '') === cwd) matching.push(workspace)
      }
      if (matching.length > 1) throw new Error('Multiple workspaces use this directory; select workspaceId in the binding explicitly')
      if (matching.length) {
        // CLI list exposes a project name, not its id; confirm against the configured project's unique name.
        const projects = await cli(['project', 'ls'])
        const project = projects.find(p => p.projectId === config.projectId)
        if (!project || matching[0].project !== project.name || projects.filter(p => p.name === project.name).length !== 1) throw new Error('Existing workspace is not unambiguously in the configured Project')
        binding.workspaceId = matching[0].workspaceId
      } else {
        const workspace = await cli(['workspace', 'create', '--isolation', 'local', '--path', cwd, '--project', config.projectId, '--title', title, '--no-background'])
        binding.workspaceId = workspace.workspaceId
      }
      await save(file, binding)
    }
    const existing = await cli(['ls', '--all', '--global', '--label', `superagent-binding=${binding.label}`])
    if (existing.length > 1) throw new Error('Multiple agents match this Ticket; reconcile explicitly')
    if (existing.length) {
      binding.agentId = existing[0].id
      await check(binding)
      await save(file, binding)
      return { binding, recovered: true }
    }
    if (binding.launchAttempted) throw new Error('Previous launch outcome is unknown; inspect Paseo before retrying (no automatic duplicate launch)')
    const task = await readFile(options['prompt-file'], 'utf8')
    const branch = (await exec('git', ['-C', cwd, 'branch', '--show-current'], { env })).stdout.trim()
    const identity = config.env ?? {}
    const prefix = `You are the delegated agent for Ticket ${options.ticket}, in ${cwd}, branch ${branch || '(detached; research only)'}. Do the assigned research, planning, debugging, review, environment setup or implementation. For code changes, test locally and make small local commits with the configured Git identity; leave push, Issue/PR management, remote CI dispatch and external messaging to the DSH Worker. Provide conclusions, commit IDs, checks/evidence and required remote CI parameters. Follow repository AGENTS.md. Work only within this assignment; do not create additional agents unless explicitly delegated.\n\n`
    const argv = ['run', '--workspace', binding.workspaceId, '--provider', config.provider, '--mode', config.mode, '--title', title, '--label', `superagent-binding=${binding.label}`, '--no-wait']
    if (config.model) argv.push('--model', config.model)
    if (thinking) argv.push('--thinking', thinking)
    for (const [key, value] of Object.entries(identity)) argv.push('--env', `${key}=${value}`)
    binding.launchAttempted = new Date().toISOString()
    await save(file, binding)
    const agent = await cli([...argv, prefix + task])
    if (!agent.agentId) throw new Error('Paseo did not return an agentId')
    binding.agentId = agent.agentId
    await save(file, binding)
    return { binding, result: agent }
  } finally { await release() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  command(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
