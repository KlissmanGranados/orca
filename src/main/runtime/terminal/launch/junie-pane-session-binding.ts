import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { LaunchResumeIdentityEvent } from '../../../agent-hooks/server/launch-resume-identity-event'
import { resolveJunieProcessSession } from '../../../junie/junie-process-session'
import { readTerminalProcessRows } from '../../../pty/process-retirement/terminal-process-rows'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

// Junie's JVM can take a while to start and register its process file.
const UNBOUND_CHECK_MS = 2_000
// A bound pane is re-read this often so a later Junie run in the same shell replaces the session id.
const BOUND_CHECK_MS = 10_000

type Dependencies = {
  getPty(ptyId: string): RuntimePtyWorktreeRecord | null
  isWsl(ptyId: string): boolean
  getController(): RuntimePtyController | null
  resolveTargets(ptyId: string): { paneKey: string; worktreeId?: string }[]
  record(event: LaunchResumeIdentityEvent): void
}

/** Junie has no hooks, so its session id is read from the process registry it keeps while running. */
export class JuniePaneSessionBinding {
  private readonly bindings = new Map<
    string,
    {
      incarnationId: string | null
      boundSessionId: string | null
      nextCheckAt: number
      inFlight: boolean
    }
  >()

  constructor(private readonly deps: Dependencies) {}

  /** Output-driven and throttled: a launched pane's foregroundAgent never clears, so a restarted Junie is found by re-reading the registry. */
  observe(ptyId: string): void {
    const pty = this.deps.getPty(ptyId)
    const isJunie = (pty?.launchAgent ?? pty?.foregroundAgent) === 'junie'
    let binding = this.bindings.get(ptyId)
    if (!pty || !isJunie || pty.connectionId || process.platform === 'win32') {
      if (binding) {
        this.forgetPty(ptyId)
      }
      return
    }
    if (binding && binding.incarnationId !== (pty.incarnationId ?? null)) {
      this.forgetPty(ptyId)
      binding = undefined
    }
    if (!binding) {
      binding = {
        incarnationId: pty.incarnationId ?? null,
        boundSessionId: null,
        nextCheckAt: 0,
        inFlight: false
      }
      this.bindings.set(ptyId, binding)
    }
    if (binding.inFlight || Date.now() < binding.nextCheckAt) {
      return
    }
    binding.inFlight = true
    const entry = binding
    void this.check(ptyId, entry).finally(() => {
      entry.inFlight = false
      entry.nextCheckAt = Date.now() + (entry.boundSessionId ? BOUND_CHECK_MS : UNBOUND_CHECK_MS)
    })
  }

  forgetPty(ptyId: string): void {
    this.bindings.delete(ptyId)
  }

  private async check(
    ptyId: string,
    entry: NonNullable<ReturnType<typeof this.bindings.get>>
  ): Promise<void> {
    const pty = this.deps.getPty(ptyId)
    if (!pty?.connected || this.deps.isWsl(ptyId)) {
      return
    }
    const pids = await this.readForegroundPids(ptyId)
    if (pids.length === 0) {
      return
    }
    const session = await resolveJunieProcessSession(pids)
    // The pane or its process may have changed while the registry was read.
    if (
      !session ||
      session.sessionId === entry.boundSessionId ||
      this.bindings.get(ptyId) !== entry ||
      this.deps.getPty(ptyId) !== pty
    ) {
      return
    }
    entry.boundSessionId = session.sessionId
    for (const target of this.deps.resolveTargets(ptyId)) {
      this.deps.record({
        paneKey: target.paneKey,
        ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
        agentType: 'junie',
        providerSession: {
          key: 'session_id',
          id: session.sessionId,
          ...(session.projectPath ? { cwd: session.projectPath } : {})
        },
        launchedAt: Date.now()
      })
    }
  }

  /** The launcher is a shell script, so the registered JVM pid is any process of the pane's foreground group. */
  private async readForegroundPids(ptyId: string): Promise<number[]> {
    const target = (
      await this.deps.getController()?.listProcesses?.(LOCAL_EXECUTION_HOST_ID, {
        ptyIds: [ptyId],
        targetOwnerOnly: true
      })
    )?.find((pane) => pane.id === ptyId)
    const rootPid = target?.rootProcessId
    const rows = rootPid ? await readTerminalProcessRows(rootPid) : null
    const foregroundGroup = rows?.find((row) => row.pid === rootPid)?.tpgid
    return foregroundGroup && foregroundGroup > 0
      ? (rows ?? []).filter((row) => row.pgid === foregroundGroup).map((row) => row.pid)
      : []
  }
}
