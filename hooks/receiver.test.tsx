import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { claimGraceMs, claimReceiver, pollOnce, readConfig, unlisten } from './register'

// Overlapping pollers: two sessions, each with its own session state, over
// one shared store and one fake Telegram server, driving the exported
// functions directly (the way a reviewer reproduced the old lease race).

const cfg = readConfig({ backend: 'telegram', telegram_token: '123:abc', telegram_chat_id: '42', min_gap_seconds: 0, poll_seconds: 5 })
const GRACE = claimGraceMs(cfg)

type Update = { update_id: number; message: { date: number; text: string; chat: { id: number; type: string }; from: { id: number } } }

type World = {
  now: number
  store: Map<string, unknown>
  updates: Update[]
  /** Serve every update on every call, as if no offset were ever acked. */
  ignoreOffset: boolean
  submits: { session: string; text: string }[]
  /** Awaited inside getUpdates, after the request reached the server. */
  hold: ((session: string) => Promise<void>) | null
}

function world(): World {
  return { now: 1_000_000, store: new Map(), updates: [], ignoreOffset: false, submits: [], hold: null }
}

const msg = (update_id: number, text: string): Update => ({
  update_id,
  message: { date: 2_000, text, chat: { id: 42, type: 'private' }, from: { id: 42 } },
})

/** One session: its own $.state, the world's store, clock and network. */
function session(id: string, w: World): EngineInterface {
  const state = new Map<string, { value: unknown; version: number }>()
  const fake = {
    session: { id: async () => id, cwd: async () => '/work/shop', model: async () => 'm', turns: async () => 0 },
    clock: { now: async () => w.now },
    store: {
      get: async (k: string) => w.store.get(k),
      set: async (k: string, v: unknown) => {
        w.store.set(k, JSON.parse(JSON.stringify(v)))
      },
      delete: async (k: string) => {
        w.store.delete(k)
      },
      keys: async () => [...w.store.keys()],
    },
    state: {
      get: async (ref: { key: string }) => state.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown, opts?: { ifVersion?: number }) => {
        const cur = state.get(ref.key)?.version ?? 0
        if (opts?.ifVersion !== undefined && opts.ifVersion !== cur) return { isSet: false, version: cur }
        state.set(ref.key, { value, version: cur + 1 })
        return { isSet: true, version: cur + 1 }
      },
    },
    http: {
      fetch: async (url: string) => {
        if (url.includes('/getUpdates')) {
          const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0)
          const result = w.updates.filter(u => w.ignoreOffset || u.update_id >= offset)
          if (w.hold) await w.hold(id)
          return { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, result }) }
        }
        return { status: 200, ok: true, headers: {}, text: '{"ok":true}' }
      },
    },
    prompt: {
      submit: async (input: { text: string }) => {
        w.submits.push({ session: id, text: input.text })
        return { text: input.text }
      },
    },
    ui: { toast: () => undefined },
  }
  return fake as unknown as EngineInterface
}

/** Both pollers, started together and left to interleave. */
const both = (a: EngineInterface, b: EngineInterface) => Promise.all([pollOnce(a, cfg), pollOnce(b, cfg)])

test('no receiver: two overlapping pollers submit nothing', async () => {
  const w = world()
  const [a, b] = [session('A', w), session('B', w)]
  w.updates = [msg(1, 'deploy it')]
  for (let i = 0; i < 4; i++) {
    await both(a, b)
    w.now += 5_000
  }
  expect(w.submits).toEqual([])
})

test('(a) only the session that ran /pager listen submits', async () => {
  const w = world()
  const [a, b] = [session('A', w), session('B', w)]
  w.ignoreOffset = true
  await claimReceiver(a)
  w.now += GRACE
  w.updates = [msg(1, 'first'), msg(2, 'second')]
  for (let i = 0; i < 4; i++) {
    await both(a, b)
    w.now += 5_000
  }
  w.updates.push(msg(3, 'third'))
  await both(a, b)
  expect(w.submits).toEqual([
    { session: 'A', text: 'first' },
    { session: 'A', text: 'second' },
    { session: 'A', text: 'third' },
  ])
})

