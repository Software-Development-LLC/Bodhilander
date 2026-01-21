import { getDatabase } from '../database';
import { Memory, MemoryCreateInput, MemoryUpdateInput, MemoryType } from '../../shared/types';

interface MemoryRow {
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

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    sessionId: row.session_id,
    groupId: row.group_id,
    type: row.type as MemoryType,
    content: row.content,
    source: row.source as Memory['source'],
    tags: row.tags ? JSON.parse(row.tags) : [],
    pinned: row.pinned === 1,
    createdAt: new Date(row.created_at),
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
}

export function createMemory(input: MemoryCreateInput): Memory {
  const db = getDatabase();
  const now = new Date().toISOString();
  const tags = input.tags ? JSON.stringify(input.tags) : '[]';
  const pinned = input.pinned ? 1 : 0;

  db.prepare(`
    INSERT INTO memories (id, session_id, group_id, type, content, source, tags, pinned, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.id, input.sessionId, input.groupId, input.type, input.content, input.source, tags, pinned, now);

  return getMemoryById(input.id)!;
}

export function updateMemory(id: string, updates: MemoryUpdateInput): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number)[] = [now];

  if (updates.content !== undefined) {
    sets.push('content = ?');
    values.push(updates.content);
  }
  if (updates.type !== undefined) {
    sets.push('type = ?');
    values.push(updates.type);
  }
  if (updates.tags !== undefined) {
    sets.push('tags = ?');
    values.push(JSON.stringify(updates.tags));
  }
  if (updates.pinned !== undefined) {
    sets.push('pinned = ?');
    values.push(updates.pinned ? 1 : 0);
  }

  values.push(id);
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteMemory(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function getMemoryById(id: string): Memory | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  return row ? rowToMemory(row) : null;
}

export function getMemoriesBySession(sessionId: string): Memory[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM memories WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as MemoryRow[];
  return rows.map(rowToMemory);
}

export function getMemoriesByGroup(groupId: string): Memory[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM memories WHERE group_id = ? ORDER BY created_at DESC').all(groupId) as MemoryRow[];
  return rows.map(rowToMemory);
}

export function getPinnedMemories(groupId?: string): Memory[] {
  const db = getDatabase();
  let rows: MemoryRow[];
  if (groupId) {
    rows = db.prepare('SELECT * FROM memories WHERE pinned = 1 AND group_id = ? ORDER BY created_at DESC').all(groupId) as MemoryRow[];
  } else {
    rows = db.prepare('SELECT * FROM memories WHERE pinned = 1 ORDER BY created_at DESC').all() as MemoryRow[];
  }
  return rows.map(rowToMemory);
}

export function searchMemories(query: string, groupId?: string): Memory[] {
  const db = getDatabase();
  let rows: MemoryRow[];

  // Try FTS5 search first, fall back to LIKE if it fails
  try {
    if (groupId) {
      rows = db.prepare(`
        SELECT m.* FROM memories m
        JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ? AND m.group_id = ?
        ORDER BY rank
      `).all(query, groupId) as MemoryRow[];
    } else {
      rows = db.prepare(`
        SELECT m.* FROM memories m
        JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY rank
      `).all(query) as MemoryRow[];
    }
  } catch {
    // Fallback to LIKE search
    const likeQuery = `%${query}%`;
    if (groupId) {
      rows = db.prepare('SELECT * FROM memories WHERE content LIKE ? AND group_id = ? ORDER BY created_at DESC').all(likeQuery, groupId) as MemoryRow[];
    } else {
      rows = db.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC').all(likeQuery) as MemoryRow[];
    }
  }

  return rows.map(rowToMemory);
}

/**
 * Get memories for injection into a session.
 * Only returns manually-created memories (source = 'manual').
 * Claude can search MCP-added memories on demand.
 * Limited to 8KB total to avoid overwhelming Claude.
 */
export function getMemoriesForInjection(sessionId: string, groupId: string): Memory[] {
  const db = getDatabase();
  const MAX_SIZE = 8 * 1024; // 8KB limit

  // Only inject manually-created memories - Claude can search MCP-added ones via tools
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE source = 'manual'
      AND (session_id = ? OR group_id = ?)
    ORDER BY pinned DESC, created_at DESC
  `).all(sessionId, groupId) as MemoryRow[];

  const memories: Memory[] = [];
  let totalSize = 0;

  for (const row of rows) {
    const memory = rowToMemory(row);
    const memorySize = memory.content.length + (memory.tags.join(',').length);

    if (totalSize + memorySize > MAX_SIZE) {
      break;
    }

    memories.push(memory);
    totalSize += memorySize;
  }

  return memories;
}

/**
 * Find a similar memory to avoid duplicates.
 * Returns a memory if content is very similar (within edit distance threshold).
 */
export function findSimilarMemory(content: string, groupId: string, type: MemoryType): Memory | null {
  const db = getDatabase();

  // Simple deduplication: check for exact or near-exact matches
  const normalizedContent = content.toLowerCase().trim();

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE group_id = ? AND type = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(groupId, type) as MemoryRow[];

  for (const row of rows) {
    const existingNormalized = row.content.toLowerCase().trim();
    // Check for high similarity (>90% overlap)
    if (existingNormalized === normalizedContent) {
      return rowToMemory(row);
    }
    // Check if one is substring of the other
    if (existingNormalized.includes(normalizedContent) || normalizedContent.includes(existingNormalized)) {
      return rowToMemory(row);
    }
  }

  return null;
}
