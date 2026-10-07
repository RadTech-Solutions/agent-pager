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
const startedAt = atom({ plugin: 'agent-pager', key: 'startedAt' } as const, 0)
const interactive = atom({ plugin: 'agent-pager', key: 'interactive' } as const, false)
// Prompts sent from the phone that have not started a turn yet, and the ids
// of the turns they started: only those turns' replies go back to the phone.
const pending = atom({ plugin: 'agent-pager', key: 'pending' } as const, [])
const remoteTurns = atom({ plugin: 'agent-pager', key: 'remoteTurns' } as const, [])

const BODY_CHARS = 200
const TELEGRAM_API = 'https://api.telegram.org'
const OUT_TAG = 'pager-out'
const MAX_BACKOFF_MS = 5 * 60 * 1000
const SEEN_KEEP = 200

const HELP = [
  'agent-pager commands:',
  '/status  session state',
  '/stop    pause automatic pages',
  '/resume  resume automatic pages',
  'Anything else is queued as a prompt for the session.',
].join('\n')

// The poller's timer lives in this copy of the module; a hot reload drops
// both the timer and this flag, and the next event starts it again.
let pollerRunning = false

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

/** Why replies from the phone are off, or null when they are read. */
export function inboundOff(cfg: PagerConfig): string | null {
  if (!cfg.inbound) return 'inbound is off'
  if (missing(cfg)) return missing(cfg)
  if (cfg.backend === 'ntfy') {
    if (!cfg.ntfyInbound) return 'ntfy_inbound is off'
    if (!cfg.ntfyToken) return 'ntfy_inbound needs ntfy_token on a protected topic'
  }
  return null
}

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** Strips a Telegram bot token out of a text that may quote a URL. */
export function redact(s: string): string {
  return s.replace(/bot[^/\s]+/g, 'bot<token>')
}