test('(a) a claim inside its grace does not poll yet', async () => {
  const w = world()
  const a = session('A', w)
  w.updates = [msg(1, 'early')]
  await claimReceiver(a)
  w.now += GRACE - 1
  await pollOnce(a, cfg)
  expect(w.submits).toEqual([])
  w.now += 1
  await pollOnce(a, cfg)
  expect(w.submits).toEqual([{ session: 'A', text: 'early' }])
})

test('(b) simultaneous /pager listen settles on one receiver; one submit per update', async () => {
  for (const order of ['AB', 'BA'] as const) {
    const w = world()
    const s = { A: session('A', w), B: session('B', w) }
    w.ignoreOffset = true
    // Both claim in the same instant, interleaved.
    await Promise.all(order.split('').map(k => claimReceiver(s[k as 'A' | 'B'])))
    w.now += GRACE
    w.updates = [msg(10, 'one'), msg(11, 'two')]
    for (let i = 0; i < 5; i++) {
      await both(s.A, s.B)
      w.now += 5_000
      if (i === 2) w.updates.push(msg(12, 'three'))
    }
    const texts = w.submits.map(x => x.text)
    expect(texts).toEqual(['one', 'two', 'three'])
    expect(new Set(w.submits.map(x => x.session)).size).toBe(1)
  }
})

test('(c) handoff while a fetch is in flight: the old receiver drops what it fetched', async () => {
  const w = world()
  const [a, b] = [session('A', w), session('B', w)]
  w.ignoreOffset = true
  await claimReceiver(a)
  w.now += GRACE
  await pollOnce(a, cfg) // A is listening, nothing to read yet
  w.updates = [msg(20, 'migrate the db')]

  // A's fetch reaches the server; before it returns, B runs /pager listen.
  w.hold = async who => {
    if (who === 'A') await claimReceiver(b)
  }
  await pollOnce(a, cfg)
  w.hold = null
  expect(w.submits).toEqual([])

  // A stopped listening; B takes over after its grace and submits once.
  for (let i = 0; i < 4; i++) {
    w.now += 5_000
    await both(a, b)
  }
  expect(w.submits).toEqual([{ session: 'B', text: 'migrate the db' }])
})

test('(c) handoff right after the old receiver submitted does not replay it', async () => {
  const w = world()
  const [a, b] = [session('A', w), session('B', w)]
  w.ignoreOffset = true
  await claimReceiver(a)
  w.now += GRACE
  w.updates = [msg(30, 'run the linter')]
  await pollOnce(a, cfg)
  expect(w.submits).toEqual([{ session: 'A', text: 'run the linter' }])

  await claimReceiver(b)
  for (let i = 0; i < 4; i++) {
    w.now += 5_000
    await both(a, b)
  }
  w.updates.push(msg(31, 'and the formatter'))
  await both(a, b)
  expect(w.submits).toEqual([
    { session: 'A', text: 'run the linter' },
    { session: 'B', text: 'and the formatter' },
  ])
})

test('/pager unlisten stops the receiver', async () => {
  const w = world()
  const a = session('A', w)
  await claimReceiver(a)
  w.now += GRACE
  await pollOnce(a, cfg)
  expect(await unlisten(a)).toBe(true)
  w.updates = [msg(40, 'ignored')]
  w.now += 5_000
  await pollOnce(a, cfg)
  expect(w.submits).toEqual([])
  expect(w.store.has('receiver')).toBe(false)
})

test('two polls at once in the same receiver submit a message once', async () => {
  const w = world()
  const a = session('A', w)
  await claimReceiver(a)
  w.now += GRACE
  await pollOnce(a, cfg) // A is listening, nothing to read yet
  w.updates = [msg(50, 'ship it')]
  await Promise.all([pollOnce(a, cfg), pollOnce(a, cfg)])
  expect(w.submits).toEqual([{ session: 'A', text: 'ship it' }])
})

test('a poll that throws releases the guard for the next one', async () => {
  const w = world()
  const a = session('A', w)
  await claimReceiver(a)
  w.now += GRACE
  await pollOnce(a, cfg)
  w.updates = [msg(60, 'after the error')]
  w.hold = async () => {
    throw new Error('network down')
  }
  await pollOnce(a, cfg).catch(() => undefined)
  w.hold = null
  w.store.delete('pollNextAt')
  await pollOnce(a, cfg)
  expect(w.submits).toEqual([{ session: 'A', text: 'after the error' }])
})
