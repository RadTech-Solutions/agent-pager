import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Backend, Page, PagerConfig } from '../types'

// agent-pager pages a phone through ntfy or Telegram when a turn ran long,
// when the agent waits on a question or a permission prompt, and when a turn
// dies on an error. Messages from the phone become queued prompts.
//
// Deliberate limit: nothing here approves or denies a tool call. Permission
// prompts are announced, never answered remotely.

const busy = atom({ plugin: 'agent-pager', key: 'busy' } as const, false)
const remote = atom({ plugin: 'agent-pager', key: 'remote' } as const, 0)
const startedAt = atom({ plugin: 'agent-pager', key: 'startedAt' } as const, 0)

const BODY_CHARS = 200
const TELEGRAM_API = 'https://api.telegram.org'
const OUT_TAG = 'pager-out'

const HELP = [
  'agent-pager commands:',
  '/status  session state',
  '/stop    pause automatic pages',
  '/resume  resume automatic pages',
  'Anything else is queued as a prompt for the session.',
].join('\n')

const str = (v: unknown, d = '') => (typeof v === 'string' ? v.trim() : d)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

export function readConfig(o: PluginOptions): PagerConfig {
  const backend = str(o.backend, 'ntfy')
  return {
    backend: (['ntfy', 'telegram', 'off'].includes(backend) ? backend : 'ntfy') as Backend,
    ntfyTopic: str(o.ntfy_topic),
    ntfyServer: (str(o.ntfy_server) || 'https://ntfy.sh').replace(/\/+$/, ''),
    ntfyToken: str(o.ntfy_token),
    ntfyInbound: bool(o.ntfy_inbound, false),
    telegramToken: str(o.telegram_token),
    telegramChatId: str(o.telegram_chat_id),
    inbound: bool(o.inbound, true),
    pollMs: Math.max(2, num(o.poll_seconds, 5)) * 1000,
    minTurnMs: Math.max(0, num(o.min_turn_seconds, 60)) * 1000,
    askDelayMs: Math.max(0, num(o.ask_delay_seconds, 10)) * 1000,
    minGapMs: Math.max(0, num(o.min_gap_seconds, 30)) * 1000,
    quietHours: str(o.quiet_hours),
    privateMode: bool(o.private_mode, false),
    notifyErrors: bool(o.notify_errors, true),
  }
}

