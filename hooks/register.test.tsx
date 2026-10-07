import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

type Call = { url: string; method: string; body: Record<string, unknown> | null; headers: Record<string, string> }

const NTFY = { backend: 'ntfy', ntfy_topic: 'pager-test-topic', min_gap_seconds: 0 }
const TG = { backend: 'telegram', telegram_token: '123:abc', telegram_chat_id: '42', min_gap_seconds: 0 }

// 2026-03-04 12:00 local time: outside the quiet hours used below.
const NOON = new Date(2026, 2, 4, 12, 0).getTime()
const NIGHT = new Date(2026, 2, 4, 23, 30).getTime()

/**
 * The engine beneath the plugin: a session in /work/shop, an http.fetch
 * that records every request and answers with `reply`, and a prompt queue.
 */
function engine(on: On, now: number, reply: (url: string) => string = () => '{"ok":true,"result":[]}') {
  const clock = mock.clock(on, { now })
  mock.store(on)
  const calls: Call[] = []
  const prompts: string[] = []
  on('session.cwd', () => ({ value: '/work/shop' }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.model', () => ({ value: 'test-model' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'pager' } }))
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
    return { value: { status: 200, ok: true, headers: {}, text: reply(e.url) } }
  })
  const sent = () => calls.filter(c => c.method === 'POST')
  return { clock, calls, sent, prompts }
}

async function finishTurn($: Engine, durationMs: number, answer: string, reason: 'answer' | 'error' | 'aborted' = 'answer') {
  await $.turn.complete({ answer, durationMs, isAborted: reason === 'aborted', turnId: 't1', reason })
}

const start = { cwd: '/work/shop', surface: 'terminal', isInteractive: true } as const

