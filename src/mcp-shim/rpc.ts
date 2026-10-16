/**
 * Newline-delimited JSON-RPC over stdio, the MCP stdio transport. Hand-rolled
 * for the same reason as scripts/permission-broker.js: three methods do not
 * justify a dependency inside a bundle that has to stand on its own.
 */
import { TOOLS, ToolResult } from './tools';

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface RpcDeps {
  version: string;
  callTool: (name: string, args: unknown) => Promise<ToolResult>;
}

const FALLBACK_PROTOCOL = '2025-06-18';

/** The response to send, or null for a notification, which must not be answered. */
export async function handleMessage(message: RpcMessage, deps: RpcDeps): Promise<object | null> {
  const id = message.id;
  if (id === undefined || id === null) return null;
  const respond = (result: unknown) => ({ jsonrpc: '2.0', id, result });

  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return respond({
        protocolVersion: typeof requested === 'string' ? requested : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'bodhilander', version: deps.version },
      });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call needs a tool name' } };
      }
      return respond(await deps.callTool(name, message.params?.arguments));
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

/** Feed stdin chunks in; complete lines come out as parsed messages. */
export function lineReader(onMessage: (message: RpcMessage) => void): (chunk: string) => void {
  let buffered = '';
  return (chunk) => {
    buffered += chunk;
    let cut: number;
    while ((cut = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as RpcMessage);
      } catch {
        // A line that is not JSON is not a request; there is no id to answer.
      }
    }
  };
}
