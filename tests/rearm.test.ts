import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const LONG = { description: 'PR checks', command: 'gh pr checks --watch', timeout_ms: 1800000 }

// Stands for the engine's Monitor and TaskStop: hands out task ids in order and
// keeps every call that reached it.
function world(on: On) {
  const seen = { started: [] as Record<string, unknown>[], stopped: [] as string[] }
  let n = 0
  on('tool.call', { tool: 'Monitor' }, ($, e) => {
    const { tool, tool_use_id, ...input } = e as unknown as Record<string, unknown>
    seen.started.push(input)
    return { result: { taskId: `t${++n}`, timeoutMs: Number(input.timeout_ms) } }
  })
  on('tool.call', { tool: 'TaskStop' }, ($, e) => {
    seen.stopped.push(String(e.task_id))
    return { result: { message: 'stopped', task_id: String(e.task_id) } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return seen
}

function expiry(id: string): string {
  return `<task-notification>\n<task-id>${id}</task-id>\n<summary>Monitor event: "PR checks"</summary>\n<event>[Monitor expired after 30m with no events delivered. Re-arm it if you still need the watch.]</event>\n</task-notification>`
}

function event(id: string): string {
  return `<task-notification>\n<task-id>${id}</task-id>\n<summary>Monitor event: "logs"</summary>\n<event>ERROR boom</event>\n</task-notification>`
}

function notify($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
}

test('an expired long watch is re-armed with the same input and no turn starts', async ($, on) => {
  mock.clock(on)
  const seen = world(on)
  await $.tool.call({ tool: 'Monitor', ...LONG })

  const res = await notify($, expiry('t1'))

  expect(res).toEqual({ drop: 'monitor-rearm: re-armed PR checks (t1)' })
  expect(seen.started).toEqual([LONG, LONG])
})

test('it keeps re-arming the watch under its new task ids', async ($, on) => {
  mock.clock(on)
  const seen = world(on)
  await $.tool.call({ tool: 'Monitor', ...LONG })
  await notify($, expiry('t1'))
  const res = await notify($, expiry('t2'))

  expect(res).toEqual({ drop: 'monitor-rearm: re-armed PR checks (t1)' })
  expect(seen.started.length).toBe(3)
})

test('a short watch expires as usual', async ($, on) => {
  mock.clock(on)
  const seen = world(on)
  await $.tool.call({ tool: 'Monitor', ...LONG, timeout_ms: 300000 })

  const res = await notify($, expiry('t1'))

  expect(res.text).toBe(expiry('t1'))
  expect(seen.started.length).toBe(1)
})

test('after a day the expiry reaches Claude', async ($, on) => {
  const clock = mock.clock(on)
  const seen = world(on)
  await $.tool.call({ tool: 'Monitor', ...LONG })
  await clock.advance(86400000)

  const res = await notify($, expiry('t1'))

  expect(res.text).toBe(expiry('t1'))
  expect(seen.started.length).toBe(1)
})

test('other notifications delivered with an expiry still reach Claude', async ($, on) => {
  mock.clock(on)
  world(on)
  await $.tool.call({ tool: 'Monitor', ...LONG })

  const res = await notify($, `${expiry('t1')}\n${event('t9')}`)

  expect(res.text).toBe(event('t9'))
})

test('TaskStop with the first task id stops the re-armed watch', async ($, on) => {
  mock.clock(on)
  const seen = world(on)
  await $.tool.call({ tool: 'Monitor', ...LONG })
  await notify($, expiry('t1'))

  await $.tool.call({ tool: 'TaskStop', task_id: 't1' })
  const after = await notify($, expiry('t2'))

  expect(seen.stopped).toEqual(['t2'])
  expect(after.text).toBe(expiry('t2'))
})

test('a Monitor check that is not the re-arm gets the usual verdict', async ($, on) => {
  mock.clock(on)
  on('tool.check', () => ({ decision: 'ask' }))
  let release!: () => void
  let started!: () => void
  const midway = new Promise<void>(resolve => (started = resolve))
  let n = 0
  on('tool.call', { tool: 'Monitor' }, async () => {
    if (++n > 1) {
      started()
      await new Promise<void>(resolve => (release = resolve))
    }
    return { result: { taskId: `t${n}`, timeoutMs: 1800000 } }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.tool.call({ tool: 'Monitor', ...LONG })
  const check = { tool: 'Monitor', input: { command: LONG.command }, tool_use_id: 'u9' }

  const before = await $.tool.check(check)
  const rearm = notify($, expiry('t1'))
  await midway
  const during = await $.tool.check(check)
  release()
  await rearm

  expect(before.decision).toBe('ask')
  expect(during.decision).toBe('ask')
})

test('the dropped-notice row says what was re-armed', async ($, on) => {
  let stored: unknown
  on('session.append', ($, e, next) => {
    stored = e.message.content
    return next(e)
  })
  await $.session.append({
    message: { type: 'system', content: [{ type: 'text', text: 'Prompt dropped by a hook: monitor-rearm: re-armed PR checks (t1)' }] },
    door: 'notice',
    origin: { kind: 'engine' },
    uuid: 'u1',
  } as never)

  expect(stored).toEqual([{ type: 'text', text: '↻ re-armed PR checks (t1)' }])
})
