/** Optional CLI bridge lifecycle. Paseo owns its processes, so stopping a DSH job alone is insufficient. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export async function stopPaseoAgent(stateDir: string, ticketId: string): Promise<void> {
  if (!existsSync(join(stateDir, 'paseo.json')) || !existsSync(join(stateDir, 'paseo-bindings', `${ticketId}.json`))) return
  const script = [new URL('../scripts/paseo-agent.mjs', import.meta.url), new URL('../../scripts/paseo-agent.mjs', import.meta.url)]
    .map(url => fileURLToPath(url)).find(existsSync)
  if (!script) throw new Error('Missing Paseo CLI binding script')
  await exec(process.execPath, [script, 'stop', '--state', stateDir, '--ticket', ticketId], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 85_000, maxBuffer: 1024 * 1024,
  })
}
