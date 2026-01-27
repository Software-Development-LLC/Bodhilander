#!/usr/bin/env node
/**
 * ClaudeLander Memory MCP Server
 *
 * Provides Claude with tools to access and manage session memories and code search.
 * Communicates with ClaudeLander via HTTP API (no native dependencies).
 *
 * Run as: node dist/mcp-server/index.js
 *
 * Memory Tools:
 * - search_memories: Search for memories by query
 * - add_memory: Add a new memory
 * - list_memories: List recent memories
 * - delete_memory: Delete a memory
 * - pin_memory: Pin/unpin a memory
 * - list_groups: List available groups
 *
 * Code Search Tools:
 * - search_code: Semantic code search using natural language
 * - find_symbol: Find function/class/method definitions
 * - get_index_status: Check if a directory is indexed
 * - list_indexes: List all available code indexes
 * - start_indexing: Start indexing a directory for code search
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ClaudeLander API configuration
const API_BASE = process.env.CLAUDELANDER_API_URL || 'http://127.0.0.1:8443';
const API_PREFIX = '/api/v1/memories';

// Types
interface Memory {
  id: string;
  sessionId: string | null;
  groupId: string;
  type: string;
  content: string;
  source: string;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string | null;
}

interface Group {
  id: string;
  name: string;
}

// HTTP client helpers
async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function apiDelete(path: string): Promise<{ success: boolean }> {
  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<{ success: boolean }>;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

// Memory operations via API
async function searchMemories(
  query: string,
  groupId?: string,
  type?: string,
  limit: number = 20
): Promise<Memory[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (groupId) params.set('group_id', groupId);
  if (type) params.set('type', type);

  const result = await apiGet<{ memories: Memory[] }>(`/search?${params}`);
  return result.memories;
}

async function addMemory(
  content: string,
  type: string,
  groupId: string,
  sessionId?: string,
  tags?: string[]
): Promise<Memory> {
  const result = await apiPost<{ memory: Memory }>('/', {
    content,
    type,
    group_id: groupId,
    session_id: sessionId,
    tags,
  });
  return result.memory;
}

async function listMemories(
  groupId?: string,
  type?: string,
  limit: number = 50
): Promise<Memory[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (groupId) params.set('group_id', groupId);
  if (type) params.set('type', type);

  const result = await apiGet<{ memories: Memory[] }>(`?${params}`);
  return result.memories;
}

async function deleteMemory(id: string): Promise<boolean> {
  try {
    await apiDelete(`/${id}`);
    return true;
  } catch {
    return false;
  }
}

async function pinMemory(id: string, pinned: boolean): Promise<boolean> {
  try {
    await apiPatch(`/${id}/pin`, { pinned });
    return true;
  } catch {
    return false;
  }
}

async function getGroups(): Promise<Group[]> {
  const result = await apiGet<{ groups: Group[] }>('/groups');
  return result.groups;
}

// Check if ClaudeLander is running
async function checkConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
}

// Create and run server
async function main() {
  // Check if ClaudeLander is running
  const isConnected = await checkConnection();
  if (!isConnected) {
    console.error('[MCP Memory] Warning: ClaudeLander is not running. Memory tools will not work until ClaudeLander is started.');
  } else {
    console.error('[MCP Memory] Connected to ClaudeLander API');
  }

  // Create MCP server
  const server = new McpServer({
    name: 'claudelander-memory',
    version: '1.0.0',
  });

  // Register search_memories tool
  server.registerTool(
    'search_memories',
    {
      title: 'Search Memories',
      description: 'Search for memories by keyword or phrase. Use this to find relevant context from past sessions. Requires ClaudeLander to be running.',
      inputSchema: {
        query: z.string().describe('Search query - keywords or phrases to find in memories'),
        group_id: z.string().optional().describe('Filter by group ID. Use list_groups to see available groups.'),
        type: z.enum(['decision', 'error_fix', 'pattern', 'context', 'note']).optional().describe('Filter by memory type'),
        limit: z.number().optional().default(20).describe('Maximum results to return'),
      },
    },
    async ({ query, group_id, type, limit }) => {
      try {
        const memories = await searchMemories(query, group_id, type, limit || 20);
        const text = memories.length > 0
          ? `Found ${memories.length} memories:\n\n${memories
              .map(m => `[${m.type}] ${m.content}${m.pinned ? ' (pinned)' : ''}\n  ID: ${m.id} | Created: ${m.createdAt}`)
              .join('\n\n')}`
          : 'No memories found matching your query.';
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error searching memories: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register add_memory tool
  server.registerTool(
    'add_memory',
    {
      title: 'Add Memory',
      description: 'Store a new memory for future reference. Use this to save important decisions, fixes, patterns, or context. Requires ClaudeLander to be running.',
      inputSchema: {
        content: z.string().describe('The content of the memory to store'),
        type: z.enum(['decision', 'error_fix', 'pattern', 'context', 'note']).describe('Type of memory'),
        group_id: z.string().describe('Group ID to associate the memory with. Use list_groups to see available groups.'),
        session_id: z.string().optional().describe('Session ID to associate with'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
      },
    },
    async ({ content, type, group_id, session_id, tags }) => {
      try {
        const memory = await addMemory(content, type, group_id, session_id, tags);
        return {
          content: [{
            type: 'text',
            text: `Memory stored successfully!\nID: ${memory.id}\nType: ${memory.type}\nContent: ${memory.content}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error adding memory: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register list_memories tool
  server.registerTool(
    'list_memories',
    {
      title: 'List Memories',
      description: 'List recent memories, optionally filtered by group or type. Requires ClaudeLander to be running.',
      inputSchema: {
        group_id: z.string().optional().describe('Filter by group ID'),
        type: z.enum(['decision', 'error_fix', 'pattern', 'context', 'note']).optional().describe('Filter by memory type'),
        limit: z.number().optional().default(50).describe('Maximum results to return'),
      },
    },
    async ({ group_id, type, limit }) => {
      try {
        const memories = await listMemories(group_id, type, limit || 50);
        const text = memories.length > 0
          ? `Found ${memories.length} memories:\n\n${memories
              .map(m => `[${m.type}] ${m.content}${m.pinned ? ' (pinned)' : ''}\n  ID: ${m.id} | Group: ${m.groupId} | Created: ${m.createdAt}`)
              .join('\n\n')}`
          : 'No memories found.';
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error listing memories: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register delete_memory tool
  server.registerTool(
    'delete_memory',
    {
      title: 'Delete Memory',
      description: 'Delete a memory by ID. Requires ClaudeLander to be running.',
      inputSchema: {
        id: z.string().describe('The ID of the memory to delete'),
      },
    },
    async ({ id }) => {
      try {
        const success = await deleteMemory(id);
        return {
          content: [{
            type: 'text',
            text: success ? `Memory ${id} deleted successfully.` : `Memory ${id} not found.`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error deleting memory: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register pin_memory tool
  server.registerTool(
    'pin_memory',
    {
      title: 'Pin Memory',
      description: 'Pin or unpin a memory. Pinned memories appear first in listings. Requires ClaudeLander to be running.',
      inputSchema: {
        id: z.string().describe('The ID of the memory to pin/unpin'),
        pinned: z.boolean().describe('True to pin, false to unpin'),
      },
    },
    async ({ id, pinned }) => {
      try {
        const success = await pinMemory(id, pinned);
        return {
          content: [{
            type: 'text',
            text: success
              ? `Memory ${id} ${pinned ? 'pinned' : 'unpinned'} successfully.`
              : `Memory ${id} not found.`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error updating memory: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register list_groups tool
  server.registerTool(
    'list_groups',
    {
      title: 'List Groups',
      description: 'List available memory groups. Groups organize memories by project/context. Requires ClaudeLander to be running.',
      inputSchema: {},
    },
    async () => {
      try {
        const groups = await getGroups();
        const text = groups.length > 0
          ? `Available groups:\n${groups.map(g => `- ${g.name} (ID: ${g.id})`).join('\n')}`
          : 'No groups found. Create a group in ClaudeLander first.';
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error listing groups: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register search_code tool (semantic code search)
  server.registerTool(
    'search_code',
    {
      title: 'Semantic Code Search',
      description: 'Search the codebase semantically using natural language queries. Returns relevant code chunks ranked by similarity. The codebase must be indexed first. Requires ClaudeLander to be running.',
      inputSchema: {
        query: z.string().describe('Natural language query describing what code to find'),
        path: z.string().optional().describe('Directory path to search in. Defaults to current working directory.'),
        limit: z.number().optional().default(10).describe('Maximum results to return'),
      },
    },
    async ({ query, path, limit }) => {
      try {
        const searchPath = path || process.cwd();
        const params = new URLSearchParams({
          q: query,
          path: searchPath,
          limit: String(limit || 10),
        });

        const response = await fetch(`${API_BASE}/api/v1/code/search?${params}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        const { results } = await response.json() as { results: any[] };

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No matching code found. Make sure the directory is indexed.' }],
          };
        }

        const formatted = results.map((r, i) =>
          `### Result ${i + 1} (${Math.round(r.score * 100)}% match)\n` +
          `**File:** ${r.filePath}:${r.startLine}-${r.endLine}\n` +
          `\`\`\`\n${r.content}\n\`\`\``
        ).join('\n\n');

        return {
          content: [{ type: 'text', text: formatted }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error searching code: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register find_symbol tool
  server.registerTool(
    'find_symbol',
    {
      title: 'Find Symbol Definition',
      description: 'Find where a function, class, method, or other symbol is defined in the codebase. The codebase must be indexed first. Requires ClaudeLander to be running.',
      inputSchema: {
        name: z.string().describe('Name of the symbol to find (function, class, method, variable, interface, or type)'),
        path: z.string().optional().describe('Directory path to search in. Defaults to current working directory.'),
        symbol_type: z.enum(['function', 'class', 'method', 'variable', 'interface', 'type']).optional()
          .describe('Type of symbol to find'),
        limit: z.number().optional().default(20).describe('Maximum results to return'),
      },
    },
    async ({ name, path, symbol_type, limit }) => {
      try {
        const searchPath = path || process.cwd();
        const params = new URLSearchParams({
          name,
          path: searchPath,
          limit: String(limit || 20),
        });
        if (symbol_type) params.set('type', symbol_type);

        const response = await fetch(`${API_BASE}/api/v1/code/symbols?${params}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        const { results } = await response.json() as { results: any[] };

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: `No symbol named "${name}" found. Make sure the directory is indexed.` }],
          };
        }

        const formatted = results.map(r =>
          `- **${r.symbolType}** \`${r.name}\` at ${r.filePath}:${r.line}:${r.column}` +
          (r.signature ? `\n  Signature: \`${r.signature}\`` : '')
        ).join('\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} definition(s):\n\n${formatted}` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error finding symbol: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register get_index_status tool
  server.registerTool(
    'get_index_status',
    {
      title: 'Get Code Index Status',
      description: 'Check if a directory has been indexed for semantic code search. Use this before search_code to verify the codebase is ready for searching. Requires ClaudeLander to be running.',
      inputSchema: {
        path: z.string().describe('Directory path to check. Use the working directory of the current project.'),
      },
    },
    async ({ path }) => {
      try {
        const params = new URLSearchParams({ path });
        const response = await fetch(`${API_BASE}/api/v1/code/index/status?${params}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        const { index } = await response.json() as { index: any | null };

        if (!index) {
          return {
            content: [{ type: 'text', text: `Directory "${path}" has not been indexed.\n\nUse start_indexing to index this codebase for semantic search.` }],
          };
        }

        const statusEmojiMap: Record<string, string> = {
          ready: '✅',
          indexing: '🔄',
          pending: '⏳',
          error: '❌',
          stale: '⚠️',
        };
        const statusEmoji = statusEmojiMap[index.status as string] || '❓';

        const text = `Index Status for: ${path}\n\n` +
          `${statusEmoji} Status: ${index.status}\n` +
          `📁 Files: ${index.fileCount}\n` +
          `📦 Chunks: ${index.chunkCount}\n` +
          `🔣 Symbols: ${index.symbolCount}\n` +
          `🤖 Model: ${index.modelName}\n` +
          (index.lastIndexedAt ? `📅 Last indexed: ${index.lastIndexedAt}\n` : '') +
          (index.errorMessage ? `\n⚠️ Error: ${index.errorMessage}` : '');

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error checking index status: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register list_indexes tool
  server.registerTool(
    'list_indexes',
    {
      title: 'List Code Indexes',
      description: 'List all available code indexes. Shows which directories have been indexed for semantic code search. Requires ClaudeLander to be running.',
      inputSchema: {},
    },
    async () => {
      try {
        const response = await fetch(`${API_BASE}/api/v1/code/indexes`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        const { indexes } = await response.json() as { indexes: any[] };

        if (indexes.length === 0) {
          return {
            content: [{ type: 'text', text: 'No code indexes found.\n\nUse start_indexing to index a codebase for semantic search.' }],
          };
        }

        const statusEmojiMap: Record<string, string> = {
          ready: '✅',
          indexing: '🔄',
          pending: '⏳',
          error: '❌',
          stale: '⚠️',
        };
        const formatted = indexes.map(idx => {
          const statusEmoji = statusEmojiMap[idx.status as string] || '❓';
          return `${statusEmoji} ${idx.directoryPath}\n   Status: ${idx.status} | Files: ${idx.fileCount} | Chunks: ${idx.chunkCount}`;
        }).join('\n\n');

        return {
          content: [{ type: 'text', text: `Found ${indexes.length} code index(es):\n\n${formatted}` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error listing indexes: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Register start_indexing tool
  server.registerTool(
    'start_indexing',
    {
      title: 'Start Code Indexing',
      description: 'Start indexing a directory for semantic code search. WARNING: Indexing can be resource-intensive (CPU, memory) and may take several minutes for large codebases. The index will be built in the background. Use get_index_status to check progress. Requires ClaudeLander to be running.',
      inputSchema: {
        path: z.string().describe('Directory path to index. This should be the root of the codebase you want to search.'),
      },
    },
    async ({ path }) => {
      try {
        const response = await fetch(`${API_BASE}/api/v1/code/index`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
          throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        return {
          content: [{
            type: 'text',
            text: `🚀 Indexing started for: ${path}\n\n` +
              `Indexing runs in the background. This may take several minutes for large codebases.\n\n` +
              `Use get_index_status to check progress.\n` +
              `Once status is "ready", you can use search_code and find_symbol.`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error starting indexing: ${msg}. Is ClaudeLander running?` }] };
      }
    }
  );

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP Memory] Server started');
}

main().catch((err) => {
  console.error('[MCP Memory] Fatal error:', err);
  process.exit(1);
});
