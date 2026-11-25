import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type JunieProcessSession = { sessionId: string; projectPath: string }

// The id reaches a shell command line on resume, so only plain id characters are accepted.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export function junieHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.JUNIE_HOME?.trim() || join(homedir(), '.junie')
}

/** Reads the session a live Junie process registered in `<junieHome>/processes/<pid>-<sessionId>-<hash>.json`. */
export async function resolveJunieProcessSession(
  pids: readonly number[],
  options: { junieHome?: string } = {}
): Promise<JunieProcessSession | null> {
  const processesDir = join(options.junieHome ?? junieHomeDir(), 'processes')
  let names: string[]
  try {
    names = await readdir(processesDir)
  } catch {
    return null
  }
  let best: (JunieProcessSession & { startedAt: number }) | null = null
  for (const pid of new Set(pids)) {
    const prefix = `${pid}-`
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) {
        continue
      }
      const entry = await readRegistryEntry(join(processesDir, name), pid)
      if (entry && (!best || entry.startedAt > best.startedAt)) {
        best = entry
      }
    }
  }
  return best ? { sessionId: best.sessionId, projectPath: best.projectPath } : null
}

type JunieRegistryEntry = JunieProcessSession & { startedAt: number; pid: number }

async function readRegistryEntry(
  path: string,
  pid: number
): Promise<(JunieProcessSession & { startedAt: number }) | null> {
  const entry = await parseRegistryEntry(path)
  return entry && entry.pid === pid ? entry : null
}

async function parseRegistryEntry(path: string): Promise<JunieRegistryEntry | null> {
  try {
    const json: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!json || typeof json !== 'object') {
      return null
    }
    const {
      pid: filePid,
      sessionId,
      projectPath,
      startedAt
    } = Object.fromEntries(Object.entries(json))
    if (
      typeof filePid !== 'number' ||
      !Number.isInteger(filePid) ||
      typeof sessionId !== 'string' ||
      !SESSION_ID_PATTERN.test(sessionId)
    ) {
      return null
    }
    return {
      pid: filePid,
      sessionId,
      projectPath: typeof projectPath === 'string' ? projectPath : '',
      startedAt: typeof startedAt === 'number' ? startedAt : 0
    }
  } catch {
    return null
  }
}

// EPERM means the pid exists under another user, so it still counts as alive.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** True when a registry file names this session and its pid is alive; stale files of killed processes are ignored. */
export async function isJunieSessionInUse(
  sessionId: string,
  options: { junieHome: string; assumeAlive?: boolean }
): Promise<boolean> {
  const processesDir = join(options.junieHome, 'processes')
  let names: string[]
  try {
    names = await readdir(processesDir)
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.endsWith('.json') || !name.includes(`-${sessionId}-`)) {
      continue
    }
    const entry = await parseRegistryEntry(join(processesDir, name))
    if (entry?.sessionId === sessionId && (options.assumeAlive || isPidAlive(entry.pid))) {
      return true
    }
  }
  return false
}
