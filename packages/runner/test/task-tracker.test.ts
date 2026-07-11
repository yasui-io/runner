/**
 * task-tracker tests: all four §5.6 paths (TaskCreate result-id insert, TaskUpdate
 * defensive patch, TaskList resync, legacy TodoWrite rewrite).
 */

import { describe, expect, it } from 'vitest'
import { TaskTracker, isTaskTool } from '../src/sessions/claude/task-tracker'

describe('TaskTracker', () => {
  it('exposes the stable per-session event id', () => {
    expect(new TaskTracker('ags_x').eventId).toBe('ev_todos_ags_x')
  })

  it('TaskCreate: id arrives in the tool_result, not the input', () => {
    const t = new TaskTracker('s')
    expect(t.handleToolUse('TaskCreate', 'toolu_1', { subject: 'Do the thing' })).toBeNull()
    const snap = t.handleToolResult('toolu_1', { task: { id: '42', subject: 'Do the thing' } })
    expect(snap).toEqual([{ id: '42', text: 'Do the thing', status: 'pending' }])
  })

  it('TaskCreate: JSON-text result payloads parse; unparseable falls back to the tool_use id', () => {
    const t = new TaskTracker('s')
    t.handleToolUse('TaskCreate', 'toolu_j', { subject: 'From JSON' })
    const snap = t.handleToolResult('toolu_j', '{"task":{"id":"9","subject":"From JSON"}}')
    expect(snap).toEqual([{ id: '9', text: 'From JSON', status: 'pending' }])

    t.handleToolUse('TaskCreate', 'toolu_k', { subject: 'Opaque' })
    const snap2 = t.handleToolResult('toolu_k', 'Created task successfully.')
    expect(snap2).toContainEqual({ id: 'toolu_k', text: 'Opaque', status: 'pending' })
  })

  it('TaskUpdate: reads taskId/id/task_id defensively; status deleted removes', () => {
    const t = new TaskTracker('s')
    t.handleToolUse('TaskCreate', 'toolu_1', { subject: 'A' })
    t.handleToolResult('toolu_1', { task: { id: '1', subject: 'A' } })

    let snap = t.handleToolUse('TaskUpdate', 'toolu_2', { taskId: '1', status: 'in_progress' })
    expect(snap).toEqual([{ id: '1', text: 'A', status: 'in_progress' }])

    snap = t.handleToolUse('TaskUpdate', 'toolu_3', { id: '1', subject: 'A renamed' })
    expect(snap).toEqual([{ id: '1', text: 'A renamed', status: 'in_progress' }])

    snap = t.handleToolUse('TaskUpdate', 'toolu_4', { task_id: '1', status: 'completed' })
    expect(snap).toEqual([{ id: '1', text: 'A renamed', status: 'completed' }])

    snap = t.handleToolUse('TaskUpdate', 'toolu_5', { taskId: '1', status: 'deleted' })
    expect(snap).toEqual([])

    // deleting an unknown id emits nothing
    expect(t.handleToolUse('TaskUpdate', 'toolu_6', { taskId: 'nope', status: 'deleted' })).toBeNull()
    // missing id entirely emits nothing
    expect(t.handleToolUse('TaskUpdate', 'toolu_7', { status: 'completed' })).toBeNull()
  })

  it('TaskUpdate on an unseen id inserts (stream may outrun our map)', () => {
    const t = new TaskTracker('s')
    const snap = t.handleToolUse('TaskUpdate', 'toolu_1', { taskId: '5', status: 'in_progress', subject: 'Ghost' })
    expect(snap).toEqual([{ id: '5', text: 'Ghost', status: 'in_progress' }])
  })

  it('TaskList: full resync of the map from the result', () => {
    const t = new TaskTracker('s')
    t.handleToolUse('TaskCreate', 'toolu_1', { subject: 'Stale' })
    t.handleToolResult('toolu_1', { task: { id: 'old', subject: 'Stale' } })

    expect(t.handleToolUse('TaskList', 'toolu_2', {})).toBeNull()
    const snap = t.handleToolResult('toolu_2', {
      tasks: [
        { id: '1', subject: 'One', status: 'completed' },
        { id: '2', subject: 'Two', status: 'in_progress' },
        { id: '3', subject: 'Three', status: 'pending' },
      ],
    })
    expect(snap).toEqual([
      { id: '1', text: 'One', status: 'completed' },
      { id: '2', text: 'Two', status: 'in_progress' },
      { id: '3', text: 'Three', status: 'pending' },
    ])
  })

  it('TaskList: bare-array results also resync; unparseable results keep the map', () => {
    const t = new TaskTracker('s')
    t.handleToolUse('TaskList', 'toolu_1', {})
    expect(t.handleToolResult('toolu_1', [{ id: 'a', subject: 'A', status: 'pending' }])).toBeNull()
    // arrays route through the text path and fail to parse — map unchanged
    t.handleToolUse('TaskList', 'toolu_2', {})
    const snap = t.handleToolResult('toolu_2', '[{"id":"a","subject":"A","status":"pending"}]')
    expect(snap).toEqual([{ id: 'a', text: 'A', status: 'pending' }])
  })

  it('legacy TodoWrite: wholesale replace with synthetic todo_<idx> ids', () => {
    const t = new TaskTracker('s')
    let snap = t.handleToolUse('TodoWrite', 'toolu_1', {
      todos: [
        { content: 'first', status: 'completed', activeForm: 'doing first' },
        { content: 'second', status: 'in_progress', activeForm: 'doing second' },
        { content: 'third', status: 'pending', activeForm: 'doing third' },
      ],
    })
    expect(snap).toEqual([
      { id: 'todo_0', text: 'first', status: 'completed' },
      { id: 'todo_1', text: 'second', status: 'in_progress' },
      { id: 'todo_2', text: 'third', status: 'pending' },
    ])

    snap = t.handleToolUse('TodoWrite', 'toolu_2', {
      todos: [{ content: 'only', status: 'pending', activeForm: 'x' }],
    })
    expect(snap).toEqual([{ id: 'todo_0', text: 'only', status: 'pending' }])
  })

  it('unknown statuses map to pending; TaskGet and unknown tools are inert', () => {
    const t = new TaskTracker('s')
    const snap = t.handleToolUse('TodoWrite', 'toolu_1', {
      todos: [{ content: 'weird', status: 'someday' }],
    })
    expect(snap).toEqual([{ id: 'todo_0', text: 'weird', status: 'pending' }])
    expect(t.handleToolUse('TaskGet', 'toolu_2', { taskId: '1' })).toBeNull()
    expect(t.handleToolUse('Bash', 'toolu_3', { command: 'ls' })).toBeNull()
    expect(t.handleToolResult('toolu_never_seen', {})).toBeNull()
  })

  it('handleToolFailure drops pending correlation state', () => {
    const t = new TaskTracker('s')
    t.handleToolUse('TaskCreate', 'toolu_1', { subject: 'Doomed' })
    t.handleToolFailure('toolu_1')
    expect(t.handleToolResult('toolu_1', { task: { id: '1', subject: 'Doomed' } })).toBeNull()
    expect(t.snapshot()).toEqual([])
  })
})

describe('isTaskTool', () => {
  it('covers the five task-shaped tools only', () => {
    for (const name of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite']) {
      expect(isTaskTool(name)).toBe(true)
    }
    expect(isTaskTool('Task')).toBe(false) // that one is the subagent tool (§5.7)
    expect(isTaskTool('Bash')).toBe(false)
  })
})
