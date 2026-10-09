import type { EngineInterface, Register } from 'claude-code'

// Claude Code stops every Monitor after at most 30 minutes and wakes Claude
// with an expiry notice, which it answers by calling Monitor again: a turn
// and a full context read just to keep a watch going. A watch asked for at
// that maximum is meant to run on, so this mod re-arms it with the same input
// the moment it expires and drops the notice. Shorter watches expire as usual,
// and so does a long one after a day, so Claude gets to look at a watch that
// has stayed quiet for that long.
//
// The re-arm is this plugin's call, not Claude's, so auto mode's classifier has
// no request to judge it by and gives no verdict. The command was approved when
// Claude started the watch, so the plugin approves its own re-arm of it: only
// the exact command it recorded, only while it is re-arming that watch.

const LONG_MS = 1800000
const DAY_MS = 86400000
const PLUGIN = 'monitor-rearm'
const REARMED = `${PLUGIN}: re-armed `

// One <task-notification> carrying a Monitor's expiry notice; group 1 its task id.
const EXPIRY = /<task-notification>\s*<task-id>([^<]+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?\[Monitor expired after [^\]]*\](?:(?!<\/task-notification>)[\s\S])*<\/task-notification>\s*/g

type Watch = { input: Record<string, unknown>; first: string; since: number }

// Long watches by their current task id, and the current id of each watch by
// the id Claude knows it by (its first).
const watches = new Map<string, Watch>()
const current = new Map<string, string>()

// The command of the watch being re-armed right now, while its Monitor call runs.
let rearming: string | undefined

function taskId(res: { result?: unknown }): string | undefined {
  const r = res.result as { taskId?: unknown; persistent?: boolean } | undefined
  return typeof r?.taskId === 'string' && !r.persistent ? r.taskId : undefined
}

async function rearm($: EngineInterface, id: string): Promise<string | undefined> {
  const watch = watches.get(id)
  if (!watch) return undefined
  watches.delete(id)
  if ((await $.clock.now()) - watch.since >= DAY_MS) {
    current.delete(watch.first)
    return undefined
  }
  rearming = String(watch.input.command)
  const res = await $.tool.call({ tool: 'Monitor', ...watch.input } as never).finally(() => {
    rearming = undefined
  })
  const next = taskId(res)
  if (!next) {
    current.delete(watch.first)
    return undefined
  }
  watches.set(next, watch)
  current.set(watch.first, next)
  return `${String(watch.input.description ?? 'Monitor')} (${watch.first})`
}

export const register: Register = on => {
  // Remember each long watch the main conversation starts.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const res = await next(e)
    const { tool, tool_use_id, consent, agentId, ...input } = e as unknown as Record<string, unknown>
    const id = taskId(res)
    if (id && !agentId && Number(input.timeout_ms) >= LONG_MS) {
      watches.set(id, { input, first: id, since: await $.clock.now() })
    }
    return res
  })

  // Approve this plugin's own re-arm: its call, the command it is re-arming.
  // Only an ask turns into an allow, so a deny rule still stops it.
  on('tool.check', { tool: 'Monitor' }, async ($, e, next) => {
    const verdict = await next(e)
    const command = (e.input as { command?: unknown } | undefined)?.command
    const ours = rearming !== undefined && e.tool_use_id && next.origin.plugin === PLUGIN && command === rearming
    if (!ours || verdict.decision !== 'ask') return verdict
    return { decision: 'allow', reason: `${PLUGIN} re-arms a watch Claude started` }
  })

  // Claude still knows a re-armed watch by its first task id.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const asked = (e as unknown as { task_id?: string }).task_id
    const now = asked ? current.get(asked) : undefined
    if (!now) return next(e)
    watches.delete(now)
    current.delete(asked!)
    return next({ ...e, task_id: now } as typeof e)
  })

  // The expiry notice: re-arm and take it out, so no turn starts for it.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    if (!e.text.includes('[Monitor expired after')) return next(e)
    const names: string[] = []
    let kept = e.text
    for (const m of e.text.matchAll(EXPIRY)) {
      const name = await rearm($, m[1]!)
      if (!name) continue
      names.push(name)
      kept = kept.replace(m[0], '')
    }
    if (names.length === 0) return next(e)
    if (kept.trim()) return next({ ...e, text: kept })
    return { drop: REARMED + names.join(', ') }
  })

  // The engine notes the dropped notice in the transcript; say what happened instead.
  on('session.append', { door: 'notice' }, async ($, e, next) => {
    const content = e.message.content
    const text = typeof content === 'string' ? content : content.map(b => ('text' in b ? b.text : '')).join('')
    const at = text.indexOf(REARMED)
    if (at < 0) return next(e)
    const line = `↻ re-armed ${text.slice(at + REARMED.length)}`
    return next({ ...e, message: { ...e.message, content: [{ type: 'text', text: line }] } } as typeof e)
  })
}
