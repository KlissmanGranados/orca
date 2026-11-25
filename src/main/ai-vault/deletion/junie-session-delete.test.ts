import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { deleteAiVaultSessionFile } from './session-delete'
import { removeAiVaultSessionPathPermanently } from './host-session-delete'

const SESSION_ID = 'session-261118-002907-1h93'

let home: string
let sessions: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-junie-delete-'))
  sessions = join(home, 'sessions')
  await mkdir(join(sessions, SESSION_ID), { recursive: true })
  await writeFile(join(sessions, SESSION_ID, 'summary.json'), '{}')
  await mkdir(join(sessions, 'session-261118-003050-4qkx'), { recursive: true })
  await writeFile(join(sessions, 'session-261118-003050-4qkx', 'summary.json'), '{}')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function remove(filePath: string) {
  return deleteAiVaultSessionFile(
    {
      agent: 'junie',
      filePath,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      rootOptions: { junieSessionsDir: sessions }
    },
    removeAiVaultSessionPathPermanently
  )
}

describe('junie session deletion', () => {
  it('removes only the targeted session directory', async () => {
    expect(await remove(join(sessions, SESSION_ID, 'summary.json'))).toEqual({ outcome: 'deleted' })
    expect((await readdir(sessions)).sort()).toEqual(['session-261118-003050-4qkx'])
  })

  it('refuses traversal, absolute and sibling-prefix paths', async () => {
    const evil = join(home, 'sessions-evil', SESSION_ID)
    await mkdir(evil, { recursive: true })
    await writeFile(join(evil, 'summary.json'), '{}')
    for (const path of [
      join(sessions, '..', 'sessions-evil', SESSION_ID, 'summary.json'),
      join(evil, 'summary.json'),
      join(sessions, SESSION_ID, '..', '..', 'summary.json')
    ]) {
      expect((await remove(path)).outcome).toBe('rejected')
    }
    expect(await readdir(evil)).toEqual(['summary.json'])
    expect((await readdir(sessions)).length).toBe(2)
  })

  it('refuses a directory name that is not a Junie session id', async () => {
    const odd = join(sessions, 'session-oops')
    await mkdir(odd)
    await writeFile(join(odd, 'summary.json'), '{}')
    expect(await remove(join(odd, 'summary.json'))).toMatchObject({ outcome: 'rejected' })
    expect(await readdir(odd)).toEqual(['summary.json'])
  })

  it('refuses a nested summary.json that is not a direct child of the sessions root', async () => {
    const nested = join(sessions, SESSION_ID, 'session-261118-111111-abcd')
    await mkdir(nested)
    await writeFile(join(nested, 'summary.json'), '{}')
    expect((await remove(join(nested, 'summary.json'))).outcome).toBe('rejected')
    expect(await readdir(nested)).toEqual(['summary.json'])
  })

  it('refuses a symlinked session directory and keeps its target', async () => {
    const target = join(home, 'victim')
    await mkdir(target)
    await writeFile(join(target, 'summary.json'), '{}')
    const link = join(sessions, 'session-261118-222222-link')
    await symlink(target, link, 'dir')
    expect((await remove(join(link, 'summary.json'))).outcome).toBe('rejected')
    expect(await readdir(target)).toEqual(['summary.json'])
  })

  it('refuses a session held by a live process but ignores stale registry files', async () => {
    const processes = join(home, 'processes')
    await mkdir(processes)
    await writeFile(
      join(processes, `${process.pid}-${SESSION_ID}-abc.json`),
      JSON.stringify({ pid: process.pid, sessionId: SESSION_ID })
    )
    expect(await remove(join(sessions, SESSION_ID, 'summary.json'))).toEqual({
      outcome: 'rejected',
      agent: 'junie',
      reason: 'session-in-use'
    })
    expect(await readdir(sessions)).toContain(SESSION_ID)

    await rm(join(processes, `${process.pid}-${SESSION_ID}-abc.json`))
    await writeFile(
      join(processes, `2147483000-${SESSION_ID}-abc.json`),
      JSON.stringify({ pid: 2147483000, sessionId: SESSION_ID })
    )
    expect(await remove(join(sessions, SESSION_ID, 'summary.json'))).toEqual({ outcome: 'deleted' })
  })
})