/** Why the backend cannot send, or null when it can. */
export function missing(cfg: PagerConfig): string | null {
  if (cfg.backend === 'off') return 'backend is off'
  if (cfg.backend === 'ntfy' && !cfg.ntfyTopic) return 'ntfy_topic is not set'
  if (cfg.backend === 'telegram' && !cfg.telegramToken) return 'telegram_token is not set'
  if (cfg.backend === 'telegram' && !cfg.telegramChatId) return 'telegram_chat_id is not set'
  return null
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function minutesOf(t: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (h > 24 || min > 59) return null
  return (h % 24) * 60 + min
}

/** True when `now` (epoch ms, read in local time) falls inside `range` ("22-07"). */
export function inQuietHours(range: string, now: number): boolean {
  if (!range) return false
  const parts = range.split('-')
  if (parts.length !== 2) return false
  const from = minutesOf(parts[0] ?? '')
  const to = minutesOf(parts[1] ?? '')
  if (from === null || to === null || from === to) return false
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  return from < to ? cur >= from && cur < to : cur >= from || cur < to
}

function projectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

/** The title and text a page carries once private mode is applied. */
export function render(page: Page, project: string, privateMode: boolean): { title: string; text: string } {
  if (privateMode && page.kind !== 'test' && page.kind !== 'status') {
    return { title: 'agent-pager', text: 'Your agent needs you.' }
  }
  return { title: `${project}: ${page.label}`, text: page.body }
}

async function sendRaw($: EngineInterface, cfg: PagerConfig, title: string, text: string, urgent: boolean): Promise<string | null> {
  if (cfg.backend === 'telegram') {
    const r = await $.http.fetch(`${TELEGRAM_API}/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text: text ? `${title}\n${text}` : title, disable_web_page_preview: true }),
    })
    return r.ok ? null : `telegram answered ${r.status}`
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.ntfyToken) headers.authorization = `Bearer ${cfg.ntfyToken}`
  const r = await $.http.fetch(cfg.ntfyServer, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      topic: cfg.ntfyTopic,
      title,
      message: text || title,
      tags: [OUT_TAG],
      priority: urgent ? 4 : 3,
    }),
  })
  return r.ok ? null : `ntfy answered ${r.status}`
}

/**
 * Sends one page unless something holds it back. Automatic pages respect
 * pause, quiet hours and the minimum gap; forced ones (tests, answers to the
 * phone) go regardless. Resolves why it did not send, or null when it did.
 */
export async function page($: EngineInterface, cfg: PagerConfig, p: Page): Promise<string | null> {
  const why = missing(cfg)
  if (why) return why
  const now = await $.clock.now()
  if (!p.force) {
    if ((await $.store.get('paused')) === true) return 'paused'
    if (inQuietHours(cfg.quietHours, now)) return 'quiet hours'
    const last = num(await $.store.get('lastPageAt'), 0)
    if (cfg.minGapMs > 0 && now - last < cfg.minGapMs) return 'too soon after the last page'
  }
  const project = projectName(await $.session.cwd())
  const { title, text } = render(p, project, cfg.privateMode)
  const urgent = p.kind === 'question' || p.kind === 'permission' || p.kind === 'error'
  let err: string | null
  try {
    err = await sendRaw($, cfg, title, text, urgent)
  } catch (e) {
    err = `send failed: ${String(e)}`
  }
  if (err) return err
  await $.store.set('lastPageAt', now)
  return null
}

async function statusLine($: EngineInterface, cfg: PagerConfig): Promise<string> {
  const [cwd, model, turns, isBusy, paused] = await Promise.all([
    $.session.cwd(),
    $.session.model().catch(() => '?'),
    $.session.turns().catch(() => -1),
    read($, busy),
    $.store.get('paused'),
  ])
  const lines = [
    `Session ${projectName(cwd)}: ${isBusy ? 'working' : 'idle'}`,
    `Model ${model}, ${turns >= 0 ? turns : '?'} turns`,
    `Paging ${paused === true ? 'paused (/resume)' : 'on'}${cfg.quietHours ? `, quiet hours ${cfg.quietHours}` : ''}`,
  ]
  return lines.join('\n')
}

/** One message from the phone: a command, or a prompt to queue. */
export async function handleInbound($: EngineInterface, cfg: PagerConfig, raw: string): Promise<void> {
  const text = raw.trim()
  if (!text) return
  const cmd = text.split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, '') ?? ''
  const reply = (label: string, body: string) => page($, cfg, { kind: 'status', label, body, force: true })
  if (cmd === '/status') {
    await reply('status', await statusLine($, cfg))
    return
  }
  if (cmd === '/stop' || cmd === '/pause') {
    await $.store.set('paused', true)
    await reply('paused', 'Automatic pages are paused. Send /resume to turn them back on.')
    return
  }
  if (cmd === '/resume') {
    await $.store.set('paused', false)
    await reply('resumed', 'Automatic pages are on again.')
    return
  }
  if (cmd === '/help' || cmd === '/start') {
    await reply('help', HELP)
    return
  }
  await update($, remote, n => (n ?? 0) + 1)
  await $.prompt.submit({ text, asUser: true })
  $.ui.toast(`agent-pager: prompt from the phone queued: ${clip(text, 60)}`, { timeoutMs: 6000 })
  const isBusy = await read($, busy)
  await reply('queued', isBusy ? 'Queued. It runs when the current turn ends.' : 'Running now.')
}

type TelegramUpdate = {
  update_id: number
  message?: { date?: number; text?: string; chat?: { id?: number | string } }
}

export async function pollTelegram($: EngineInterface, cfg: PagerConfig): Promise<void> {
  const offset = num(await $.store.get('tgOffset'), 0)
  const url = `${TELEGRAM_API}/bot${cfg.telegramToken}/getUpdates?timeout=0&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`
  const r = await $.http.fetch(url)
  if (!r.ok) return
  let updates: TelegramUpdate[]
  try {
    const body = JSON.parse(r.text) as { ok?: boolean; result?: TelegramUpdate[] }
    updates = body.ok && Array.isArray(body.result) ? body.result : []
  } catch {
    return
  }
  if (updates.length === 0) return
  const since = Math.floor((await read($, startedAt)) / 1000)
  let next = offset
  for (const u of updates) next = Math.max(next, u.update_id + 1)
  // Advance first, so a prompt that fails is never replayed.
  await $.store.set('tgOffset', next)
  for (const u of updates) {
    const m = u.message
    if (!m || typeof m.text !== 'string') continue
    if (String(m.chat?.id ?? '') !== cfg.telegramChatId) continue
    if ((m.date ?? 0) < since) continue
    await handleInbound($, cfg, m.text)
  }
}

type NtfyEvent = { id?: string; time?: number; event?: string; message?: string; tags?: string[] }

export async function pollNtfy($: EngineInterface, cfg: PagerConfig): Promise<void> {
  const stored = await $.store.get(`ntfySince:${cfg.ntfyTopic}`)
  const since = typeof stored === 'string' && stored ? stored : String(Math.floor((await read($, startedAt)) / 1000))
  const headers: Record<string, string> = {}
  if (cfg.ntfyToken) headers.authorization = `Bearer ${cfg.ntfyToken}`
  const r = await $.http.fetch(`${cfg.ntfyServer}/${encodeURIComponent(cfg.ntfyTopic)}/json?poll=1&since=${encodeURIComponent(since)}`, { headers })
  if (!r.ok) return
  const events: NtfyEvent[] = []
  for (const line of r.text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as NtfyEvent)
    } catch {
      // a partial line: skip it
    }
  }
  const msgs = events.filter(ev => ev.event === 'message' && ev.id)
  const last = msgs.at(-1)
  if (!last?.id) return
  await $.store.set(`ntfySince:${cfg.ntfyTopic}`, last.id)
  for (const ev of msgs) {
    if (ev.tags?.includes(OUT_TAG)) continue
    await handleInbound($, cfg, ev.message ?? '')
  }
}

/**
 * Takes or renews the poller lease, so that only one session reads the
 * phone's messages at a time. True when this session holds it.
 */
async function holdLease($: EngineInterface, cfg: PagerConfig): Promise<boolean> {
  const [id, now, lease] = await Promise.all([$.session.id(), $.clock.now(), $.store.get('lease')])
  const l = lease as { id?: string; at?: number } | undefined
  if (l && l.id && l.id !== id && now - num(l.at, 0) < cfg.pollMs * 3) return false
  await $.store.set('lease', { id, at: now })
  return true
}

export async function pollOnce($: EngineInterface, cfg: PagerConfig): Promise<void> {
  if (missing(cfg)) return
  const ntfy = cfg.backend === 'ntfy' && cfg.ntfyInbound
  if (cfg.backend !== 'telegram' && !ntfy) return
  if (!(await holdLease($, cfg))) return
  if (cfg.backend === 'telegram') await pollTelegram($, cfg)
  else await pollNtfy($, cfg)
}

async function pagerStatus($: EngineInterface, cfg: PagerConfig): Promise<string> {
  const [paused, lastAt, now] = await Promise.all([$.store.get('paused'), $.store.get('lastPageAt'), $.clock.now()])
  const why = missing(cfg)
  const target =
    cfg.backend === 'ntfy' ? `ntfy topic "${cfg.ntfyTopic}" on ${cfg.ntfyServer}` : cfg.backend === 'telegram' ? `Telegram chat ${cfg.telegramChatId}` : 'nowhere'
  const inbound = cfg.backend === 'telegram' || (cfg.backend === 'ntfy' && cfg.ntfyInbound)
  const last = typeof lastAt === 'number' ? `${duration(now - lastAt)} ago` : 'never'
  return [
    `agent-pager: ${why ? `not sending (${why})` : `pages go to ${target}`}`,
    `Paging ${paused === true ? 'paused' : 'on'}; last page ${last}`,
    `Turns longer than ${cfg.minTurnMs / 1000}s page; questions after ${cfg.askDelayMs / 1000}s; gap ${cfg.minGapMs / 1000}s`,
    `Quiet hours ${cfg.quietHours ? `${cfg.quietHours}${inQuietHours(cfg.quietHours, now) ? ' (now)' : ''}` : 'none'}; private mode ${cfg.privateMode ? 'on' : 'off'}; errors ${cfg.notifyErrors ? 'on' : 'off'}`,
    `Replies from the phone ${inbound && cfg.inbound ? `on, checked every ${cfg.pollMs / 1000}s` : 'off'}`,
    'Tool calls are never approved from the phone.',
  ].join('\n')
}

type AskQuestion = { question?: string; options?: { label?: string }[] }

export function questionBody(questions: unknown): string {
  const qs = Array.isArray(questions) ? (questions as AskQuestion[]) : []
  const first = qs[0]
  if (!first) return 'A question is waiting in the terminal.'
  const opts = (first.options ?? []).map(o => o.label ?? '').filter(Boolean)
  const more = qs.length > 1 ? ` (+${qs.length - 1} more)` : ''
  return clip(`${first.question ?? ''}${more}${opts.length ? ` Options: ${opts.join(' / ')}` : ''}`, BODY_CHARS)
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, startedAt, () => now)
    await $.command.register({
      name: 'pager',
      description: 'agent-pager: status, test, pause, resume',
      argumentHint: '[status|test|pause|resume]',
    })
    if (e.isInteractive && cfg.inbound) {
      $.clock.every(cfg.pollMs, () => {
        void pollOnce($, cfg).catch(() => undefined)
      })
    }
    return next(e)
  })

  on('command.run', { command: 'pager' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pause' || arg === 'stop') {
      await $.store.set('paused', true)
      return { text: 'agent-pager: automatic pages paused. /pager resume turns them back on.' }
    }
    if (arg === 'resume') {
      await $.store.set('paused', false)
      return { text: 'agent-pager: automatic pages on.' }
    }
    if (arg === 'test') {
      const why = await page($, cfg, { kind: 'test', label: 'test page', body: 'If you can read this, agent-pager reaches your phone.', force: true })
      return { text: why ? `agent-pager: test page not sent (${why}).` : 'agent-pager: test page sent.' }
    }
    if (arg && arg !== 'status') return { text: 'Usage: /pager [status|test|pause|resume]' }
    return { text: await pagerStatus($, cfg) }
  })

  on('turn.start', async ($, e, next) => {
    await update($, busy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result
    await update($, busy, () => false)
    const fromPhone = (await read($, remote)) > 0
    if (fromPhone) await update($, remote, n => Math.max(0, (n ?? 0) - 1))
    if (e.reason === 'aborted') return result
    const took = duration(e.durationMs)
    if (e.reason === 'error' || e.reason === 'refusal') {
      if (cfg.notifyErrors || fromPhone) {
        await page($, cfg, { kind: 'error', label: `Turn ended on ${e.reason === 'error' ? 'an error' : 'a refusal'} (${took})`, body: clip(e.answer || 'No reply text.', BODY_CHARS), force: fromPhone })
      }
      return result
    }
    if (fromPhone || e.durationMs >= cfg.minTurnMs) {
      await page($, cfg, {
        kind: fromPhone ? 'reply' : 'turn',
        label: `Turn finished (${took})`,
        body: clip(e.answer || 'No reply text.', BODY_CHARS),
        force: fromPhone,
      })
    }
    return result
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const body = questionBody(e.questions)
    const timer = $.clock.after(Math.max(1, cfg.askDelayMs), () => {
      void page($, cfg, { kind: 'question', label: 'Question waiting', body }).catch(() => undefined)
    })
    try {
      return await next(e)
    } finally {
      timer.cancel()
    }
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const result = await next(e)
    const kind = e.notification_type
    if (kind === 'permission_prompt') {
      await page($, cfg, { kind: 'permission', label: 'Permission needed', body: clip(`${e.message} Approve it in the terminal.`, BODY_CHARS) })
    } else if (kind === 'elicitation_dialog' || kind === 'elicitation_url_dialog') {
      await page($, cfg, { kind: 'question', label: 'Input needed', body: clip(e.message, BODY_CHARS) })
    }
    return result
  }).catch(($, e, next) => next(e))
}
