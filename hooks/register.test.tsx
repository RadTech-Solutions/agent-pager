import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

type Call = { url: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string> }
type Reply = string | { status: number; text: string }

const NTFY = { backend: 'ntfy', ntfy_topic: 'pager-test-topic', min_gap_seconds: 0 }
const NTFY_IN = { ...NTFY, ntfy_inbound: true, ntfy_token: 'tk_secret' }
const TG = { backend: 'telegram', telegram_token: '123:abc', telegram_chat_id: '42', min_gap_seconds: 0 }

// 2026-03-04 12:00 local time: outside the quiet hours used below.
const NOON = new Date(2026, 2, 4, 12, 0).getTime()
const NIGHT = new Date(2026, 2, 4, 23, 30).getTime()
const SEC = NOON / 1000

/**
 * The engine beneath the plugin: a session in /work/shop, an http.fetch
 * that records every request and answers with `reply`, and a prompt queue.
 */
function engine(on: On, now: number, reply: (url: string) => Reply = () => '{"ok":true,"result":[]}', options: { failRegister?: boolean; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now })
  mock.store(on, options.store ?? {})
  let sessionId = 'session-a'
  const calls: Call[] = []
  const prompts: string[] = []
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.id', () => ({ value: sessionId }))
  on('session.model', () => ({ value: 'test-model' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => {
    if (options.failRegister) throw new Error('registration refused')
    return { value: { command: 'pager' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('http.fetch', ($, e) => {
    const init = e.init ?? {}
    calls.push({
      url: e.url,
      method: init.method ?? 'GET',
      body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: init.headers ?? {},
    })
    const r = reply(e.url)
    const { status, text } = typeof r === 'string' ? { status: 200, text: r } : r
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
  const sent = () => calls.filter(c => c.method === 'POST')
  // Pages from turn.complete and notifications are sent without awaiting:
  // let that work land before asserting.
  const settle = () => clock.advance(0)
  const switchSession = (id: string) => {
    sessionId = id
  }
  return { clock, calls, sent, prompts, settle, switchSession }
}

async function finishTurn($: Engine, durationMs: number, answer: string, reason: 'answer' | 'error' | 'aborted' = 'answer', turnId = 't1', agentId?: string) {
  await $.turn.complete({ answer, durationMs, isAborted: reason === 'aborted', turnId, reason, ...(agentId ? { agentId } : {}) })
}

/** /pager listen, then wait out the claim's grace (2 x 5s + 1s). */
async function listen($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await run($, 'listen')
  await clock.advance(11_000)
}

const run = ($: Engine, args: string) => $.command.run({ command: 'pager', args } as Parameters<typeof $.command.run>[0])
const tgMsg = (update_id: number, text: string, extra: { date?: number; chat?: object; from?: object } = {}) => ({
  update_id,
  message: { date: SEC + 1, text, chat: { id: 42, type: 'private' }, from: { id: 42 }, ...extra },
})

const start = { cwd: '/work/shop', surface: 'terminal', isInteractive: true } as const

test('a long turn pages ntfy with the project, the duration and the first 200 characters', { options: NTFY }, async ($, on) => {
  const { sent, settle } = engine(on, NOON)
  await $.session.start(start)

  await finishTurn($, 5_000, 'quick answer')
  await settle()
  expect(sent()).toHaveLength(0)

  const long = 'Refactored the billing module. ' + 'x'.repeat(400)
  await finishTurn($, 125_000, long)
  await settle()
  expect(sent()).toHaveLength(1)
  const p = sent()[0]!
  expect(p.url).toBe('https://ntfy.sh')
  expect(p.body?.topic).toBe('pager-test-topic')
  expect(p.body?.title).toBe('shop: Turn finished (2m 5s)')
  const msg = String(p.body?.message)
  expect(msg.startsWith('Refactored the billing module.')).toBe(true)
  expect(msg.length).toBe(200)
  expect(p.body?.tags).toEqual(['pager-out'])
})

test('telegram: only the owner in a private chat reaches the session, as a queued prompt', { options: TG }, async ($, on) => {
  const updates = {
    ok: true,
    result: [
      tgMsg(10, 'run the tests please'),
      tgMsg(11, 'rm -rf everything', { chat: { id: 666, type: 'private' }, from: { id: 666 } }),
      tgMsg(12, 'stale from before the session', { date: SEC - 600 }),
      tgMsg(13, 'from a group with the same id', { chat: { id: 42, type: 'group' } }),
      tgMsg(14, 'someone else in the chat', { from: { id: 7 } }),
    ],
  }
  let served = false
  const { clock, calls, sent, prompts } = engine(on, NOON, url => {
    if (url.includes('/getUpdates') && !served) {
      served = true
      return JSON.stringify(updates)
    }
    return '{"ok":true,"result":[]}'
  })
  await $.session.start(start)
  await listen($, clock)
  await clock.advance(5_000)

  expect(calls[0]!.url).toContain('https://api.telegram.org/bot123:abc/getUpdates?timeout=0&offset=0')
  expect(prompts).toEqual(['run the tests please'])
  const replies = sent()
  expect(replies).toHaveLength(1)
  expect(replies[0]!.url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
  expect(replies[0]!.body?.chat_id).toBe('42')
  expect(String(replies[0]!.body?.text)).toContain('shop: queued')

  // The next poll asks past the last update, so nothing is replayed.
  await clock.advance(5_000)
  expect(calls.filter(c => c.url.includes('getUpdates')).at(-1)!.url).toContain('offset=15')
  expect(prompts).toHaveLength(1)
})

test('the phone gets the reply of the turn it started, not a keyboard turn in between', { options: TG }, async ($, on) => {
  let next: object[] = [tgMsg(1, 'summarise the diff')]
  const { clock, sent, prompts, settle } = engine(on, NOON, url => {
    if (!url.includes('/getUpdates')) return '{"ok":true}'
    const r = JSON.stringify({ ok: true, result: next })
    next = []
    return r
  })
  await $.session.start(start)
  await listen($, clock)

  // A keyboard turn is running when the phone's prompt arrives.
  await $.turn.start({ text: 'refactor the parser', turnId: 'kb' })
  await clock.advance(5_000)
  expect(prompts).toEqual(['summarise the diff'])
  expect(String(sent().at(-1)!.body?.text)).toContain('Queued. It runs when the current turn ends.')
  const before = sent().length

  // The keyboard turn ends short: nothing goes to the phone.
  await finishTurn($, 3_000, 'parser refactored', 'answer', 'kb')
  await settle()
  expect(sent()).toHaveLength(before)

  // The phone's turn runs and ends short: its reply goes back anyway.
  await $.turn.start({ text: 'summarise the diff', turnId: 'ph' })
  await finishTurn($, 2_000, 'Two files changed.', 'answer', 'ph')
  await settle()
  expect(sent()).toHaveLength(before + 1)
  expect(sent().at(-1)!.body?.text).toBe('shop: Turn finished (2s)\nTwo files changed.')

  // A later short keyboard turn stays quiet.
  await $.turn.start({ text: 'thanks', turnId: 'kb2' })
  await finishTurn($, 1_000, 'welcome', 'answer', 'kb2')
  await settle()
  expect(sent()).toHaveLength(before + 1)
})

test('telegram /status and /stop from the phone', { options: TG }, async ($, on) => {
  let next: object[] = [tgMsg(1, '/status', { date: SEC + 5 })]
  const { clock, sent, prompts, settle } = engine(on, NOON, url => {
    if (!url.includes('/getUpdates')) return '{"ok":true}'
    const r = JSON.stringify({ ok: true, result: next })
    next = []
    return r
  })
  await $.session.start(start)
  await listen($, clock)
  await clock.advance(5_000)
  expect(prompts).toHaveLength(0)
  const status = String(sent().at(-1)!.body?.text)
  expect(status).toContain('Session shop: idle')
  expect(status).toContain('Model test-model, 3 turns')

  next = [tgMsg(2, '/stop', { date: SEC + 10 })]
  await clock.advance(5_000)
  expect(String(sent().at(-1)!.body?.text)).toContain('paused')
  const before = sent().length
  await finishTurn($, 300_000, 'long work done')
  await settle()
  expect(sent()).toHaveLength(before)
})

test('a subagent turn ending does not mark the session idle', { options: TG }, async ($, on) => {
  let next: object[] = []
  const { clock, sent } = engine(on, NOON, url => {
    if (!url.includes('/getUpdates')) return '{"ok":true}'
    const r = JSON.stringify({ ok: true, result: next })
    next = []
    return r
  })
  await $.session.start(start)
  await listen($, clock)
  await $.turn.start({ text: 'big job', turnId: 'main' })
  await finishTurn($, 400_000, 'subagent report', 'answer', 'sub1', 'agent-1')
  next = [tgMsg(1, '/status', { date: SEC + 5 })]
  await clock.advance(5_000)
  expect(String(sent().at(-1)!.body?.text)).toContain('Session shop: working')
})

test('telegram rate limit: honours retry_after, shows the error with the token redacted', { options: TG }, async ($, on) => {
  let limited = true
  const { clock, calls } = engine(on, NOON, url => {
    if (url.includes('/getUpdates') && limited) {
      return { status: 429, text: JSON.stringify({ ok: false, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } }) }
    }
    return '{"ok":true,"result":[]}'
  })
  await $.session.start(start)
  await listen($, clock)
  await clock.advance(5_000)
  const polls = () => calls.filter(c => c.url.includes('getUpdates')).length
  expect(polls()).toBe(1)
  limited = false
  await clock.advance(20_000)
  expect(polls()).toBe(1)
  const { text } = await run($, 'status')
  expect(text).toContain('Last poll error')
  expect(text).toContain('telegram answered 429: Too Many Requests')
  expect(text).not.toContain('123:abc')
  await clock.advance(10_000)
  expect(polls()).toBe(2)
})

test('failing polls back off exponentially, capped at five minutes', { options: { ...TG, poll_seconds: 5 } }, async ($, on) => {
  const { clock, calls } = engine(on, NOON, url => (url.includes('/getUpdates') ? { status: 502, text: 'bad gateway' } : '{"ok":true}'))
  await $.session.start(start)
  await listen($, clock)
  const polls = () => calls.filter(c => c.url.includes('getUpdates')).length
  await clock.advance(5_000)
  expect(polls()).toBe(1)
  // Waits 10s, then 20s, 40s, ...
  await clock.advance(10_000)
  expect(polls()).toBe(2)
  await clock.advance(10_000)
  expect(polls()).toBe(2)
  await clock.advance(10_000)
  expect(polls()).toBe(3)
  await clock.advance(3_600_000)
  const after = polls()
  await clock.advance(300_000)
  expect(polls()).toBe(after + 1)
})

test('the poller still starts when registering /pager fails', { options: TG }, async ($, on) => {
  const { clock, calls } = engine(on, NOON, undefined, { failRegister: true })
  await $.session.start(start)
  await listen($, clock)
  await clock.advance(5_000)
  expect(calls.filter(c => c.url.includes('getUpdates'))).toHaveLength(1)
})

test('/pager listen confirms after the grace; session end gives the role up', { options: TG }, async ($, on) => {
  const { clock, calls } = engine(on, NOON)
  const polls = () => calls.filter(c => c.url.includes('getUpdates')).length
  await $.session.start(start)
  await clock.advance(20_000)
  expect(polls()).toBe(0)
  expect((await run($, 'status')).text).toContain('no session is listening')

  expect((await run($, 'listen')).text).toContain('claimed the receiver role')
  expect((await run($, 'status')).text).toContain('confirming within')
  await clock.advance(10_000)
  expect(polls()).toBe(0)
  await clock.advance(5_000)
  expect(polls()).toBe(1)
  expect((await run($, 'status')).text).toContain('this session is the receiver')

  await $.session.end({ reason: 'other', sessionId: 'session-a' } as Parameters<typeof $.session.end>[0])
  expect((await run($, 'status')).text).toContain('no session is listening')
})

test('another session claiming the role stops this one', { options: TG }, async ($, on) => {
  const { clock, calls, switchSession } = engine(on, NOON)
  const polls = () => calls.filter(c => c.url.includes('getUpdates')).length
  await $.session.start(start)
  await listen($, clock)
  await clock.advance(10_000)
  expect(polls()).toBe(2)
  // Session B runs /pager listen (same store, its own id).
  switchSession('session-b')
  await run($, 'listen')
  switchSession('session-a')
  await clock.advance(20_000)
  expect(polls()).toBe(2)
  expect((await run($, 'status')).text).toContain('go to another session (session-')
})

test('quiet hours hold automatic pages, but /pager test still goes out', { options: { ...NTFY, quiet_hours: '22-07' } }, async ($, on) => {
  const { sent, settle } = engine(on, NIGHT)
  await $.session.start(start)
  await finishTurn($, 300_000, 'done overnight')
  await settle()
  expect(sent()).toHaveLength(0)

  const { text } = await run($, 'test')
  expect(text).toBe('agent-pager: test page sent.')
  expect(sent()).toHaveLength(1)
  expect(sent()[0]!.body?.title).toBe('shop: test page')
})

test('/pager status flags invalid quiet hours', { options: { ...NTFY, quiet_hours: 'nights' } }, async ($, on) => {
  engine(on, NOON)
  await $.session.start(start)
  expect((await run($, 'status')).text).toContain('"nights" is invalid')
})

test('/pager pause and resume; status masks the topic', { options: NTFY }, async ($, on) => {
  const { sent, settle } = engine(on, NOON)
  await $.session.start(start)

  expect((await run($, 'pause')).text).toContain('paused')
  await finishTurn($, 300_000, 'one')
  await settle()
  expect(sent()).toHaveLength(0)
  expect((await run($, '')).text).toContain('Paging paused')

  expect((await run($, 'resume')).text).toContain('on')
  await finishTurn($, 300_000, 'two')
  await settle()
  expect(sent()).toHaveLength(1)
  const status = (await run($, 'status')).text
  expect(status).toContain('pages go to ntfy topic "page************"')
  expect(status).not.toContain('pager-test-topic')
})

test('the minimum gap drops routine pages but never a permission or question page', { options: { ...NTFY, min_gap_seconds: 60 } }, async ($, on) => {
  const { clock, sent, settle } = engine(on, NOON)
  await $.session.start(start)
  await finishTurn($, 300_000, 'one')
  await settle()
  await clock.advance(30_000)
  await finishTurn($, 300_000, 'two')
  await settle()
  expect(sent()).toHaveLength(1)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await settle()
  expect(sent()).toHaveLength(2)
  await clock.advance(61_000)
  await finishTurn($, 300_000, 'three')
  await settle()
  expect(sent()).toHaveLength(3)
})

test('private mode sends only that the agent needs you', { options: { ...NTFY, private_mode: true } }, async ($, on) => {
  const { sent, settle } = engine(on, NOON)
  await $.session.start(start)
  await finishTurn($, 300_000, 'secret customer data in the reply')
  await settle()
  expect(sent()[0]!.body).toEqual({ topic: 'pager-test-topic', title: 'agent-pager', message: 'Your agent needs you.', tags: ['pager-out'], priority: 3 })
})

test('an unanswered question pages after the delay; one answered in time does not', { options: NTFY }, async ($, on) => {
  const { clock, sent, settle } = engine(on, NOON)
  let wait = 0
  on('tool.call', async () => {
    await clock.advance(wait)
    return { result: { questions: [], answers: {} } as never }
  })
  await $.session.start(start)
  const ask = {
    tool: 'AskUserQuestion',
    tool_use_id: 'tu1',
    questions: [{ question: 'Which database?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }],
  }

  wait = 3_000
  await $.tool.call(ask as never)
  await settle()
  expect(sent()).toHaveLength(0)

  wait = 12_000
  await $.tool.call(ask as never)
  await settle()
  expect(sent()).toHaveLength(1)
  expect(sent()[0]!.body?.title).toBe('shop: Question waiting')
  expect(sent()[0]!.body?.message).toBe('Which database? Options: Postgres / SQLite')
  expect(sent()[0]!.body?.priority).toBe(4)
})

test('a permission prompt notification and an error each page', { options: NTFY }, async ($, on) => {
  const { sent, settle } = engine(on, NOON)
  await $.session.start(start)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await settle()
  expect(sent()[0]!.body?.title).toBe('shop: Permission needed')
  expect(String(sent()[0]!.body?.message)).toContain('needs your permission to use Bash')

  await $.classic.Notification({ message: 'idle', notification_type: 'idle_prompt' })
  await settle()
  expect(sent()).toHaveLength(1)

  await finishTurn($, 1_000, 'API Error: overloaded', 'error')
  await settle()
  expect(sent()[1]!.body?.title).toBe('shop: Turn ended on an error (1s)')
})

test('ntfy inbound skips its own pages and anything older than the session', { options: NTFY_IN }, async ($, on) => {
  const lines = [
    { id: 'old1', time: SEC - 3600, event: 'message', message: 'yesterday: delete the branch' },
    { id: 'a1', time: SEC + 1, event: 'message', message: 'shop: Turn finished', tags: ['pager-out'] },
    { id: 'a2', time: SEC + 2, event: 'message', message: 'also update the changelog' },
  ]
  let served = false
  // A cursor left by an earlier session reaches back before this one.
  const { clock, calls, prompts } = engine(
    on,
    NOON,
    url => {
      if (url.includes('/json?poll=1') && !served) {
        served = true
        return lines.map(l => JSON.stringify(l)).join('\n')
      }
      return ''
    },
    { store: { 'ntfySince:pager-test-topic': 'old0' } },
  )
  await $.session.start(start)
  await listen($, clock)
  await clock.advance(5_000)
  expect(calls[0]!.url).toBe('https://ntfy.sh/pager-test-topic/json?poll=1&since=old0')
  expect(calls[0]!.headers.authorization).toBe('Bearer tk_secret')
  expect(prompts).toEqual(['also update the changelog'])
  await clock.advance(5_000)
  expect(calls.filter(c => c.url.includes('/json?poll=1')).at(-1)!.url).toContain('since=a2')
})

test('ntfy inbound refuses to run without an access token', { options: { ...NTFY, ntfy_inbound: true } }, async ($, on) => {
  const { clock, calls } = engine(on, NOON)
  await $.session.start(start)
  await clock.advance(20_000)
  expect(calls).toHaveLength(0)
  expect((await run($, 'status')).text).toContain('Replies from the phone off (ntfy_inbound needs ntfy_token')
  expect((await run($, 'listen')).text).toContain('cannot listen (ntfy_inbound needs ntfy_token')
})

test('with ntfy inbound off, nothing is polled', { options: NTFY }, async ($, on) => {
  const { clock, calls } = engine(on, NOON)
  await $.session.start(start)
  await clock.advance(20_000)
  expect(calls).toHaveLength(0)
})
