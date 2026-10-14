import type { EngineInterface, Register } from 'claude-code'

// Claude Code stops every Monitor after at most 30 minutes and wakes Claude
// with an expiry notice, which it answers by calling Monitor again: a turn
// and a full context read just to keep a watch going. A watch asked for at
// that maximum is meant to run on, so this mod keeps it going itself: a minute
// before the watch would expire it stops it and starts the same watch again,
// so no notice is sent and nothing shows in the session. Shorter watches
// expire as usual, and so does a long one after a day, so Claude gets to look
// at a watch that has stayed quiet for that long. A watch whose command
// exited, or that Claude stopped, is not kept going.
//
// The swap runs on a timer, but a plugin's calls from a timer pass none of its
// own hooks, so it could not approve its own Monitor call. So the timer only
// writes a file the session watches (registered at SessionStart), and the swap
// runs in the hook for the engine's FileChanged event.
//
// When the swap did not happen (a session started before the plugin was
// installed, a machine asleep past the expiry), the expiry notice arrives: the
// watch is re-armed then and the notice dropped, which leaves one row in the
// transcript and counts as the session going idle again.
//
// Either way the re-arm is this plugin's call, not Claude's, so auto mode's
// classifier has no request to judge it by and gives no verdict. The command
// was approved when Claude started the watch, so the plugin approves its own
// re-arm of it: only the exact command it recorded, only while it is
// re-arming that watch.

const LONG_MS = 1800000
const DAY_MS = 86400000
// How long before a watch would expire it is swapped for a fresh one.
const LEAD_MS = 60000
const PLUGIN = 'monitor-rearm'
const REARMED = `${PLUGIN}: re-armed `

