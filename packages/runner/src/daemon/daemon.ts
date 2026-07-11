/**
 * Daemon entry (04 §8): owns WsClient + SessionManager + GitService +
 * discovery + the control socket. Started by `yasui-runner start`
 * (detached child) or by a service manager with `--foreground` (04 §7).
 *
 * Exit-code contract (04 §7): exit 0 = intentional stop (stop command,
 * close 4003/4013) — service managers do not restart; nonzero = crash.
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  ClaudeSettingsRequestFrame,
  ClaudeSettingsResultPayload,
  GitRequestFrame,
  GitRequestPayload,
  ProjectScanFrame,
  RelayFrame,
  RunnerUpdateFrame,
  ServerToRunnerFrame,
} from '@yasui.io/runner-protocol'
import { loadConfig, type RunnerConfig } from '../config/config.js'
import {
  controlSocketPath,
  daemonStatePath,
  logsDir,
  outboxDir,
  runnerLogPath,
  sessionLogsDir,
  stateDir,
} from '../config/paths.js'
import { GitService } from '../git/git-service.js'
import { createLogger, type Logger } from '../log/logger.js'
import { DISCOVERY_RESCAN_MS, ProjectDiscovery } from '../projects/discovery.js'
import { redactDeep } from '../redact.js'
import { ClaudeSettingsError, readClaudeSettings, updateClaudeSettings } from '../settings/claude-settings.js'
import { loadAdapterFactories } from '../sessions/adapter-registry.js'
import { SessionManager } from '../sessions/session-manager.js'
import { checkLatestVersion, finalizeUpdateIfPending, isManagedInstall, performUpdate, UPDATE_DRAIN_DEFAULT_MS } from '../update/self-update.js'
import { opId } from '../util/ids.js'
import { detectHarnesses, RUNNER_VERSION } from '../version.js'
import { ControlServer, type DaemonStatus } from './control.sock.js'
import { isDaemonRunning, type DaemonState } from './state.js'
import { OutboxManager } from './outbox.js'
import { WsClient } from './ws-client.js'

export const RUNNER_CAPS = ['git', 'worktrees', 'delta-streaming', 'self-update', 'claude-settings'] as const
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const STOP_DRAIN_DEADLINE_MS = 15_000

export interface RunDaemonOptions {
  /** true when launched by a service manager / start.ts child — no forking here. */
  logToFile: boolean
  insecurePerms?: boolean
}

