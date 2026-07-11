/**
 * Harness adapter registry (04 §8.3): `claude-code` → ClaudeCodeAdapter.
 *
 * The single place that references a concrete adapter — everything else
 * codes against the HarnessAdapter interface. The import is dynamic and
 * fault-isolated: a broken/missing adapter module must degrade to
 * `yasui_runner_harness_unavailable` at session.start (SessionManager),
 * never crash the daemon at boot.
 */

import type { HarnessId } from '@yasui.io/runner-protocol'
import type { Logger } from '../log/logger.js'
import type { HarnessAdapter } from './harness-adapter.js'

export type AdapterFactories = Partial<Record<HarnessId, () => HarnessAdapter>>

export async function loadAdapterFactories(log: Logger): Promise<AdapterFactories> {
  const factories: AdapterFactories = {}
  try {
    const mod = (await import('./claude/claude-adapter.js')) as {
      ClaudeCodeAdapter: new (opts?: { logger?: Logger }) => HarnessAdapter
    }
    // A pino child satisfies the adapter's structural AdapterLogger (obj-first
    // call form — see sessions/claude/support.ts); without it the adapter runs
    // on the noop logger and claude stderr/restart/backstop diagnostics vanish.
    const adapterLog = log.child({ component: 'claude-adapter' })
    factories['claude-code'] = () => new mod.ClaudeCodeAdapter({ logger: adapterLog })
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'claude-code adapter unavailable — sessions for it will be refused')
  }
  return factories
}
