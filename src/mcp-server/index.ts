#!/usr/bin/env node
/**
 * ClaudeLander Memory MCP Server
 *
 * Provides Claude with tools to access and manage session memories.
 * Run as: node dist/mcp-server/index.js
 *
 * Tools exposed:
 * - search_memories: Search for memories by query
 * - add_memory: Add a new memory
 * - list_memories: List recent memories
 * - delete_memory: Delete a memory
 * - pin_memory: Pin/unpin a memory
 * - list_groups: List available groups
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Types
interface Memory {
  id: string;
  session_id: string | null;
  group_id: string;
  type: string;
  content: string;
  source: string;
  tags: string | null;
  pinned: number;
  created_at: string;
  updated_at: string | null;
}

// Find ClaudeLander database
function findDatabase(): string {
  const possiblePaths = [
    // Standard app data location (Windows)
    path.join(os.homedir(), 'AppData', 'Roaming', 'claudelander', 'claudelander.db'),
    // Linux
    path.join(os.homedir(), '.config', 'claudelander', 'claudelander.db'),
    // Mac App Support
    path.join(os.homedir(), 'Library', 'Application Support', 'claudelander', 'claudelander.db'),
    // Development - current directory
    path.join(process.cwd(), 'claudelander.db'),
  ];

  // Check environment variable first
  if (process.env.CLAUDELANDER_DB) {
    if (fs.existsSync(process.env.CLAUDELANDER_DB)) {
      return process.env.CLAUDELANDER_DB;
    }
  }

  for (const dbPath of possiblePaths) {
    if (fs.existsSync(dbPath)) {
      return dbPath;
    }
  }

  throw new Error(
    'ClaudeLander database not found. Make sure ClaudeLander has been run at least once, ' +
    'or set CLAUDELANDER_DB environment variable to the database path.'
  );
}

// Initialize database connection
let db: Database.Database;

function initDatabase(): void {
  const dbPath = findDatabase();
  console.error(`[MCP Memory] Connecting to database: ${dbPath}`);
  db = new Database(dbPath, { readonly: false });
}

// Memory operations
function searchMemories(query: string, groupId?: string, type?: string, limit: number = 20): Memory[] {
  let sql: string;
  const params: (string | number)[] = [];

  if (query.trim()) {
    // Try FTS first, fall back to LIKE
    sql = `SELECT * FROM memories WHERE content LIKE ?`;
    params.push(`%${query}%`);
  } else {
    sql = `SELECT * FROM memories WHERE 1=1`;
  }

  if (groupId) {
    sql += ` AND group_id = ?`;
    params.push(groupId);
  }

  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY pinned DESC, created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Memory[];
}

function addMemory(
  content: string,
  type: string,
  groupId: string,
  sessionId?: string,
  tags?: string[]
): Memory {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const sql = `
    INSERT INTO memories (id, session_id, group_id, type, content, source, tags, pinned, created_at)
    VALUES (?, ?, ?, ?, ?, 'claude', ?, 0, ?)
  `;

  db.prepare(sql).run(
    id,
    sessionId || null,
    groupId,
    type,
    content,
    tags ? JSON.stringify(tags) : null,
    now
  );

  return {
    id,
    session_id: sessionId || null,
    group_id: groupId,
    type,
    content,
    source: 'claude',
    tags: tags ? JSON.stringify(tags) : null,
    pinned: 0,
    created_at: now,
    updated_at: null,
  };
}

function listMemories(groupId?: string, type?: string, limit: number = 50): Memory[] {
  let sql = `SELECT * FROM memories WHERE 1=1`;
  const params: (string | number)[] = [];

  if (groupId) {
    sql += ` AND group_id = ?`;
    params.push(groupId);
  }

  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY pinned DESC, created_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Memory[];
}

function deleteMemory(id: string): boolean {
  const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  return result.changes > 0;
}

function pinMemory(id: string, pinned: boolean): boolean {
  const result = db.prepare(`UPDATE memories SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, id);
  return result.changes > 0;
}

function getGroups(): Array<{ id: string; name: string }> {
  return db.prepare(`SELECT id, name FROM groups ORDER BY name`).all() as Array<{ id: string; name: string }>;
}

// Create and run server
async function main() {
  // Initialize database
  try {
    initDatabase();
  } catch (err) {
    console.error(`[MCP Memory] Failed to initialize database: ${err}`);
    process.exit(1);
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
      description: 'Search for memories by keyword or phrase. Use this to find relevant context from past sessions.',
      inputSchema: {
        query: z.string().describe('Search query - keywords or phrases to find in memories'),
        group_id: z.string().optional().describe('Filter by group ID. Use list_groups to see available groups.'),
        type: z.enum(['decision', 'error_fix', 'pattern', 'context', 'note']).optional().describe('Filter by memory type'),
        limit: z.number().optional().default(20).describe('Maximum results to return'),
      },
    },
    async ({ query, group_id, type, limit }) => {
      const memories = searchMemories(query, group_id, type, limit || 20);
      const text = memories.length > 0
        ? `Found ${memories.length} memories:\n\n${memories
            .map(m => `[${m.type}] ${m.content}${m.pinned ? ' (pinned)' : ''}\n  ID: ${m.id} | Created: ${m.created_at}`)
            .join('\n\n')}`
        : 'No memories found matching your query.';
      return { content: [{ type: 'text', text }] };
    }
  );

  // Register add_memory tool
  server.registerTool(
    'add_memory',
    {
      title: 'Add Memory',
      description: 'Store a new memory for future reference. Use this to save important decisions, fixes, patterns, or context.',
      inputSchema: {
        content: z.string().describe('The content of the memory to store'),
        type: z.enum(['decision', 'error_fix', 'pattern', 'context', 'note']).describe('Type of memory'),
        group_id: z.string().describe('Group ID to associate the memory with. Use list_groups to see available groups.'),
        session_id: z.string().optional().describe('Session ID to associate with'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
      },
    },
    async ({ content, type, group_id, session_id, tags }) => {
      const memory = addMemory(content, type, group_id, session_id, tags);
      return {
        content: [{
          type: 'text',
          text: `Memory stored successfully!\nID: ${memory.id}\nType: ${memory.type}\nContent: ${memory.content}`,
        }],
      };
    }
  );

  // Register list_memories tool
  server.registerTool(
    'list_memories',
    {
      title: 'List Memories',
      description: 'List recent memories, optionally filtered by group or type.',
      inputSchema: {
        group_id: z.string().optional().describe('Filter by group ID'),
        type: z.enum(['decision', 'error_fix', 'pattern', 'context', 'note']).optional().describe('Filter by memory type'),
        limit: z.number().optional().default(50).describe('Maximum results to return'),
      },
    },
    async ({ group_id, type, limit }) => {
      const memories = listMemories(group_id, type, limit || 50);
      const text = memories.length > 0
        ? `Found ${memories.length} memories:\n\n${memories
            .map(m => `[${m.type}] ${m.content}${m.pinned ? ' (pinned)' : ''}\n  ID: ${m.id} | Group: ${m.group_id} | Created: ${m.created_at}`)
            .join('\n\n')}`
        : 'No memories found.';
      return { content: [{ type: 'text', text }] };
    }
  );

  // Register delete_memory tool
  server.registerTool(
    'delete_memory',
    {
      title: 'Delete Memory',
      description: 'Delete a memory by ID.',
      inputSchema: {
        id: z.string().describe('The ID of the memory to delete'),
      },
    },
    async ({ id }) => {
      const success = deleteMemory(id);
      return {
        content: [{
          type: 'text',
          text: success ? `Memory ${id} deleted successfully.` : `Memory ${id} not found.`,
        }],
      };
    }
  );

  // Register pin_memory tool
  server.registerTool(
    'pin_memory',
    {
      title: 'Pin Memory',
      description: 'Pin or unpin a memory. Pinned memories appear first in listings.',
      inputSchema: {
        id: z.string().describe('The ID of the memory to pin/unpin'),
        pinned: z.boolean().describe('True to pin, false to unpin'),
      },
    },
    async ({ id, pinned }) => {
      const success = pinMemory(id, pinned);
      return {
        content: [{
          type: 'text',
          text: success
            ? `Memory ${id} ${pinned ? 'pinned' : 'unpinned'} successfully.`
            : `Memory ${id} not found.`,
        }],
      };
    }
  );

  // Register list_groups tool
  server.registerTool(
    'list_groups',
    {
      title: 'List Groups',
      description: 'List available memory groups. Groups organize memories by project/context.',
      inputSchema: {},
    },
    async () => {
      const groups = getGroups();
      const text = groups.length > 0
        ? `Available groups:\n${groups.map(g => `- ${g.name} (ID: ${g.id})`).join('\n')}`
        : 'No groups found. Create a group in ClaudeLander first.';
      return { content: [{ type: 'text', text }] };
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