export async function runDaemon(opts: RunDaemonOptions): Promise<void> {
  let config: RunnerConfig
  try {
    config = loadConfig({ insecurePerms: opts.insecurePerms })
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1)
  }

  fs.mkdirSync(logsDir(), { recursive: true, mode: 0o700 })
  fs.mkdirSync(sessionLogsDir(), { recursive: true, mode: 0o700 })
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  fs.mkdirSync(outboxDir(), { recursive: true, mode: 0o700 })

  const log: Logger = createLogger({
    level: config.logLevel,
    ...(opts.logToFile ? { file: runnerLogPath() } : {}),
  })

  if (await isDaemonRunning()) {
    log.error('daemon already running — refusing to start twice')
    process.stderr.write('yasui-runner daemon is already running (see `yasui-runner status`)\n')
    process.exit(1)
  }

  const state: DaemonState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    socketPath: controlSocketPath(),
    version: RUNNER_VERSION,
  }
  fs.writeFileSync(daemonStatePath(), JSON.stringify(state, null, 2) + '\n')

  /* ---------- composition ---------- */

  const configRef = { current: config }
  const git = new GitService({ roots: () => configRef.current.roots })
  const outboxes = new OutboxManager(outboxDir(), {
    onDiskError: (err) => {
      log.error({ err: err.message }, 'outbox disk write failed — falling back to memory-only')
      ws.sendError('yasui_runner_internal', 'outbox disk write failed', { disk: 'full' })
    },
  })
  const restored = outboxes.restoreFromDisk()
  if (restored.length > 0) {
    log.info({ sessions: restored.map((o) => o.sessionId) }, 'restored outbox spillover from previous run')
  }

  const discovery = new ProjectDiscovery({
    roots: () => configRef.current.roots,
    trustedProjects: () => configRef.current.trustedProjects,
    git,
  })

  const manager = new SessionManager({
    config: () => configRef.current,
    git,
    outboxes,
    relay: {
      get connected() {
        return ws.connected
      },
      sendDurable: (frame) => ws.sendDurable(frame),
      sendDroppable: (frame, klass) => ws.sendDroppable(frame, klass),
      sendError: (code, message, details, sessionId) => ws.sendError(code, message, details, sessionId),
    },
    adapters: await loadAdapterFactories(log),
    log,
  })

  let shuttingDown = false
  let updateAvailable: string | null = null
  let lastProjectListJson = ''

  const pushProjectList = async (replyOpId?: string, force = false): Promise<void> => {
    const projects = await discovery.scan()
    const serialized = JSON.stringify(projects)
    if (!replyOpId && !force && serialized === lastProjectListJson) return
    // Only cache what actually went out — a send dropped while disconnected (or
    // gated behind outbox replay) must not suppress the next identical push.
    if (ws.sendDurable(ws.envelope('project.list', { opId: replyOpId ?? opId(), projects }))) {
      lastProjectListJson = serialized
    }
  }

  const handleGitRequest = async (frame: GitRequestFrame): Promise<void> => {
    let payload = frame.payload
    // Requests scoped to a LIVE session resolve args.path from the session's
    // actual cwd (worktree-aware) instead of trusting the wire path (04 §10);
    // worktree.* ops keep operating on the main repo path. Root confinement
    // still applies inside GitService.
    if (frame.sessionId) {
      const paths = manager.sessionGitPaths(frame.sessionId)
      if (paths) {
        const target = payload.op.startsWith('worktree.') ? paths.projectPath : paths.cwd
        payload = { ...payload, args: { ...payload.args, path: target } } as GitRequestPayload
      }
    }
    const result = await git.handleRequest(payload)
    // Redaction pass (04 §13 — every outbound payload string): diff.file hunk
    // lines carry raw file content and error stderr can echo credentialed URLs.
    const prepared = configRef.current.redactionEnabled ? redactDeep(result) : result
    ws.sendDurable(ws.envelope('git.result', prepared, frame.sessionId))
  }

  const handleClaudeSettingsRequest = async (frame: ClaudeSettingsRequestFrame): Promise<void> => {
    const { opId: requestOpId, action, target } = frame.payload
    let result: ClaudeSettingsResultPayload
    try {
      if (!configRef.current.remoteClaudeSettingsEnabled) {
        throw new ClaudeSettingsError(
          'yasui_claude_settings_disabled',
          'Remote Claude settings are disabled on this runner. Enable them locally with `yasui-runner config set remote-claude-settings on`.',
        )
      }
      result =
        action === 'get'
          ? await readClaudeSettings(requestOpId, target)
          : await updateClaudeSettings(
              requestOpId,
              target,
              frame.payload.patch,
              frame.payload.expectedRevision,
              frame.payload.allowMalformedReset,
            )
    } catch (error) {
      const known = error instanceof ClaudeSettingsError ? error : null
      result = {
        opId: requestOpId,
        action,
        target,
        ok: false,
        error: {
          code: known?.code ?? 'yasui_claude_settings_failed',
          message: known?.message ?? 'The runner could not update Claude settings.',
        },
        ...(known?.revision !== undefined ? { revision: known.revision } : {}),
      }
    }
    if (!ws.sendControl(ws.envelope('claude.settings.result', result))) {
      log.warn({ opId: requestOpId }, 'failed to queue Claude settings RPC response')
    }
  }

  const handleRunnerUpdate = async (frame: RunnerUpdateFrame): Promise<void> => {
    const deadline = Date.parse(frame.payload.deadline)
    await drainAndUpdate(frame.payload.targetVersion, Number.isFinite(deadline) ? deadline : Date.now() + UPDATE_DRAIN_DEFAULT_MS)
  }

  const drainAndUpdate = async (targetVersion: string, deadlineEpochMs: number): Promise<void> => {
    if (!isManagedInstall()) {
      log.warn('runner.update received but this is not a managed install — ignoring')
      return
    }
    if (manager.isDraining) return
    log.info({ targetVersion }, 'update requested — draining (no new sessions)')
    manager.setDraining(true)
    while (manager.activeCount() > 0 && Date.now() < deadlineEpochMs && !shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    if (manager.activeCount() > 0) {
      // Past deadline with healthy sessions: no forced kill — postpone (04 §12 step 1).
      log.info('update postponed — sessions still active past the drain deadline')
      manager.setDraining(false)
      return
    }
    const result = await performUpdate(targetVersion, {
      info: (m) => log.info(m),
      warn: (m) => log.warn(m),
    })
    if (!result.ok) {
      log.error({ reason: result.reason, message: result.message }, 'self-update failed')
      ws.sendError('yasui_runner_internal', 'self-update failed', { update: 'failed', reason: result.reason })
      manager.setDraining(false)
      return
    }
    log.info('update staged — exiting for service-manager restart')
    await shutdown(0, 'self-update restart')
  }

  const onCommand = async (frame: ServerToRunnerFrame): Promise<void> => {
    switch (frame.type) {
      case 'git.request':
        await handleGitRequest(frame as GitRequestFrame)
        return
      case 'project.scan':
        await pushProjectList((frame as ProjectScanFrame).payload.opId)
        return
      case 'claude.settings.request':
        await handleClaudeSettingsRequest(frame as ClaudeSettingsRequestFrame)
        return
      case 'runner.update':
        // Fire and forget — draining takes minutes and must not block dispatch.
        void handleRunnerUpdate(frame as RunnerUpdateFrame)
        return
      case 'error':
        log.warn({ code: (frame.payload as { code?: string }).code, message: (frame.payload as { message?: string }).message }, 'server error frame')
        return
      default:
        await manager.handleCommand(frame)
    }
  }

  const ws: WsClient = new WsClient({
    runnerVersion: RUNNER_VERSION,
    log,
    hooks: {
      connection: () => ({ relayUrl: configRef.current.relayUrl, token: configRef.current.token }),
      refreshConnection: () => {
        try {
          const fresh = loadConfig({ insecurePerms: opts.insecurePerms })
          configRef.current = fresh
          return { relayUrl: fresh.relayUrl, token: fresh.token }
        } catch {
          return null
        }
      },
      buildHello: () => ({
        host: {
          hostname: configRef.current.name,
          os: process.platform,
          arch: process.arch === 'x64' ? 'x64' : process.arch,
          kind: configRef.current.kind,
          ...(configRef.current.locationHint ? { locationHint: configRef.current.locationHint } : {}),
        },
        harnesses: detectHarnesses(),
        caps: [...RUNNER_CAPS],
        maxConcurrentSessions: configRef.current.maxConcurrentSessions,
        resume: manager.resumeEntries(),
      }),
      buildRunnerConfig: () => ({
        allowBypassPermissions: configRef.current.allowBypassPermissions,
        redactionEnabled: configRef.current.redactionEnabled,
        remoteClaudeSettingsEnabled: configRef.current.remoteClaudeSettingsEnabled,
      }),
      onHelloAck: async (payload) => {
        await manager.onHelloAck(payload)
        finalizeUpdateIfPending(log)
        // Proactive project.list after hello.ack (04 §8.4).
        void pushProjectList(undefined, true).catch((err) => log.warn({ err: (err as Error).message }, 'project scan failed'))
      },
      replay: (send) => manager.replayOutboxes(send),
      onCommand,
      onEventAck: (payload) => manager.handleEventAck(payload.acks),
      activeSessions: () => manager.activeCount(),
      onFatal: ({ exitCode, message }) => {
        log.info({ exitCode }, message)
        process.stderr.write(`yasui-runner: ${message}\n`)
        void shutdown(exitCode, message, { skipWsClose: true })
      },
    },
  })

  /* ---------- control socket ---------- */

  const control = new ControlServer(controlSocketPath(), {
    status: async (): Promise<DaemonStatus> => ({
      running: true,
      pid: process.pid,
      version: RUNNER_VERSION,
      runnerId: configRef.current.runnerId,
      connected: ws.connected,
      relayUrl: configRef.current.relayUrl,
      sessions: manager.sessionSummaries(),
      outboxDepth: manager.outboxDepth(),
      startedAt: state.startedAt,
      updateAvailable,
      draining: manager.isDraining,
    }),
    stop: async () => {
      void shutdown(0, 'stop requested via control socket')
    },
    reloadConfig: async () => {
      const before = configRef.current
      const fresh = loadConfig({ insecurePerms: opts.insecurePerms })
      configRef.current = fresh
      if (fresh.token !== before.token || fresh.relayUrl !== before.relayUrl) {
        log.info('token/relayUrl changed — reconnecting')
        ws.reconnect()
        return
      }
      if (ws.connected) {
        ws.sendDurable(
          ws.envelope('runner.config', {
            allowBypassPermissions: fresh.allowBypassPermissions,
            redactionEnabled: fresh.redactionEnabled,
            remoteClaudeSettingsEnabled: fresh.remoteClaudeSettingsEnabled,
          }),
        )
        // trustedProjects / roots changes ride on project.list (04 §6).
        if (
          JSON.stringify(fresh.trustedProjects) !== JSON.stringify(before.trustedProjects) ||
          JSON.stringify(fresh.roots) !== JSON.stringify(before.roots)
        ) {
          await pushProjectList(undefined, true)
        }
      }
    },
    rescan: async () => {
      await pushProjectList(undefined, true)
    },
    drain: async (targetVersion) => {
      const target = targetVersion ?? (await checkLatestVersion(configRef.current.update.channel))
      if (!target) throw new Error('no target version available')
      void drainAndUpdate(target, Date.now() + UPDATE_DRAIN_DEFAULT_MS)
    },
  })
  await control.listen()

  /* ---------- periodic work ---------- */

  // Full rescan every 15 min while connected (04 §8.4).
  const rescanTimer = setInterval(() => {
    if (!ws.connected) return
    void pushProjectList().catch((err) => log.debug({ err: (err as Error).message }, 'periodic rescan failed'))
  }, DISCOVERY_RESCAN_MS)
  rescanTimer.unref()

  // Daily auto-update check (04 §12).
  const updateTimer = setInterval(() => {
    void (async () => {
      const latest = await checkLatestVersion(configRef.current.update.channel)
      if (!latest) return
      updateAvailable = latest !== RUNNER_VERSION ? latest : null
      if (updateAvailable && configRef.current.update.auto && isManagedInstall()) {
        void drainAndUpdate(updateAvailable, Date.now() + UPDATE_DRAIN_DEFAULT_MS)
      }
    })()
  }, UPDATE_CHECK_INTERVAL_MS)
  updateTimer.unref()

  /* ---------- shutdown ---------- */

  const shutdown = async (exitCode: number, why: string, flags: { skipWsClose?: boolean } = {}): Promise<never> => {
    if (shuttingDown) {
      // Second signal: exit immediately.
      process.exit(exitCode)
    }
    shuttingDown = true
    log.info({ why }, 'daemon shutting down — draining sessions')
    const deadline = setTimeout(() => {
      log.warn('drain deadline hit — exiting')
      process.exit(exitCode)
    }, STOP_DRAIN_DEADLINE_MS + 2_000)
    deadline.unref()
    try {
      await manager.stopAll('shutdown', STOP_DRAIN_DEADLINE_MS)
    } catch {
      /* best effort */
    }
    if (!flags.skipWsClose) ws.stop(1000, why)
    await control.close()
    try {
      fs.unlinkSync(daemonStatePath())
    } catch {
      /* ignore */
    }
    for (const outbox of outboxes.all()) outbox.close()
    log.info('bye')
    process.exit(exitCode)
  }

  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'))
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception')
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection')
    process.exit(1)
  })

  log.info({ version: RUNNER_VERSION, relayUrl: config.relayUrl, home: path.dirname(daemonStatePath()) }, 'daemon started')
  ws.start()

  // Keep the process alive forever (ws timers may momentarily be the only handles).
  await new Promise(() => {
    /* daemon runs until a shutdown path calls process.exit */
  })
}