export function mask(s: string): string {
  return s.length <= 4 ? s : s.slice(0, 4) + '*'.repeat(Math.min(12, s.length - 4))
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

/** The range as minutes of the day, or null when it does not parse. */
export function parseQuietHours(range: string): [number, number] | null {
  const parts = range.split('-')
  if (parts.length !== 2) return null
  const from = minutesOf(parts[0] ?? '')
  const to = minutesOf(parts[1] ?? '')
  if (from === null || to === null || from === to) return null
  return [from, to]
}

/** True when `now` (epoch ms, read in local time) falls inside `range` ("22-07"). */
export function inQuietHours(range: string, now: number): boolean {
  if (!range) return false
  const r = parseQuietHours(range)
  if (!r) return false
  const [from, to] = r
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
 * pause and quiet hours, and routine ones the minimum gap too; a question or
 * permission page is never dropped for the gap. Forced pages (tests, answers
 * to the phone) go regardless. Resolves why it did not send, or null.
 */
export async function page($: EngineInterface, cfg: PagerConfig, p: Page): Promise<string | null> {
  const why = missing(cfg)
  if (why) return why
  const now = await $.clock.now()
  const urgent = p.kind === 'question' || p.kind === 'permission'
  if (!p.force) {
    if ((await $.store.get('paused')) === true) return 'paused'
    if (inQuietHours(cfg.quietHours, now)) return 'quiet hours'
    const last = num(await $.store.get('lastPageAt'), 0)
    if (!urgent && cfg.minGapMs > 0 && now - last < cfg.minGapMs) return 'too soon after the last page'
  }
  const project = projectName(await $.session.cwd())
  const { title, text } = render(p, project, cfg.privateMode)
  let err: string | null
  try {
    err = await sendRaw($, cfg, title, text, urgent || p.kind === 'error')
  } catch (e) {
    err = `send failed: ${String(e)}`
  }
  if (err) {
    err = redact(err)
    await $.store.set('lastSendError', { at: now, text: err })
    return err
  }
  await $.store.set('lastPageAt', now)
  return null
}

/** A page from a hook that must not wait on the network. */
function pageLater($: EngineInterface, cfg: PagerConfig, p: Page): void {
  void page($, cfg, p).catch(() => undefined)
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
  await update($, pending, list => [...(list ?? []), text].slice(-20))
  await $.prompt.submit({ text, asUser: true })
  $.ui.toast(`agent-pager: prompt from the phone queued: ${clip(text, 60)}`, { timeoutMs: 6000 })
  const isBusy = await read($, busy)
  await reply('queued', isBusy ? 'Queued. It runs when the current turn ends.' : 'Running now.')
}

/** True the first time `id` is seen under `key`; remembers the last few. */
async function firstSight($: EngineInterface, key: string, id: string): Promise<boolean> {
  const seen = await $.store.get(key)
  const list = Array.isArray(seen) ? (seen as string[]) : []
  if (list.includes(id)) return false
  await $.store.set(key, [...list, id].slice(-SEEN_KEEP))
  return true
}

/** A failed poll: what went wrong, and a later retry. */
class PollError extends Error {
  retryAfterMs: number | null
  constructor(message: string, retryAfterMs: number | null = null) {
    super(message)
    this.retryAfterMs = retryAfterMs
  }
}

type TelegramUpdate = {
  update_id: number
  message?: { date?: number; text?: string; chat?: { id?: number | string; type?: string }; from?: { id?: number | string } }
}

export async function pollTelegram($: EngineInterface, cfg: PagerConfig): Promise<void> {
  const offset = num(await $.store.get('tgOffset'), 0)
  const url = `${TELEGRAM_API}/bot${cfg.telegramToken}/getUpdates?timeout=0&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`
  const r = await $.http.fetch(url)
  let body: { ok?: boolean; result?: TelegramUpdate[]; description?: string; parameters?: { retry_after?: number } }
  try {
    body = JSON.parse(r.text) as typeof body
  } catch {
    throw new PollError(`telegram answered ${r.status} with no JSON`)
  }
  if (!r.ok || !body.ok) {
    const retry = body.parameters?.retry_after
    throw new PollError(`telegram answered ${r.status}${body.description ? `: ${body.description}` : ''}`, typeof retry === 'number' ? retry * 1000 : null)
  }
  const updates = Array.isArray(body.result) ? body.result : []
  if (updates.length === 0) return
  const since = Math.floor((await read($, startedAt)) / 1000)
  let next = offset
  for (const u of updates) next = Math.max(next, u.update_id + 1)
  // Advance first, so a prompt that fails is never replayed.
  await $.store.set('tgOffset', next)
  for (const u of updates) {
    const m = u.message
    if (!m || typeof m.text !== 'string') continue
    // Private chat with the owner only: in a group anyone could write.
    if (m.chat?.type !== 'private') continue
    if (String(m.chat?.id ?? '') !== cfg.telegramChatId) continue
    if (String(m.from?.id ?? '') !== cfg.telegramChatId) continue
    if ((m.date ?? 0) < since) continue
    if (!(await firstSight($, 'tgSeen', String(u.update_id)))) continue
    await handleInbound($, cfg, m.text)
  }
}

type NtfyEvent = { id?: string; time?: number; event?: string; message?: string; tags?: string[] }

export async function pollNtfy($: EngineInterface, cfg: PagerConfig): Promise<void> {
  const start = Math.floor((await read($, startedAt)) / 1000)
  const stored = await $.store.get(`ntfySince:${cfg.ntfyTopic}`)
  const since = typeof stored === 'string' && stored ? stored : String(start)
  const headers: Record<string, string> = {}
  if (cfg.ntfyToken) headers.authorization = `Bearer ${cfg.ntfyToken}`
  const r = await $.http.fetch(`${cfg.ntfyServer}/${encodeURIComponent(cfg.ntfyTopic)}/json?poll=1&since=${encodeURIComponent(since)}`, { headers })
  if (!r.ok) {
    const retry = Number(r.headers['retry-after'])
    throw new PollError(`ntfy answered ${r.status}`, Number.isFinite(retry) && retry > 0 ? retry * 1000 : null)
  }
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
    // A stored cursor from an earlier session can reach back past this one.
    if ((ev.time ?? 0) < start) continue
    if (!(await firstSight($, 'ntfySeen', String(ev.id)))) continue
    await handleInbound($, cfg, ev.message ?? '')
  }
}

/**
 * Takes or renews the poller lease, so that normally one session reads the
 * phone's messages. A takeover can overlap one poll; the seen lists keep a
 * message from running twice. True when this session holds it.
 */
async function holdLease($: EngineInterface, cfg: PagerConfig): Promise<boolean> {
  const [id, now, lease] = await Promise.all([$.session.id(), $.clock.now(), $.store.get('lease')])
  const l = lease as { id?: string; at?: number } | undefined
  if (l && l.id && l.id !== id && now - num(l.at, 0) < cfg.pollMs * 3) return false
  await $.store.set('lease', { id, at: now })
  return true
}

async function releaseLease($: EngineInterface, sessionId: string): Promise<void> {
  const lease = (await $.store.get('lease')) as { id?: string } | undefined
  if (lease?.id === sessionId) await $.store.delete('lease')
}

/**
 * One poll, skipped while backing off. A failure is stored for /pager status
 * and doubles the wait, up to five minutes, or waits what the server asked.
 */
export async function pollOnce($: EngineInterface, cfg: PagerConfig): Promise<void> {
  if (inboundOff(cfg)) return
  const now = await $.clock.now()
  if (now < num(await $.store.get('pollNextAt'), 0)) return
  if (!(await holdLease($, cfg))) return
  try {
    if (cfg.backend === 'telegram') await pollTelegram($, cfg)
    else await pollNtfy($, cfg)
    if (num(await $.store.get('pollFailures'), 0) > 0) {
      await $.store.set('pollFailures', 0)
      await $.store.set('pollNextAt', 0)
    }
  } catch (e) {
    const failures = num(await $.store.get('pollFailures'), 0) + 1
    const asked = e instanceof PollError ? e.retryAfterMs : null
    const wait = Math.min(MAX_BACKOFF_MS, asked ?? cfg.pollMs * 2 ** failures)
    const text = redact(e instanceof Error ? e.message : String(e))
    await $.store.set('pollFailures', failures)
    await $.store.set('pollNextAt', now + wait)
    await $.store.set('lastPollError', { at: now, text })
  }
}

/** Starts the poller once per copy of the module, in an interactive session. */
async function ensurePoller($: EngineInterface, cfg: PagerConfig): Promise<void> {
  if (pollerRunning || inboundOff(cfg)) return
  if (!(await read($, interactive))) return
  pollerRunning = true
  $.clock.every(cfg.pollMs, () => {
    void pollOnce($, cfg).catch(() => undefined)
  })
}

async function pagerStatus($: EngineInterface, cfg: PagerConfig): Promise<string> {
  const [paused, lastAt, now, pollErr, sendErr, nextAt] = await Promise.all([
    $.store.get('paused'),
    $.store.get('lastPageAt'),
    $.clock.now(),
    $.store.get('lastPollError'),
    $.store.get('lastSendError'),
    $.store.get('pollNextAt'),
  ])
  const why = missing(cfg)
  const target =
    cfg.backend === 'ntfy' ? `ntfy topic "${mask(cfg.ntfyTopic)}" on ${cfg.ntfyServer}` : cfg.backend === 'telegram' ? `Telegram chat ${cfg.telegramChatId}` : 'nowhere'
  const off = inboundOff(cfg)
  const last = typeof lastAt === 'number' ? `${duration(now - lastAt)} ago` : 'never'
  const quiet = !cfg.quietHours ? 'none' : !parseQuietHours(cfg.quietHours) ? `"${cfg.quietHours}" is invalid, ignored (use 22-07 or 22:30-06:45)` : `${cfg.quietHours}${inQuietHours(cfg.quietHours, now) ? ' (now)' : ''}`
  const lines = [
    `agent-pager: ${why ? `not sending (${why})` : `pages go to ${target}`}`,
    `Paging ${paused === true ? 'paused' : 'on'}; last page ${last}`,
    `Turns longer than ${cfg.minTurnMs / 1000}s page; questions after ${cfg.askDelayMs / 1000}s; gap ${cfg.minGapMs / 1000}s (questions and permissions skip it)`,
    `Quiet hours ${quiet}; private mode ${cfg.privateMode ? 'on' : 'off'}; errors ${cfg.notifyErrors ? 'on' : 'off'}`,
    `Replies from the phone ${off ? `off (${off})` : `on, checked every ${cfg.pollMs / 1000}s`}`,
  ]
  const err = (v: unknown) => (v && typeof v === 'object' && 'text' in v && 'at' in v ? (v as { at: number; text: string }) : null)
  const pe = err(pollErr)
  if (pe) lines.push(`Last poll error ${duration(now - pe.at)} ago: ${pe.text}${num(nextAt, 0) > now ? `; next try in ${duration(num(nextAt, 0) - now)}` : ''}`)
  const se = err(sendErr)
  if (se) lines.push(`Last send error ${duration(now - se.at)} ago: ${se.text}`)
  lines.push('Tool calls are never approved from the phone.')
  return lines.join('\n')
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
    await update($, interactive, () => e.isInteractive)
    try {
      await $.command.register({
        name: 'pager',
        description: 'agent-pager: status, test, pause, resume',
        argumentHint: '[status|test|pause|resume]',
      })
    } catch {
      // the poller and the pages do not depend on the command
    }
    await ensurePoller($, cfg)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await releaseLease($, e.sessionId).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'pager' }, async ($, e) => {
    await ensurePoller($, cfg)
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

  // turn.start fires for the main loop only (a subagent's run raises none).
  on('turn.start', async ($, e, next) => {
    await update($, busy, () => true)
    const waiting = await read($, pending)
    const i = waiting.findIndex(t => t === e.text.trim() || e.text.includes(t))
    if (i >= 0) {
      await update($, pending, list => (list ?? []).filter((_, j) => j !== i))
      await update($, remoteTurns, list => [...(list ?? []), e.turnId].slice(-20))
    }
    await ensurePoller($, cfg)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn ends inside the main turn: it neither clears busy
    // nor pages.
    if (e.agentId) return result
    await update($, busy, () => false)
    const fromPhone = (await read($, remoteTurns)).includes(e.turnId)
    if (fromPhone) await update($, remoteTurns, list => (list ?? []).filter(id => id !== e.turnId))
    if (e.reason === 'aborted') return result
    const took = duration(e.durationMs)
    if (e.reason === 'error' || e.reason === 'refusal') {
      if (cfg.notifyErrors || fromPhone) {
        pageLater($, cfg, {
          kind: 'error',
          label: `Turn ended on ${e.reason === 'error' ? 'an error' : 'a refusal'} (${took})`,
          body: clip(e.answer || 'No reply text.', BODY_CHARS),
          force: fromPhone,
        })
      }
      return result
    }
    if (fromPhone || e.durationMs >= cfg.minTurnMs) {
      pageLater($, cfg, {
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
      pageLater($, cfg, { kind: 'question', label: 'Question waiting', body })
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
      pageLater($, cfg, { kind: 'permission', label: 'Permission needed', body: clip(`${e.message} Approve it in the terminal.`, BODY_CHARS) })
    } else if (kind === 'elicitation_dialog' || kind === 'elicitation_url_dialog') {
      pageLater($, cfg, { kind: 'question', label: 'Input needed', body: clip(e.message, BODY_CHARS) })
    }
    return result
  }).catch(($, e, next) => next(e))
}
