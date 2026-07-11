/**
 * Task tools / legacy TodoWrite → `TodoItem[]` snapshots (05 §5.6).
 *
 * The tracker maintains `Map<taskId, TodoItem>`; after every mutation the mapper emits
 * ONE `todo` event revising the stable per-session id `ev_todos_<sessionId>` with the
 * full ordered list. Task tool calls never also produce `tool` events.
 *
 * Input is read defensively — the stream shows the raw model emission
 * (`taskId`/`id`/`task_id`; sdk-sessions §6), and tool_result payload shapes are only
 * partially documented (`TaskCreate` → `{ task: { id, subject } }`).
 */

import type { TodoItem } from '@yasui.io/runner-protocol'

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])

type TodoStatus = TodoItem['status']

function mapStatus(value: unknown): TodoStatus {
  if (value === 'completed') return 'completed'
  if (value === 'in_progress') return 'in_progress'
  return 'pending'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Best-effort structured parse of a tool_result payload (object, JSON text, or blocks). */
function parseResultValue(response: unknown): unknown {
  if (response !== null && typeof response === 'object' && !Array.isArray(response)) {
    // hook tool_response sometimes wraps content: try the carrier itself first
    return response
  }
  const text =
    typeof response === 'string'
      ? response
      : Array.isArray(response)
        ? response
            .map((b) => (asRecord(b)?.type === 'text' ? str(asRecord(b)?.text) : ''))
            .join('\n')
        : ''
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function isTaskTool(name: string): boolean {
  return TASK_TOOLS.has(name)
}

export class TaskTracker {
  private tasks = new Map<string, TodoItem>()
  /** TaskCreate tool_use id → subject (the task id is NOT in the input, only the result). */
  private pendingCreates = new Map<string, string>()
  /** TaskList tool_use ids awaiting a resync result. */
  private pendingLists = new Set<string>()

  readonly eventId: string

  constructor(sessionId: string) {
    this.eventId = `ev_todos_${sessionId}`
  }

  snapshot(): TodoItem[] {
    return [...this.tasks.values()]
  }

  /**
   * Handle an assistant tool_use block for a task tool.
   * Returns the new snapshot when the list changed, else null.
   */
  handleToolUse(name: string, toolUseId: string, input: Record<string, unknown>): TodoItem[] | null {
    switch (name) {
      case 'TaskCreate': {
        this.pendingCreates.set(toolUseId, str(input.subject) || str(input.description))
        return null // inserted when the result delivers the id
      }
      case 'TaskUpdate': {
        const id = str(input.taskId) || str(input.id) || str(input.task_id)
        if (!id) return null
        const status = input.status
        if (status === 'deleted') {
          return this.tasks.delete(id) ? this.snapshot() : null
        }
        const existing = this.tasks.get(id)
        const text = str(input.subject) || existing?.text || id
        this.tasks.set(id, {
          id,
          text,
          status: status === undefined && existing ? existing.status : mapStatus(status),
        })
        return this.snapshot()
      }
      case 'TaskList': {
        this.pendingLists.add(toolUseId)
        return null
      }
      case 'TaskGet':
        return null
      case 'TodoWrite': {
        // Legacy full-list rewrite: input.todos[] { content, status, activeForm }.
        const todos = Array.isArray(input.todos) ? input.todos : null
        if (!todos) return null
        this.tasks.clear()
        todos.forEach((raw, idx) => {
          const rec = asRecord(raw)
          if (!rec) return
          const id = `todo_${idx}`
          this.tasks.set(id, { id, text: str(rec.content), status: mapStatus(rec.status) })
        })
        return this.snapshot()
      }
      default:
        return null
    }
  }

  /**
   * Handle a tool_result for a previously-seen task tool call (hook `tool_response`
   * or user-message tool_result carrier — both are routed here; first one wins).
   */
  handleToolResult(toolUseId: string, response: unknown): TodoItem[] | null {
    if (this.pendingCreates.has(toolUseId)) {
      const subject = this.pendingCreates.get(toolUseId) as string
      this.pendingCreates.delete(toolUseId)
      const parsed = asRecord(parseResultValue(response))
      const task = asRecord(parsed?.task)
      // Fallback id when the payload is unparseable: the tool_use id is stable and
      // unique — an honest degradation, later TaskUpdates by real id insert anew.
      const id = str(task?.id) || str(parsed?.id) || toolUseId
      const text = str(task?.subject) || subject || id
      this.tasks.set(id, { id, text, status: 'pending' })
      return this.snapshot()
    }
    if (this.pendingLists.has(toolUseId)) {
      this.pendingLists.delete(toolUseId)
      const parsed = parseResultValue(response)
      const rec = asRecord(parsed)
      const arr = Array.isArray(parsed)
        ? (parsed as unknown[])
        : rec && Array.isArray(rec.tasks)
          ? (rec.tasks as unknown[])
          : null
      if (!arr) return null // unparseable — keep the current map
      this.tasks.clear()
      for (const raw of arr) {
        const rec = asRecord(raw)
        if (!rec) continue
        const id = str(rec.id) || str(rec.taskId) || str(rec.task_id)
        if (!id) continue
        this.tasks.set(id, {
          id,
          text: str(rec.subject) || str(rec.text) || str(rec.content) || id,
          status: mapStatus(rec.status),
        })
      }
      return this.snapshot()
    }
    return null
  }

  /** A task tool call failed — drop any pending correlation state for it. */
  handleToolFailure(toolUseId: string): void {
    this.pendingCreates.delete(toolUseId)
    this.pendingLists.delete(toolUseId)
  }
}
