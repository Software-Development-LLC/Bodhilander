/**
 * PWA-local copies of shared domain types (BDHLNDR-55).
 *
 * The canonical definitions live in `src/shared/types.ts`, but the PWA
 * tsconfig pins `rootDir` to `src/pwa`, and the shared module transitively
 * pulls in Electron types (via repositories etc.) — importing from outside
 * `rootDir` would either fail compilation or bloat the bundle with
 * Node/Electron-only declarations.
 *
 * We therefore redefine the narrow subset the PWA actually consumes over
 * the wire (REST + WS payloads). Keep these in sync with the server-side
 * `Session` / `Group` shapes; any new field used by the PWA needs adding
 * here too.
 *
 * Note on `Date` vs `string`: the server JSON-encodes `Date` values to ISO
 * strings, so over the wire these fields arrive as strings. We type them
 * as `string` here to match runtime reality — the PWA doesn't need
 * millisecond-level date math on these.
 */

export type SessionState =
  | 'idle'
  | 'working'
  | 'waiting'
  | 'error'
  | 'stopped';

export interface Session {
  id: string;
  groupId: string;
  name: string;
  workingDir: string;
  state: SessionState;
  shellType: string;
  order: number;
  createdAt: string;
  lastActivityAt: string;
  claudeSessionId: string | null;
  endedAt: string | null;
  durationSeconds: number;
  claudeAccountId: string | null;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  order: number;
  createdAt: string;
  parentId: string | null;
  collapsed: boolean;
  claudeAccountId: string | null;
}

// ---------------------------------------------------------------------------
// Chat events (BDHLNDR-56)
// ---------------------------------------------------------------------------
//
// PWA-local mirror of the chat event taxonomy defined server-side in
// `src/main/api/chat-parser/types.ts` (BDHLNDR-51). We intentionally do NOT
// import from `src/main` — that path pulls Electron and Node-only deps into
// the PWA bundle. Keep these in sync with the server-side definitions; any
// new event type added there needs adding here too.
//
// The wire payload arrives both via:
//   - REST snapshot: GET /api/v1/sessions/:id/chat-events  (BDHLNDR-58)
//   - WS live updates: `chat:event` frames (typed `unknown` in ws.ts, narrowed
//     to `ChatEvent` at the use site in SessionDetail).

export type ChatEventType =
  | 'assistant_text'
  | 'tool_call'
  | 'error'
  | 'prompt_yes_no'
  | 'prompt_options'
  | 'response';

export interface AssistantTextEvent {
  type: 'assistant_text';
  payload: { text: string };
}

export interface ToolCallEvent {
  type: 'tool_call';
  payload: { tool: string; argsBrief: string };
}

export interface ChatErrorEvent {
  type: 'error';
  payload: { text: string };
}

export interface PromptYesNoEvent {
  type: 'prompt_yes_no';
  payload: { question: string };
}

export interface PromptOption {
  key: string;
  label: string;
}

export interface PromptOptionsEvent {
  type: 'prompt_options';
  payload: { question: string; options: PromptOption[] };
}

export interface ResponseEvent {
  type: 'response';
  payload: { text: string };
}

export type ChatEvent =
  | AssistantTextEvent
  | ToolCallEvent
  | ChatErrorEvent
  | PromptYesNoEvent
  | PromptOptionsEvent
  | ResponseEvent;

/**
 * Server-persisted row shape — the REST snapshot endpoint returns these
 * directly. `payload` is the same union of payload shapes from `ChatEvent`,
 * keyed by `type`.
 */
export interface PersistedChatEvent {
  id: string;
  sessionId: string;
  type: ChatEventType;
  payload: ChatEvent['payload'];
  /** ms since epoch. */
  timestamp: number;
}

/**
 * Narrow an unknown WS `chat:event` payload to a typed `ChatEvent`. Returns
 * `null` when the shape doesn't match — caller should drop the frame and log.
 */
export function narrowChatEvent(payload: unknown): ChatEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { type?: unknown; payload?: unknown };
  const inner = p.payload as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== 'object') return null;
  switch (p.type) {
    case 'assistant_text':
      return typeof inner.text === 'string'
        ? { type: 'assistant_text', payload: { text: inner.text } }
        : null;
    case 'tool_call':
      return typeof inner.tool === 'string' && typeof inner.argsBrief === 'string'
        ? { type: 'tool_call', payload: { tool: inner.tool, argsBrief: inner.argsBrief } }
        : null;
    case 'error':
      return typeof inner.text === 'string'
        ? { type: 'error', payload: { text: inner.text } }
        : null;
    case 'prompt_yes_no':
      return typeof inner.question === 'string'
        ? { type: 'prompt_yes_no', payload: { question: inner.question } }
        : null;
    case 'prompt_options':
      if (typeof inner.question !== 'string' || !Array.isArray(inner.options)) return null;
      {
        const options: PromptOption[] = [];
        for (const o of inner.options as unknown[]) {
          if (!o || typeof o !== 'object') return null;
          const opt = o as { key?: unknown; label?: unknown };
          if (typeof opt.key !== 'string' || typeof opt.label !== 'string') return null;
          options.push({ key: opt.key, label: opt.label });
        }
        return {
          type: 'prompt_options',
          payload: { question: inner.question, options },
        };
      }
    case 'response':
      return typeof inner.text === 'string'
        ? { type: 'response', payload: { text: inner.text } }
        : null;
    default:
      return null;
  }
}
