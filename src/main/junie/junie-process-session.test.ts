import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveJunieProcessSession } from './junie-process-session'

let home: string | null = null
afterEach(async () => {
  if (home) {
    await rm(home, { recursive: true, force: true })
  }
  home = null
})

describe('resolveJunieProcessSession', () => {
  it('picks the newest live-pid entry and ignores other pids, stale prefixes and bad files', async () => {
    home = await mkdtemp(join(tmpdir(), 'junie-home-'))
    const dir = join(home, 'processes')
    await mkdir(dir)
    const put = (name: string, body: string) => writeFile(join(dir, name), body)
    await put(
      '42-session-old-aaa.json',
      '{"pid":42,"sessionId":"session-old","startedAt":10,"projectPath":"/a"}'
    )
    await put(
      '42-session-new-bbb.json',
      '{"pid":42,"sessionId":"session-new","startedAt":20,"projectPath":"/b"}'
    )
    await put('42-session-lie-ccc.json', '{"pid":99,"sessionId":"session-lie","startedAt":30}')
    await put('42-session-bad-ddd.json', '{not json')
    await put(
      '423-session-other-eee.json',
      '{"pid":423,"sessionId":"session-other","startedAt":40}'
    )

    expect(await resolveJunieProcessSession([42], { junieHome: home })).toEqual({
      sessionId: 'session-new',
      projectPath: '/b'
    })
    expect(await resolveJunieProcessSession([12], { junieHome: home })).toBeNull()
    expect(await resolveJunieProcessSession([7], { junieHome: home })).toBeNull()
  })
})
