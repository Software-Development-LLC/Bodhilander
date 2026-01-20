import { useState, useEffect, useCallback } from 'react';
import { Memory, MemoryType, MemoryCreateInput, MemoryUpdateInput } from '../../shared/types';

interface UseMemoriesResult {
  memories: Memory[];
  pinnedMemories: Memory[];
  loading: boolean;
  error: string | null;
  searchQuery: string;
  searchResults: Memory[] | null;

  // Actions
  createMemory: (type: MemoryType, content: string, tags?: string[]) => Promise<Memory | null>;
  updateMemory: (id: string, updates: MemoryUpdateInput) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  refresh: () => Promise<void>;
}

export function useMemories(
  sessionId: string | null,
  groupId: string | null
): UseMemoriesResult {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [pinnedMemories, setPinnedMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Memory[] | null>(null);

  // Load memories
  const loadMemories = useCallback(async () => {
    if (!groupId) {
      setMemories([]);
      setPinnedMemories([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // Load session memories (or group memories if no session)
      let sessionMemories: Memory[] = [];
      if (sessionId) {
        sessionMemories = await window.electronAPI.getMemoriesBySession(sessionId);
      }

      // Load group memories (for context)
      const groupMemories = await window.electronAPI.getMemoriesByGroup(groupId);

      // Load pinned memories
      const pinned = await window.electronAPI.getPinnedMemories(groupId);

      // Combine: session-specific first, then group (excluding duplicates)
      const sessionIds = new Set(sessionMemories.map(m => m.id));
      const combined = [
        ...sessionMemories,
        ...groupMemories.filter(m => !sessionIds.has(m.id) && !m.sessionId),
      ];

      setMemories(combined);
      setPinnedMemories(pinned);
    } catch (err) {
      console.error('Failed to load memories:', err);
      setError(err instanceof Error ? err.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, [sessionId, groupId]);

  // Initial load
  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  // Listen for extracted memories
  useEffect(() => {
    const unsubscribe = window.electronAPI.onMemoryExtracted((memory) => {
      if (memory.groupId === groupId) {
        setMemories(prev => [memory, ...prev]);
        if (memory.pinned) {
          setPinnedMemories(prev => [memory, ...prev]);
        }
      }
    });
    return unsubscribe;
  }, [groupId]);

  const createMemory = useCallback(async (
    type: MemoryType,
    content: string,
    tags: string[] = []
  ): Promise<Memory | null> => {
    if (!groupId) return null;

    try {
      const input: MemoryCreateInput = {
        id: crypto.randomUUID(),
        sessionId: sessionId,
        groupId: groupId,
        type,
        content,
        source: 'manual',
        tags,
        pinned: false,
      };

      const memory = await window.electronAPI.createMemory(input);
      setMemories(prev => [memory, ...prev]);
      return memory;
    } catch (err) {
      console.error('Failed to create memory:', err);
      setError(err instanceof Error ? err.message : 'Failed to create memory');
      return null;
    }
  }, [sessionId, groupId]);

  const updateMemory = useCallback(async (id: string, updates: MemoryUpdateInput) => {
    try {
      await window.electronAPI.updateMemory(id, updates);

      // Update local state
      setMemories(prev => prev.map(m =>
        m.id === id ? { ...m, ...updates, updatedAt: new Date() } : m
      ));

      // Update pinned if pin status changed
      if (updates.pinned !== undefined) {
        if (updates.pinned) {
          const memory = memories.find(m => m.id === id);
          if (memory) {
            setPinnedMemories(prev => [{ ...memory, pinned: true }, ...prev.filter(m => m.id !== id)]);
          }
        } else {
          setPinnedMemories(prev => prev.filter(m => m.id !== id));
        }
      }
    } catch (err) {
      console.error('Failed to update memory:', err);
      setError(err instanceof Error ? err.message : 'Failed to update memory');
    }
  }, [memories]);

  const deleteMemory = useCallback(async (id: string) => {
    try {
      await window.electronAPI.deleteMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
      setPinnedMemories(prev => prev.filter(m => m.id !== id));
      if (searchResults) {
        setSearchResults(prev => prev?.filter(m => m.id !== id) || null);
      }
    } catch (err) {
      console.error('Failed to delete memory:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete memory');
    }
  }, [searchResults]);

  const togglePin = useCallback(async (id: string) => {
    const memory = memories.find(m => m.id === id);
    if (memory) {
      await updateMemory(id, { pinned: !memory.pinned });
    }
  }, [memories, updateMemory]);

  const search = useCallback(async (query: string) => {
    setSearchQuery(query);

    if (!query.trim()) {
      setSearchResults(null);
      return;
    }

    try {
      const results = await window.electronAPI.searchMemories(query, groupId || undefined);
      setSearchResults(results);
    } catch (err) {
      console.error('Failed to search memories:', err);
      setError(err instanceof Error ? err.message : 'Search failed');
    }
  }, [groupId]);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults(null);
  }, []);

  const refresh = useCallback(async () => {
    await loadMemories();
  }, [loadMemories]);

  return {
    memories,
    pinnedMemories,
    loading,
    error,
    searchQuery,
    searchResults,
    createMemory,
    updateMemory,
    deleteMemory,
    togglePin,
    search,
    clearSearch,
    refresh,
  };
}
