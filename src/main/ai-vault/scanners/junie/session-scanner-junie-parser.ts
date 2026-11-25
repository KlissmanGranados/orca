import { createInterface } from 'node:readline'
import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../../scan-lifecycle/ai-vault-scan-cancellation'
import {
  openTranscriptReadStream,
  wslGatedReadFile
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import { dirname } from 'node:path'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  junieSessionMetadataPathForSummary,
  junieTranscriptPathForSummary
} from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import type { FileWithMtime, SessionAccumulator } from '../../session-scanner-types'
import type { TranscriptMessageSink } from '../../transcripts/session-transcript-consumers'
import {
  createAccumulator,
  finalizeSession,
  sessionIdFromFileName,
  updateTimeline
} from '../../parsing/session-scanner-accumulator'
import { addSessionContent } from '../../parsing/session-scanner-messages'
import { asRecord } from '../../parsing/session-record-fields'
import { extractString } from '../../../../shared/text/trimmed-string'
import { normalizeTitleText } from '../../parsing/session-scanner-text-normalization'
import { numberValue } from '../../parsing/session-scanner-token-values'
import { JunieTranscriptSplitter } from './junie-transcript-markdown'

export async function parseJunieSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  let summary: unknown
  try {
    summary = JSON.parse(
      await waitForAiVaultScan(wslGatedReadFile(file.path, 'utf-8', 'scan', signal), signal)
    )
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (
      error instanceof WslTranscriptFsError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
    return null
  }
  const record = asRecord(summary)
  if (!record) {
    return null
  }
  const sessionId = extractString(record.sessionId) ?? sessionIdFromFileName(dirname(file.path))
  const accumulator = createAccumulator({ agent: 'junie', file, sessionId, messages })
  const metadata = await readOptionalJson(junieSessionMetadataPathForSummary(file.path), signal)
  // Seed explicit titles before messages so the first prompt cannot replace them.
  accumulator.title =
    normalizeTitleText(extractString(metadata?.explicitTitle) ?? '') ||
    normalizeTitleText(extractString(record.taskName) ?? '') ||
    null
  accumulator.cwd = extractString(record.projectDir)
  accumulator.model = junieModel(record)
  accumulator.totalTokens = junieTotalTokens(record)
  updateTimeline(accumulator, numberOrNull(record.createdAt))
  updateTimeline(accumulator, numberOrNull(record.lastPromptAt) ?? numberOrNull(record.updatedAt))
  await consumeJunieTranscript(accumulator, junieTranscriptPathForSummary(file.path), signal)
  return finalizeSession(accumulator, platform)
}

/** Scope discovery reads cwd from the summary without opening the transcript. */
export function junieSessionCwd(summary: Record<string, unknown>): string | null {
  return extractString(summary.projectDir)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function junieModelUsage(record: Record<string, unknown>): Record<string, unknown>[] {
  const usage = asRecord(record.mainAgent)?.modelUsage
  return Array.isArray(usage)
    ? usage.flatMap((entry: unknown) => {
        const entryRecord = asRecord(entry)
        return entryRecord ? [entryRecord] : []
      })
    : []
}

function junieModel(record: Record<string, unknown>): string | null {
  for (const entry of junieModelUsage(record)) {
    const model = extractString(entry.model)
    if (model) {
      return model
    }
  }
  return null
}

function junieTotalTokens(record: Record<string, unknown>): number {
  return junieModelUsage(record).reduce(
    (sum, entry) => sum + numberValue(entry.inputTokens) + numberValue(entry.outputTokens),
    0
  )
}

async function readOptionalJson(
  path: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(
      JSON.parse(await waitForAiVaultScan(wslGatedReadFile(path, 'utf-8', 'scan', signal), signal))
    )
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    if (
      error instanceof WslTranscriptFsError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
    return null
  }
}

async function consumeJunieTranscript(
  accumulator: SessionAccumulator,
  transcriptPath: string,
  signal?: AbortSignal
): Promise<void> {
  const splitter = new JunieTranscriptSplitter()
  const input = openTranscriptReadStream(transcriptPath, { encoding: 'utf-8' }, 'scan', signal)
  const lines = createInterface({ input, crlfDelay: Infinity })
  const consume = async (message: ReturnType<JunieTranscriptSplitter['end']>): Promise<void> => {
    if (!message) {
      return
    }
    await waitForAiVaultScan(accumulator.messages.drain?.() ?? Promise.resolve(), signal)
    if (message.role === 'user') {
      accumulator.title ??= normalizeTitleText(message.text) || null
    }
    accumulator.messageCount++
    addSessionContent(accumulator, message.role, message.text)
  }
  try {
    for await (const line of lines) {
      await consume(splitter.push(line))
    }
    await consume(splitter.end())
  } catch (error) {
    throwIfAiVaultScanCancelled(signal)
    // A summary without a readable transcript still lists; WSL refusal must not be cached as current.
    if (
      error instanceof WslTranscriptFsError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error
    }
  } finally {
    lines.close()
    input.destroy()
  }
}
