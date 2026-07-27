#!/usr/bin/env node
/**
 * Bodhilander Hook Handler
 *
 * This script is called by Claude Code hooks to report session activity.
 * It receives hook data on stdin and calls the Bodhilander API, which records
 * the events the analytics views read.
 *
 * Usage: node bodhilander-hook.js <hook-type> [--session-id <id>]
 *
 * Hook types: PostToolUse, Stop, Notification
 */

const API_BASE = process.env.BODHILANDER_API_URL || 'http://127.0.0.1:8443';
const API_PREFIX = '/api/v1/hooks';

interface HookInput {
  // PostToolUse fields
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;

  // Stop fields
  stop_reason?: string;

  // Notification fields
  type?: string;
  message?: string;

  // Session context (if available)
  session_id?: string;
  cwd?: string;
}

/**
 * Read all input from stdin
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const stdin = process.stdin;

    stdin.setEncoding('utf8');

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        data += chunk;
      }
    });

    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);

    // Handle case where stdin is already closed (no input)
    if (stdin.readableEnded) {
      resolve(data);
    }
  });
}

/**
 * Call the Bodhilander API
 */
async function callApi(endpoint: string, data: Record<string, unknown>): Promise<unknown> {
  try {
    const response = await fetch(`${API_BASE}${API_PREFIX}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json();
  } catch (error) {
    // Don't fail loudly - Bodhilander might not be running
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Bodhilander Hook] API call failed: ${message}`);
    return null;
  }
}

/**
 * Process PostToolUse hook
 */
async function handlePostToolUse(input: HookInput, sessionId?: string): Promise<void> {
  if (!input.tool_name) return;

  // Deliberately send only the tool NAME, never tool_input/tool_response.
  //
  // /post-tool-use reads exactly { tool_name, session_id } — the payload was
  // the last vestige of the removed memory feature, which used it to sniff git
  // commits. Forwarding it now would actively break analytics: tool_response
  // carries the full tool output (an entire file for Read, all matches for
  // Grep, complete stdout for Bash), and the API server caps bodies at 1mb, so
  // the largest tool calls would 413 and their tool_use events would vanish —
  // silently, since callApi swallows transport errors by design.
  await callApi('/post-tool-use', {
    tool_name: input.tool_name,
    session_id: sessionId || input.session_id,
  });
}

/**
 * Process Stop hook
 */
async function handleStop(input: HookInput, sessionId?: string): Promise<void> {
  await callApi('/stop', {
    session_id: sessionId || input.session_id,
    stop_reason: input.stop_reason,
  });
}

/**
 * Process Notification hook
 */
async function handleNotification(input: HookInput, sessionId?: string): Promise<void> {
  await callApi('/notification', {
    session_id: sessionId || input.session_id,
    notification_type: input.type,
    message: input.message,
  });
}

/**
 * Parse command line arguments
 */
function parseArgs(): { hookType: string; sessionId?: string } {
  const args = process.argv.slice(2);
  let hookType = 'PostToolUse';
  // Use BODHILANDER_SESSION_ID env var (set by the session provider's launch env, src/main/providers) as default
  let sessionId: string | undefined = process.env.BODHILANDER_SESSION_ID;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session-id' && args[i + 1]) {
      sessionId = args[++i];
    } else if (!args[i].startsWith('-')) {
      hookType = args[i];
    }
  }

  return { hookType, sessionId };
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const { hookType, sessionId } = parseArgs();

  // Read hook data from stdin
  let inputData: string;
  try {
    inputData = await readStdin();
  } catch (error) {
    console.error('[Bodhilander Hook] Failed to read stdin:', error);
    return;
  }

  // Parse JSON input
  let input: HookInput;
  try {
    input = inputData.trim() ? JSON.parse(inputData) : {};
  } catch (error) {
    console.error('[Bodhilander Hook] Failed to parse JSON input:', error);
    return;
  }

  // Process based on hook type
  switch (hookType) {
    case 'PostToolUse':
      await handlePostToolUse(input, sessionId);
      break;
    case 'Stop':
      await handleStop(input, sessionId);
      break;
    case 'Notification':
      await handleNotification(input, sessionId);
      break;
    default:
      console.error(`[Bodhilander Hook] Unknown hook type: ${hookType}`);
  }

  // Output empty JSON to indicate success (Claude Code expects this)
  console.log('{}');
}

main().catch((error) => {
  console.error('[Bodhilander Hook] Fatal error:', error);
  process.exit(1);
});
