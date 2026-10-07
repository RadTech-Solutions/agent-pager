# agent-pager

Your phone buzzes when the coding agent needs you, and you can answer from the phone.

## Overview

agent-pager is a Claude Code mod (a plugin of function hooks, Claude Code 2.1.287 or later). It sends a page through [ntfy](https://ntfy.sh) or your own Telegram bot when:

- a turn finishes after running longer than a threshold (60 seconds by default). The page carries the project folder name, the duration and the first 200 characters of the reply.
- the agent waits on you: an `AskUserQuestion` dialog that stays unanswered for a few seconds, a permission prompt you have not reacted to (the engine's `permission_prompt` notification, which fires after a short idle delay, so it stays quiet while you are typing), or an MCP input form.
- a turn ends on an API error or a refusal (optional, on by default).

Messages you send back become prompts. They are queued and run when the session is idle. A few words are commands instead:

| From the phone | Does |
| :- | :- |
| `/status` | Replies with the session state: working or idle, model, turn count, whether paging is paused |
| `/stop` | Pauses automatic pages (same as `/pager pause`) |
| `/resume` | Turns automatic pages back on |
| `/help` | Lists these |
| anything else | Queued as a prompt; when the turn that prompt started ends, its reply is sent back to you (other turns in between are not) |

All network traffic goes through the engine's `$.http.fetch`. The mod runs no processes and needs no server of its own.

## Set up

### ntfy in one minute

1. Install the ntfy app (Android, iOS) or open https://ntfy.sh/app in a browser.
2. Pick a long random topic name, for example `agent-pager-` followed by 16 random characters (`openssl rand -hex 8`). Anyone who knows the name can read the topic, so do not use a guessable one.
3. Subscribe to that topic in the app.
4. Set `backend` to `ntfy` and `ntfy_topic` to the name (see Download and install). Run `/pager test` in Claude Code. The test page should arrive within a second or two.

A self-hosted ntfy server works too: set `ntfy_server` to its URL and, for a protected topic, `ntfy_token` to an access token.

Replies over ntfy are off by default. ntfy has no notion of who sent a message, so `ntfy_inbound` only takes effect together with `ntfy_token`: use a protected topic (a self-hosted server, or a reserved topic with access control) where only that token can write. Without a token, `/pager status` says replies are off and why. Telegram is the simpler choice for replies.

### Telegram bot via BotFather

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather), send `/newbot` and follow the questions. Copy the token it gives you (`123456789:AA...`).
2. Open a chat with your new bot and send it any message.
3. Find your chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `message.chat.id` from the answer.
4. Set `backend` to `telegram`, `telegram_token` to the token and `telegram_chat_id` to the id. Run `/pager test`.

The bot must not have a webhook set, since the mod reads messages with `getUpdates`. Only a private chat with you is read: a message counts only when the chat is private and both the chat id and the sender id equal `telegram_chat_id` (in a private chat they are your user id). Groups are not supported, since anyone in a group could prompt your agent. Everything else is ignored without a reply.

## Download and install

From the marketplace, at the prompt of a terminal session:

```
/plugin marketplace add RadTech-Solutions/agent-pager
/plugin install agent-pager@agent-pager
```

or in one line:

```
/plugin install agent-pager --marketplace RadTech-Solutions/agent-pager
```

Answer `y` to add the marketplace and pick a scope. The install shows a screen that sets the options; the tokens are masked and stored in the system keychain. Non-secret options also appear as rows in `/config`.

From a clone, for one session:

```
git clone https://github.com/RadTech-Solutions/agent-pager
claude --plugin-dir ./agent-pager
```

Options for a `--plugin-dir` load are read from `pluginConfigs` in your user settings (`~/.claude/settings.json`), keyed by the plugin name:

```json
{
  "pluginConfigs": {
    "agent-pager": {
      "options": { "backend": "ntfy", "ntfy_topic": "agent-pager-3f9c0e1d2b7a4c55" }
    }
  }
}
```

For a one-off headless run, the same object can be passed with `--settings`.

Careful: values in `pluginConfigs` are stored as plain text. If you put `telegram_token` or `ntfy_token` there, the token sits unencrypted in `settings.json`. The marketplace install keeps them in the system keychain instead.

### Options

| Option | Default | Meaning |
| :- | :- | :- |
| `backend` | `ntfy` | `ntfy`, `telegram` or `off` |
| `ntfy_topic` | empty | Topic to publish to |
| `ntfy_server` | `https://ntfy.sh` | ntfy server |
| `ntfy_token` | empty | Access token (sensitive) |
| `ntfy_inbound` | `false` | Treat messages on the topic as prompts (needs `ntfy_token`) |
| `telegram_token` | empty | Bot token (sensitive) |
| `telegram_chat_id` | empty | The only chat that is read and written |
| `inbound` | `true` | Poll for messages from the phone |
| `poll_seconds` | `5` | Poll interval |
| `min_turn_seconds` | `60` | Shortest turn that pages when it finishes; `0` pages every turn |
| `ask_delay_seconds` | `10` | How long a question waits before it pages |
| `min_gap_seconds` | `30` | Automatic pages closer together than this are dropped |
| `quiet_hours` | empty | Local time range with no automatic pages, like `22-07` or `22:30-06:45` |
| `private_mode` | `false` | Pages, including replies to your phone prompts, say only "Your agent needs you." |
| `notify_errors` | `true` | Page when a turn ends on an API error or a refusal |

## Usage

In Claude Code:

| Command | Does |
| :- | :- |
| `/pager` or `/pager status` | Where pages go (topic masked), whether paging is paused, thresholds, quiet hours (flagged when invalid), last page, last poll or send error |
| `/pager test` | Sends a test page now, ignoring pause, quiet hours and the gap |
| `/pager pause` | Stops automatic pages, in every session, until resumed |
| `/pager resume` | Turns them back on |

Pause and quiet hours apply to automatic pages. The minimum gap applies to routine pages (finished turns, errors); question and permission pages are never dropped for it. Answers to the phone (the reply to a prompt you sent, `/status`, `/stop`) always go out, since you just asked for them.

Normally one session reads the phone's messages. The first interactive session to poll holds a lease and renews it on every poll, and releases it when the session ends; another session takes over once the holder has been quiet for three poll intervals. A takeover can overlap a single poll, so message ids already handled are remembered and never run twice. On Telegram and on ntfy alike, messages sent before the polling session started are skipped, so a prompt from yesterday does not run in today's session. Headless `claude -p` runs send pages but never poll.

A failed poll is shown in `/pager status` and retried with exponential backoff, up to five minutes, or after the wait the server asks for (Telegram's `retry_after`). Error texts never include the bot token.

## Security and privacy

- **No remote approvals.** agent-pager never approves or denies a tool call. A permission prompt is announced on the phone and must be answered in the terminal. This is a deliberate choice for v1: a leaked bot token or topic name should not be able to run commands without your consent at the keyboard.
- **Phone prompts are your own words.** A message from the configured Telegram chat is submitted as if you typed it, so it runs under the session's normal permission rules. Anyone who controls that chat can prompt your agent. Keep the bot token secret.
- **ntfy topics are public by name.** Pages on ntfy.sh can be read by anyone who guesses the topic. Use a long random name, a self-hosted server with an access token, or `private_mode`. `/pager status` shows only the first four characters of the topic.
- **ntfy replies need a token.** `ntfy_inbound` does nothing without `ntfy_token`, since an open topic would let anyone prompt your agent.
- **Telegram groups are ignored.** Only a private chat whose chat id and sender id both match `telegram_chat_id` is read.
- **Private mode** replaces every automatic page, and the reply sent back for a prompt from the phone, with "Your agent needs you." It drops the project name, the reply text and the question. `/pager test` and `/status` replies still name the project.
- **What leaves the machine.** Without private mode: the project folder name, the first 200 characters of a reply or question, and the permission prompt's message. Nothing else from the conversation is sent.
- **Secrets.** `telegram_token` and `ntfy_token` are marked sensitive, so the install screen masks them and Claude Code stores them in the system keychain rather than `settings.json`. Setting them by hand under `pluginConfigs` stores them in plain text.

## Tests

```
claude plugin validate .
claude plugin test .
```

`claude plugin test` runs `hooks/register.test.tsx` against the engine with a mocked `$.http.fetch`, clock and store. It covers the outbound page format, the Telegram private chat and sender filter, inbound messages reaching `$.prompt.submit`, the reply going back for the phone's own turn and not for a keyboard turn in between, `/status` and `/stop` from the phone, subagent turns, rate limits and backoff, the poller lease, quiet hours (valid and invalid), pause and resume, the minimum gap and its urgent exemption, private mode, the question delay, permission and error pages, and ntfy inbound with its stale message and token checks.

Type checking keeps the `tsconfig.json` outside the repository; the recipe is in the header of `types/index.d.ts`.

## Built by RadTech

[RadTech](https://radtech.nl) builds apps, web products and applied AI, and advises founders. We do AI advisory, building and consulting.

Hire us: https://cal.com/radtech-solutions-yjxizt/15min