// One <task-notification> carrying a Monitor's expiry notice; group 1 its task id.
const EXPIRY = /<task-notification>\s*<task-id>([^<]+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?\[Monitor expired after [^\]]*\](?:(?!<\/task-notification>)[\s\S])*<\/task-notification>\s*/g
// One <task-notification> saying its task ended (only those carry a status:
// the command exited, or the task was stopped); group 1 its task id.
const ENDED = /<task-notification>\s*<task-id>([^<]+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?<status>/g

type Watch = { input: Record<string, unknown>; first: string; since: number; due: number }

// Long watches by their current task id, and the current id of each watch by
// the id Claude knows it by (its first).
const watches = new Map<string, Watch>()
const current = new Map<string, string>()

// The command of the watch being re-armed right now, while its Monitor call runs.
let rearming: string | undefined
// The old task of a swapped watch, while the TaskStop call for it runs.
let stopping: string | undefined
// The file this session watches for the swap, once SessionStart registered it.
let bell: string | undefined

function taskId(res: { result?: unknown }): string | undefined {
  const r = res.result as { taskId?: unknown; persistent?: boolean } | undefined
  return typeof r?.taskId === 'string' && !r.persistent ? r.taskId : undefined
}

// Stops keeping the watch whose current task id this is.
function forget(id: string) {
  const watch = watches.get(id)
  if (!watch) return
  watches.delete(id)
  current.delete(watch.first)
}

// Asks for the swap once a watch is due: the write fires FileChanged.
function ring($: EngineInterface, ms: number) {
  if (!bell) return
  const path = bell
  $.clock.after(ms, () => {
    void $.clock
      .now()
      .then(now => $.fs.write(path, String(now)))
      .catch(() => undefined)
  })
}

// Starts the watch again with the same input; resolves its new task id, or
// undefined once it is no longer kept (a day old, or the call failed).
async function restart($: EngineInterface, id: string): Promise<string | undefined> {
  const watch = watches.get(id)
  if (!watch) return undefined
  watches.delete(id)
  const now = await $.clock.now()
  if (now - watch.since >= DAY_MS) {
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
  const timeout = Number(watch.input.timeout_ms)
  watches.set(next, { ...watch, due: now + timeout - LEAD_MS })
  current.set(watch.first, next)
  ring($, timeout - LEAD_MS)
  return next
}

// Stops every watch that is due and starts it again: the old one never
// expires, so no notice is sent. A watch whose command already exited (a PR
// merged, a build done) cannot be stopped and is not started again, or it
// would report its last state anew.
async function swap($: EngineInterface) {
  const now = await $.clock.now()
  for (const [id, watch] of [...watches]) {
    if (watch.due > now + 1000 || now - watch.since >= DAY_MS) continue
    stopping = id
    const res = await $.tool.call({ tool: 'TaskStop', task_id: id } as never).finally(() => {
      stopping = undefined
    })
    if (res.deny !== undefined || res.isError) {
      forget(id)
      continue
    }
    if (await restart($, id)) continue
    // A FileChanged hook may not submit a prompt (it could wait on the turn the
    // hook holds), so it is sent once the hook is done.
    const text = `${PLUGIN} stopped the watch "${String(watch.input.description ?? 'Monitor')}" (${watch.first}) to restart it before it expired, but could not start it again. Start it again if it is still needed.`
    $.clock.after(0, () => {
      void $.prompt.submit({ text }).catch(() => undefined)
    })
  }
}

export const register: Register = on => {
  // Have the session watch this plugin's file, so its timer can reach a hook.
  on('classic.SessionStart', async ($, e, next) => {
    const res = await next(e)
    const path = `/tmp/${PLUGIN}/${e.session_id}`
    try {
      await $.fs.write(path, '')
    } catch {
      return res
    }
    bell = path
    return { ...res, watchPaths: [...(res.watchPaths ?? []), path] }
  })

  on('classic.FileChanged', async ($, e, next) => {
    if (!bell || e.file_path !== bell) return next(e)
    await swap($).catch(() => undefined)
    return {}
  })

  // Remember each long watch the main conversation starts.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const res = await next(e)
    const { tool, tool_use_id, consent, agentId, ...input } = e as unknown as Record<string, unknown>
    const id = taskId(res)
    const timeout = Number(input.timeout_ms)
    if (id && !agentId && rearming === undefined && timeout >= LONG_MS) {
      const now = await $.clock.now()
      watches.set(id, { input, first: id, since: now, due: now + timeout - LEAD_MS })
      ring($, timeout - LEAD_MS)
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

  // A re-arm is no work of Claude's, so the settings PostToolUse hooks don't hear
  // of it: a status hook would mark the idle session busy, with no Stop to follow.
  function ours(e: { tool_name: string; tool_input: unknown }): boolean {
    const input = e.tool_input as { command?: unknown; task_id?: unknown } | undefined
    if (rearming !== undefined && e.tool_name === 'Monitor' && input?.command === rearming) return true
    return stopping !== undefined && e.tool_name === 'TaskStop' && input?.task_id === stopping
  }
  on('classic.PostToolUse', async ($, e, next) => (ours(e) ? {} : next(e)))
  on('classic.PostToolUseFailure', async ($, e, next) => (ours(e) ? {} : next(e)))

  // Claude still knows a re-armed watch by its first task id, and its events
  // name the current one: either stops it.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    if (stopping !== undefined) return next(e)
    const asked = (e as unknown as { task_id?: string }).task_id
    if (!asked) return next(e)
    const now = current.get(asked) ?? asked
    forget(now)
    return now === asked ? next(e) : next({ ...e, task_id: now } as typeof e)
  })

  // The expiry notice of a watch that was not swapped in time: re-arm it and
  // take the notice out, so no turn starts for it. A watch that ended on its
  // own is not kept any longer.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    for (const m of e.text.matchAll(ENDED)) forget(m[1]!)
    if (!e.text.includes('[Monitor expired after')) return next(e)
    const names: string[] = []
    let kept = e.text
    for (const m of e.text.matchAll(EXPIRY)) {
      const watch = watches.get(m[1]!)
      if (!(await restart($, m[1]!)) || !watch) continue
      names.push(`${String(watch.input.description ?? 'Monitor')} (${watch.first})`)
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