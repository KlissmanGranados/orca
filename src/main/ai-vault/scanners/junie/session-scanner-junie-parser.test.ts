import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VAULT_AGENT_SOURCES } from '../../discovery/session-scanner-agent-sources'
import { parseJunieSessionFile } from './session-scanner-junie-parser'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const TRANSCRIPT = [
  '# Session transcript',
  '',
  '### list_files',
  '```text',
  '## not a heading',
  'a.ts',
  '```',
  '',
  '## User',
  'Remember PELICAN-42',
  '',
  '## Thinking',
  'hidden',
  '',
  '## Junie',
  'Acknowledged.',
  ''
].join('\n')

describe('parseJunieSessionFile', () => {
  it('lists real sessions with explicit title precedence and ignores empty ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'junie-scan-'))
    roots.push(root)
    const dir = join(root, 'session-261124-221324-s74c')
    mkdirSync(dir)
    const summaryPath = join(dir, 'summary.json')
    writeFileSync(
      summaryPath,
      JSON.stringify({
        sessionId: 'session-261124-221324-s74c',
        createdAt: 1795572808903,
        updatedAt: 1795573068151,
        projectDir: '/tmp/x',
        taskName: 'Task name',
        lastPromptAt: null
      })
    )
    writeFileSync(join(dir, 'session_metadata.json'), JSON.stringify({ explicitTitle: 'Explicit' }))
    writeFileSync(join(dir, 'transcript.md'), TRANSCRIPT)
    const emptyDir = join(root, 'session-261124-000000-aaaa')
    mkdirSync(emptyDir)
    writeFileSync(join(emptyDir, 'transcript.md'), '# Session transcript\n')

    const source = AI_VAULT_AGENT_SOURCES.junie!
    expect(source.filePredicate!(summaryPath)).toBe(true)
    expect(source.filePredicate!(join(emptyDir, 'transcript.md'))).toBe(false)
    expect(source.filePredicate!(join(dir, 'task-1', 'summary.json'))).toBe(false)

    const pushed: TranscriptMessage[] = []
    const session = await parseJunieSessionFile(
      { path: summaryPath, mtimeMs: 1, modifiedAt: new Date(1).toISOString() },
      'linux',
      { active: true, push: (message) => pushed.push(message) }
    )

    expect(session).toMatchObject({
      agent: 'junie',
      sessionId: 'session-261124-221324-s74c',
      title: 'Explicit',
      cwd: '/tmp/x',
      updatedAt: new Date(1795573068151).toISOString()
    })
    expect(pushed.map((message) => message.role)).toEqual(['tool', 'user', 'assistant'])
    expect(JSON.stringify(pushed[0])).toContain('## not a heading')
    expect(JSON.stringify(pushed[1])).toContain('Remember PELICAN-42')
    expect(JSON.stringify(pushed)).not.toContain('hidden')
  })
})