test('a long turn pages ntfy with the project, the duration and the first 200 characters', { options: NTFY }, async ($, on) => {
  const { sent } = engine(on, NOON)
  await $.session.start(start)

  await finishTurn($, 5_000, 'quick answer')
  expect(sent()).toHaveLength(0)

  const long = 'Refactored the billing module. ' + 'x'.repeat(400)
  await finishTurn($, 125_000, long)
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

test('telegram: only the configured chat reaches the session, as a queued prompt', { options: TG }, async ($, on) => {
  const updates = {
    ok: true,
    result: [
      { update_id: 10, message: { date: NOON / 1000 + 1, text: 'run the tests please', chat: { id: 42 } } },
      { update_id: 11, message: { date: NOON / 1000 + 2, text: 'rm -rf everything', chat: { id: 666 } } },
      { update_id: 12, message: { date: NOON / 1000 - 600, text: 'stale from before the session', chat: { id: 42 } } },
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
  expect(calls.filter(c => c.url.includes('getUpdates')).at(-1)!.url).toContain('offset=13')
  expect(prompts).toHaveLength(1)

  // The turn the phone started answers back even though it was short.
  await finishTurn($, 2_000, 'All 41 tests pass.')
  const answer = sent().at(-1)!
  expect(answer.body?.text).toBe('shop: Turn finished (2s)\nAll 41 tests pass.')
})

test('telegram /status and /stop from the phone', { options: TG }, async ($, on) => {
  let next: object[] = [{ update_id: 1, message: { date: NOON / 1000 + 5, text: '/status', chat: { id: 42 } } }]
  const { clock, sent, prompts } = engine(on, NOON, url => {
    if (!url.includes('/getUpdates')) return '{"ok":true}'
    const r = JSON.stringify({ ok: true, result: next })
    next = []
    return r
  })
  await $.session.start(start)
  await clock.advance(5_000)
  expect(prompts).toHaveLength(0)
  const status = String(sent().at(-1)!.body?.text)
  expect(status).toContain('Session shop: idle')
  expect(status).toContain('Model test-model, 3 turns')

  next = [{ update_id: 2, message: { date: NOON / 1000 + 10, text: '/stop', chat: { id: 42 } } }]
  await clock.advance(5_000)
  expect(String(sent().at(-1)!.body?.text)).toContain('paused')
  const before = sent().length
  await finishTurn($, 300_000, 'long work done')
  expect(sent()).toHaveLength(before)
})

test('quiet hours hold automatic pages, but /pager test still goes out', { options: { ...NTFY, quiet_hours: '22-07' } }, async ($, on) => {
  const { sent } = engine(on, NIGHT)
  await $.session.start(start)
  await finishTurn($, 300_000, 'done overnight')
  expect(sent()).toHaveLength(0)

  const { text } = await $.command.run({ command: 'pager', args: 'test' } as Parameters<typeof $.command.run>[0])
  expect(text).toBe('agent-pager: test page sent.')
  expect(sent()).toHaveLength(1)
  expect(sent()[0]!.body?.title).toBe('shop: test page')
})

test('/pager pause and resume', { options: NTFY }, async ($, on) => {
  const { sent } = engine(on, NOON)
  await $.session.start(start)
  const run = (args: string) => $.command.run({ command: 'pager', args } as Parameters<typeof $.command.run>[0])

  expect((await run('pause')).text).toContain('paused')
  await finishTurn($, 300_000, 'one')
  expect(sent()).toHaveLength(0)
  expect((await run('')).text).toContain('Paging paused')

  expect((await run('resume')).text).toContain('on')
  await finishTurn($, 300_000, 'two')
  expect(sent()).toHaveLength(1)
  expect((await run('status')).text).toContain('pages go to ntfy topic "pager-test-topic"')
})

test('the minimum gap drops pages that come too close together', { options: { ...NTFY, min_gap_seconds: 60 } }, async ($, on) => {
  const { clock, sent } = engine(on, NOON)
  await $.session.start(start)
  await finishTurn($, 300_000, 'one')
  await clock.advance(30_000)
  await finishTurn($, 300_000, 'two')
  expect(sent()).toHaveLength(1)
  await clock.advance(31_000)
  await finishTurn($, 300_000, 'three')
  expect(sent()).toHaveLength(2)
})

test('private mode sends only that the agent needs you', { options: { ...NTFY, private_mode: true } }, async ($, on) => {
  const { sent } = engine(on, NOON)
  await $.session.start(start)
  await finishTurn($, 300_000, 'secret customer data in the reply')
  expect(sent()[0]!.body).toEqual({ topic: 'pager-test-topic', title: 'agent-pager', message: 'Your agent needs you.', tags: ['pager-out'], priority: 3 })
})

test('an unanswered question pages after the delay; one answered in time does not', { options: NTFY }, async ($, on) => {
  const { clock, sent } = engine(on, NOON)
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
  expect(sent()).toHaveLength(0)

  wait = 12_000
  await $.tool.call(ask as never)
  expect(sent()).toHaveLength(1)
  expect(sent()[0]!.body?.title).toBe('shop: Question waiting')
  expect(sent()[0]!.body?.message).toBe('Which database? Options: Postgres / SQLite')
  expect(sent()[0]!.body?.priority).toBe(4)
})

test('a permission prompt notification and an error each page', { options: NTFY }, async ($, on) => {
  const { sent } = engine(on, NOON)
  await $.session.start(start)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  expect(sent()[0]!.body?.title).toBe('shop: Permission needed')
  expect(String(sent()[0]!.body?.message)).toContain('needs your permission to use Bash')

  await $.classic.Notification({ message: 'idle', notification_type: 'idle_prompt' })
  expect(sent()).toHaveLength(1)

  await finishTurn($, 1_000, 'API Error: overloaded', 'error')
  expect(sent()[1]!.body?.title).toBe('shop: Turn ended on an error (1s)')
})

test('ntfy inbound stays off unless enabled, and skips its own pages when on', { options: { ...NTFY, ntfy_inbound: true } }, async ($, on) => {
  const lines = [
    { id: 'a1', time: NOON / 1000 + 1, event: 'message', message: 'shop: Turn finished', tags: ['pager-out'] },
    { id: 'a2', time: NOON / 1000 + 2, event: 'message', message: 'also update the changelog' },
  ]
  let served = false
  const { clock, calls, prompts } = engine(on, NOON, url => {
    if (url.includes('/json?poll=1') && !served) {
      served = true
      return lines.map(l => JSON.stringify(l)).join('\n')
    }
    return ''
  })
  await $.session.start(start)
  await clock.advance(5_000)
  expect(calls[0]!.url).toBe(`https://ntfy.sh/pager-test-topic/json?poll=1&since=${NOON / 1000}`)
  expect(prompts).toEqual(['also update the changelog'])
  await clock.advance(5_000)
  expect(calls.filter(c => c.url.includes('/json?poll=1')).at(-1)!.url).toContain('since=a2')
})

test('with ntfy inbound off, nothing is polled', { options: NTFY }, async ($, on) => {
  const { clock, calls } = engine(on, NOON)
  await $.session.start(start)
  await clock.advance(20_000)
  expect(calls).toHaveLength(0)
})
