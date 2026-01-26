import { useState, useEffect, useCallback } from 'react';
import {
  CodeIndex,
  CodeSearchResult,
  SymbolSearchResult,
  IndexProgress,
  SymbolType,
} from '../../shared/types';

export interface UseCodeSearchState {
  // Index state
  index: CodeIndex | null;
  indexProgress: IndexProgress | null;
  isIndexing: boolean;

  // Search state
  searchResults: CodeSearchResult[];
  symbolResults: SymbolSearchResult[];
  isSearching: boolean;
  searchError: string | null;
}

export interface UseCodeSearchActions {
  startIndexing: () => Promise<void>;
  cancelIndexing: () => Promise<void>;
  retryIndexing: () => Promise<void>;
  deleteIndex: () => Promise<void>;
  searchCode: (query: string, limit?: number) => Promise<CodeSearchResult[]>;
  searchSymbols: (name: string, symbolType?: SymbolType, limit?: number) => Promise<SymbolSearchResult[]>;
  refreshIndex: () => Promise<void>;
  clearResults: () => void;
}

export function useCodeSearch(directoryPath: string | null): UseCodeSearchState & UseCodeSearchActions {
  const [index, setIndex] = useState<CodeIndex | null>(null);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [searchResults, setSearchResults] = useState<CodeSearchResult[]>([]);
  const [symbolResults, setSymbolResults] = useState<SymbolSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Refresh index status
  const refreshIndex = useCallback(async () => {
    if (!directoryPath) {
      setIndex(null);
      return;
    }

    try {
      const status = await window.electronAPI.getIndexStatus(directoryPath);
      setIndex(status);
      setIsIndexing(status?.status === 'indexing');
    } catch (err) {
      console.error('Failed to get index status:', err);
    }
  }, [directoryPath]);

  // Subscribe to indexing events
  useEffect(() => {
    const unsubProgress = window.electronAPI.onIndexingProgress((progress) => {
      if (directoryPath && progress.directoryPath === directoryPath) {
        setIndexProgress(progress);
        setIsIndexing(true);
      }
    });

    const unsubComplete = window.electronAPI.onIndexingComplete((data) => {
      // Check by index ID or directoryPath (for re-index case where ID changes)
      if (index?.id === data.indexId || (directoryPath && data.directoryPath === directoryPath)) {
        setIsIndexing(false);
        setIndexProgress(null);
        refreshIndex();
      }
    });

    const unsubError = window.electronAPI.onIndexingError((data) => {
      // Check by index ID or directoryPath (for re-index case where ID changes)
      if (index?.id === data.indexId || (directoryPath && data.directoryPath === directoryPath)) {
        setIsIndexing(false);
        setIndexProgress(null);
        setSearchError(data.error);
        refreshIndex();
      }
    });

    return () => {
      unsubProgress();
      unsubComplete();
      unsubError();
    };
  }, [directoryPath, index?.id, refreshIndex]);

  // Load index status on mount and directory change
  useEffect(() => {
    refreshIndex();
  }, [refreshIndex]);

  // Auto-start indexing if directory has no index, is pending, or has stale 'indexing' status
  useEffect(() => {
    // Only auto-index if we have a directory
    if (!directoryPath) return;

    // Wait for initial load - index will be null initially, then set after refresh
    // We use a small delay to ensure refreshIndex has completed
    const timer = setTimeout(async () => {
      const currentStatus = await window.electronAPI.getIndexStatus(directoryPath);

      // Auto-start if no index exists, status is pending, or stuck in 'indexing' (stale)
      const shouldAutoIndex = !currentStatus ||
        currentStatus.status === 'pending' ||
        currentStatus.status === 'indexing'; // Stale indexing from interrupted session

      if (shouldAutoIndex) {
        console.log('[useCodeSearch] Auto-starting indexing for:', directoryPath, 'status:', currentStatus?.status ?? 'none');
        startIndexing();
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [directoryPath]); // Only run when directoryPath changes, not on every startIndexing change

  // Start indexing
  const startIndexing = useCallback(async () => {
    if (!directoryPath) {
      console.warn('[useCodeSearch] No directoryPath provided');
      return;
    }

    setIsIndexing(true);
    setSearchError(null);

    try {
      const result = await window.electronAPI.startIndexing(directoryPath);
      if (!result.success) {
        setIsIndexing(false);
        setSearchError(result.error ?? 'Failed to start indexing');
      }
    } catch (err) {
      setIsIndexing(false);
      setSearchError(err instanceof Error ? err.message : 'Failed to start indexing');
    }
  }, [directoryPath]);

  // Cancel indexing
  const cancelIndexing = useCallback(async () => {
    if (!index?.id) return;

    try {
      await window.electronAPI.cancelIndexing(index.id);
      setIsIndexing(false);
      setIndexProgress(null);
      await refreshIndex();
    } catch (err) {
      console.error('Failed to cancel indexing:', err);
    }
  }, [index?.id, refreshIndex]);

  // Retry indexing after an error
  const retryIndexing = useCallback(async () => {
    if (!directoryPath) return;

    setIsIndexing(true);
    setSearchError(null);

    try {
      const result = await window.electronAPI.retryIndexing(directoryPath);
      if (!result.success) {
        setIsIndexing(false);
        setSearchError(result.error ?? 'Failed to retry indexing');
      }
    } catch (err) {
      setIsIndexing(false);
      setSearchError(err instanceof Error ? err.message : 'Failed to retry indexing');
    }
  }, [directoryPath]);

  // Delete index
  const deleteIndex = useCallback(async () => {
    if (!directoryPath) return;

    try {
      await window.electronAPI.deleteCodeIndex(directoryPath);
      setIndex(null);
      setSearchResults([]);
      setSymbolResults([]);
    } catch (err) {
      console.error('Failed to delete index:', err);
    }
  }, [directoryPath]);

  // Search code
  const searchCode = useCallback(async (query: string, limit?: number): Promise<CodeSearchResult[]> => {
    if (!directoryPath || !query.trim()) {
      return [];
    }

    setIsSearching(true);
    setSearchError(null);

    try {
      const results = await window.electronAPI.searchCode(directoryPath, query, limit);
      setSearchResults(results);
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      setSearchError(message);
      return [];
    } finally {
      setIsSearching(false);
    }
  }, [directoryPath]);

  // Search symbols
  const searchSymbols = useCallback(async (
    name: string,
    symbolType?: SymbolType,
    limit?: number
  ): Promise<SymbolSearchResult[]> => {
    if (!directoryPath || !name.trim()) {
      return [];
    }

    setIsSearching(true);
    setSearchError(null);

    try {
      const results = await window.electronAPI.searchSymbols(directoryPath, name, symbolType, limit);
      setSymbolResults(results);
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Symbol search failed';
      setSearchError(message);
      return [];
    } finally {
      setIsSearching(false);
    }
  }, [directoryPath]);

  // Clear results
  const clearResults = useCallback(() => {
    setSearchResults([]);
    setSymbolResults([]);
    setSearchError(null);
  }, []);

  return {
    // State
    index,
    indexProgress,
    isIndexing,
    searchResults,
    symbolResults,
    isSearching,
    searchError,
    // Actions
    startIndexing,
    cancelIndexing,
    retryIndexing,
    deleteIndex,
    searchCode,
    searchSymbols,
    refreshIndex,
    clearResults,
  };
}
