import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { junieTranscriptPathForSummary } from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import type { AiVaultAgentSource } from '../../discovery/session-scanner-agent-sources'
import { sessionRootDirs } from '../../discovery/session-scanner-roots'

export const JUNIE_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(
      options.junieSessionsDir ??
        join(process.env.JUNIE_HOME?.trim() || join(homedir(), '.junie'), 'sessions'),
      wslHomeDirs,
      ['.junie', 'sessions']
    ),
  extensions: ['.json'],
  // Only <session-dir>/summary.json; task and subagent folders carry their own files.
  filePredicate: (filePath) =>
    basename(filePath) === 'summary.json' && basename(dirname(filePath)).startsWith('session-'),
  // Transcript appends must invalidate the cached summary row.
  contentDependencyPath: junieTranscriptPathForSummary
}
