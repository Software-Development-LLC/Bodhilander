/**
 * Chat event taxonomy (BDHLNDR-51).
 *
 * The shape downstream tickets BDHLNDR-56 (PWA chat view) and BDHLNDR-58
 * (REST snapshot endpoint) will consume. Treat this as a public contract:
 * adding a new event type is fine, changing an existing payload is not.
 *
 * v1 is deliberately minimal. Out of scope for v1 (do NOT add here without
 * coordinating the downstream tickets): tool-call argument bodies, file-edit
 * diffs, bash output bodies, task-list updates.
 */

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
  payload: {
    /** Tool name as displayed by Claude Code (e.g. "Read", "Edit", "Bash"). */
    tool: string;
    /**
     * One-line summary of the call (path, command, etc.). The full body is
     * intentionally NOT included in v1 — keep these cheap to render in the PWA.
     */
    argsBrief: string;
  };
}

export interface ErrorEvent {
  type: 'error';
  payload: { text: string };
}

export interface PromptYesNoEvent {
  type: 'prompt_yes_no';
  payload: { question: string };
}

export interface PromptOptionsEvent {
  type: 'prompt_options';
  payload: {
    question: string;
    options: Array<{ key: string; label: string }>;
  };
}

export interface ResponseEvent {
  type: 'response';
  payload: { text: string };
}

export type ChatEvent =
  | AssistantTextEvent
  | ToolCallEvent
  | ErrorEvent
  | PromptYesNoEvent
  | PromptOptionsEvent
  | ResponseEvent;

/**
 * Persisted row shape (as stored in the chat_events table). The ChatEvent
 * payload is JSON-stringified into the `payload` column.
 */
export interface PersistedChatEvent {
  id: string;
  sessionId: string;
  type: ChatEventType;
  payload: ChatEvent['payload'];
  /** ms since epoch. */
  timestamp: number;
}
