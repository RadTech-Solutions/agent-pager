// agent-pager: the session state it keeps in $.state, and its config shape.
//
// Type-check recipe (keeps tsconfig out of the repo). From any folder:
//   mkdir -p /tmp/agent-pager-tsc && cat > /tmp/agent-pager-tsc/tsconfig.json <<JSON
//   {
//     "compilerOptions": {
//       "target": "es2023", "lib": ["es2023"], "types": [],
//       "module": "esnext", "moduleResolution": "bundler",
//       "strict": true, "noUncheckedIndexedAccess": true,
//       "noEmit": true, "skipLibCheck": true,
//       "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
//     },
//     "include": ["<repo>/hooks", "<repo>/types", "<repo>/.claude-plugin/types"]
//   }
//   JSON
//   npx -y -p typescript@5.6.3 tsc -p /tmp/agent-pager-tsc
// <repo>/.claude-plugin/types is written by Claude Code each time it loads the
// mod with --plugin-dir (git ignores it). Without it, add the declaration file
// from the plugin-authoring skill (types/claude-code.d.ts) to "include".

export type Backend = 'ntfy' | 'telegram' | 'off'

export type PagerConfig = {
  backend: Backend
  ntfyTopic: string
  ntfyServer: string
  ntfyToken: string
  ntfyInbound: boolean
  telegramToken: string
  telegramChatId: string
  inbound: boolean
  pollMs: number
  minTurnMs: number
  askDelayMs: number
  minGapMs: number
  quietHours: string
  privateMode: boolean
  notifyErrors: boolean
}

export type PageKind = 'turn' | 'question' | 'permission' | 'error' | 'test' | 'reply' | 'status'

export type Page = {
  kind: PageKind
  /** Short label after the project name, like "Turn finished (2m 5s)". */
  label: string
  /** The content: reply excerpt, question text. Left out in private mode. */
  body: string
  /** Bypass pause, quiet hours and the gap: tests and answers to the phone. */
  force?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agent-pager': { busy: boolean; startedAt: number; interactive: boolean; pending: string[]; remoteTurns: string[]; listening: boolean }
  }
}
