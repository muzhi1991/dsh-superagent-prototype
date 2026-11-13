import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
// The CLI is shipped as native ESM, independently of the plugin bundle.
// @ts-expect-error standalone executable has no TS declaration
import { command } from '../scripts/paseo-agent.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-binding-'))); roots.push(root)
  const cwd = join(root, 'work'), state = join(root, 'state'), log = join(root, 'calls.jsonl')
  await mkdir(cwd); await mkdir(state)
  await promisify(execFile)('git', ['init', '-q', cwd])
  const cli = join(root, 'fake-paseo')
  await writeFile(cli, `#!${process.execPath}\nconst fs=require('node:fs');
const args=process.argv.slice(2).slice(2).filter(x=>x!=='--json');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,parent:process.env.PASEO_AGENT_ID})+'\\n');
let result={};
if(args[0]==='workspace'&&args[1]==='ls') result=[{workspaceId:'existing',project:'Risk',cwd:${JSON.stringify(cwd)}}];
if(args[0]==='project') result=[{projectId:'risk',name:'Risk'}];
if(args[0]==='ls') result=[];
if(args[0]==='run') result={agentId:'child',status:'running'};
if(args[0]==='inspect') result={Cwd:${JSON.stringify(cwd)},Status:'idle',Archived:false};
if(args[0]==='send') result={status:'sent'};
if(args[0]==='wait') result={status:'idle'};
console.log(args[0]==='logs'?'Assistant: verified':JSON.stringify(result));\n`, { mode: 0o755 })
  await writeFile(join(state, 'paseo.json'), JSON.stringify({ cli, home: root, projectId: 'risk', workRoot: cwd, provider: 'codex', mode: 'full-access', thinking: 'medium', env: { GIT_AUTHOR_NAME: 'bot' } }))
  const prompt = join(root, 'task.txt'); await writeFile(prompt, 'Read and report; no changes.')
  const run = (action: string, ...args: string[]) => command([action, '--state', state, '--ticket', 'ticket-a', ...args])
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { root, cwd, state, prompt, run, calls }
}
describe('Paseo CLI binding', () => {
  it('reuses an existing workspace, persists one agent, and deduplicates follow-up requests', async () => {
    const f = await fixture()
    const args = ['--directory', f.cwd, '--prompt-file', f.prompt]
    const first = await f.run('ensure', ...args)
    expect(first.binding.workspaceId).toBe('existing')
    expect(first.binding.agentId).toBe('child')
    expect((await f.run('ensure', ...args)).reused).toBe(true)
    await f.run('send', '--request', 'input-1', '--prompt-file', f.prompt, '--thinking', 'high')
    expect((await f.run('send', '--request', 'input-1', '--prompt-file', f.prompt)).duplicate).toBe(true)
    const calls = await f.calls()
    expect(calls.filter(c => c.args[0] === 'run')).toHaveLength(1)
    expect(calls.filter(c => c.args[0] === 'send')).toHaveLength(1)
    expect(calls.find(c => c.args[0] === 'run').args).toEqual(expect.arrayContaining(['--thinking', 'medium', '--mode', 'full-access']))
    expect(calls.filter(c => c.args[0] === 'agent')).toEqual([expect.objectContaining({ args: ['agent', 'update', 'child', '--thinking', 'high'] })])
    await f.run('send', '--request', 'input-2', '--prompt-file', f.prompt)
    expect((await f.calls()).filter(c => c.args[0] === 'agent').at(-1).args).toEqual(['agent', 'update', 'child', '--thinking', 'medium'])
    expect(calls.some(c => c.args[0] === 'workspace' && c.args[1] === 'create')).toBe(false)
    expect(calls.every(c => c.parent === undefined)).toBe(true)
    expect(calls.find(c => c.args[0] === 'run').args).toContain('GIT_AUTHOR_NAME=bot')
    await f.run('stop')
    expect((await f.calls()).some(c => c.args[0] === 'stop' && c.args[1] === 'child')).toBe(true)
    const waited = await f.run('wait', '--seconds', '1')
    expect(waited.result.status).toBe('idle')
    expect(waited.activity).toContain('Assistant: verified')
  })
  it('refuses directories outside the assigned root', async () => {
    const f = await fixture()
    await expect(f.run('ensure', '--directory', f.root, '--prompt-file', f.prompt)).rejects.toThrow('outside')
  })
  it('does not launch a duplicate after an uncertain creation outcome', async () => {
    const f = await fixture()
    await mkdir(join(f.state, 'paseo-bindings'))
    await writeFile(join(f.state, 'paseo-bindings', 'ticket-a.json'), JSON.stringify({ ticketId: 'ticket-a', home: f.root, projectId: 'risk', cwd: f.cwd, workspaceId: 'existing', label: 'probe', launchAttempted: 'earlier' }))
    await expect(f.run('ensure', '--directory', f.cwd, '--prompt-file', f.prompt)).rejects.toThrow('unknown')
    expect((await f.calls()).some(c => c.args[0] === 'run')).toBe(false)
  })
})
