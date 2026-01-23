import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useCodeSearch } from '../hooks/useCodeSearch';
import { CodeSearchResult, SymbolSearchResult, SymbolType } from '../../shared/types';
import './CodeSearchModal.css';

interface CodeSearchModalProps {
  isOpen: boolean;
  directoryPath: string | null;
  onClose: () => void;
  onResultClick?: (result: CodeSearchResult | SymbolSearchResult) => void;
}

type SearchMode = 'code' | 'symbol';

export const CodeSearchModal: React.FC<CodeSearchModalProps> = ({
  isOpen,
  directoryPath,
  onClose,
  onResultClick,
}) => {
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('code');
  const [symbolType, setSymbolType] = useState<SymbolType | ''>('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout>();

  const {
    index,
    indexProgress,
    isIndexing,
    searchResults,
    symbolResults,
    isSearching,
    searchError,
    startIndexing,
    cancelIndexing,
    searchCode,
    searchSymbols,
    clearResults,
  } = useCodeSearch(directoryPath);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      clearResults();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, clearResults]);

  // Debounced search
  const handleSearch = useCallback((q: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!q.trim()) {
      clearResults();
      return;
    }

    debounceRef.current = setTimeout(() => {
      if (searchMode === 'code') {
        searchCode(q);
      } else {
        searchSymbols(q, symbolType || undefined);
      }
    }, 300);
  }, [searchMode, symbolType, searchCode, searchSymbols, clearResults]);

  // Update search when query changes
  useEffect(() => {
    handleSearch(query);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, handleSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleResultClick = (result: CodeSearchResult | SymbolSearchResult) => {
    onResultClick?.(result);
  };

  const results = searchMode === 'code' ? searchResults : symbolResults;
  const isReady = index?.status === 'ready';
  const needsIndex = !index || index.status === 'error';

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="code-search-modal" onClick={e => e.stopPropagation()}>
        <div className="code-search-header">
          <h3>Code Search</h3>
          <div className="search-mode-tabs">
            <button
              className={`mode-tab ${searchMode === 'code' ? 'active' : ''}`}
              onClick={() => setSearchMode('code')}
            >
              Semantic
            </button>
            <button
              className={`mode-tab ${searchMode === 'symbol' ? 'active' : ''}`}
              onClick={() => setSearchMode('symbol')}
            >
              Symbol
            </button>
          </div>
        </div>

        {/* Index Status */}
        {needsIndex && (
          <div className="index-status not-indexed">
            <span>Directory not indexed</span>
            <button onClick={startIndexing} disabled={isIndexing}>
              {isIndexing ? 'Indexing...' : 'Start Indexing'}
            </button>
          </div>
        )}

        {isIndexing && indexProgress && (
          <div className="index-status indexing">
            <div className="progress-info">
              <span>Indexing: {indexProgress.currentFile}</span>
              <span>{indexProgress.filesIndexed} / {indexProgress.filesTotal} files</span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: indexProgress.filesTotal > 0
                    ? `${(indexProgress.filesIndexed / indexProgress.filesTotal) * 100}%`
                    : '0%'
                }}
              />
            </div>
            <button className="cancel-btn" onClick={cancelIndexing}>Cancel</button>
          </div>
        )}

        {index?.status === 'ready' && (
          <div className="index-status ready">
            <span>{index.fileCount} files indexed ({index.chunkCount} chunks)</span>
          </div>
        )}

        {/* Search Input */}
        <div className="search-input-container">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={searchMode === 'code'
              ? 'Search code semantically...'
              : 'Search for function, class, or method...'}
            disabled={!isReady}
            autoFocus
          />
          {searchMode === 'symbol' && (
            <select
              className="symbol-type-filter"
              value={symbolType}
              onChange={e => setSymbolType(e.target.value as SymbolType | '')}
            >
              <option value="">All types</option>
              <option value="function">Functions</option>
              <option value="class">Classes</option>
              <option value="method">Methods</option>
              <option value="interface">Interfaces</option>
              <option value="type">Types</option>
            </select>
          )}
        </div>

        {/* Search Results */}
        <div className="search-results">
          {isSearching && (
            <div className="search-loading">Searching...</div>
          )}

          {searchError && (
            <div className="search-error">{searchError}</div>
          )}

          {!isSearching && !searchError && query && results.length === 0 && (
            <div className="no-results">No results found</div>
          )}

          {results.length > 0 && (
            <ul className="results-list">
              {searchMode === 'code'
                ? (results as CodeSearchResult[]).map((result, i) => (
                    <li
                      key={`${result.filePath}:${result.startLine}:${i}`}
                      className="result-item code-result"
                      onClick={() => handleResultClick(result)}
                    >
                      <div className="result-header">
                        <span className="file-path">{result.filePath}</span>
                        <span className="line-range">:{result.startLine}-{result.endLine}</span>
                        <span className="score">{Math.round(result.score * 100)}%</span>
                      </div>
                      <pre className="result-preview">{result.content.slice(0, 200)}</pre>
                    </li>
                  ))
                : (results as SymbolSearchResult[]).map((result, i) => (
                    <li
                      key={`${result.filePath}:${result.line}:${i}`}
                      className="result-item symbol-result"
                      onClick={() => handleResultClick(result)}
                    >
                      <div className="symbol-info">
                        <span className={`symbol-type ${result.symbolType}`}>
                          {result.symbolType}
                        </span>
                        <span className="symbol-name">{result.name}</span>
                      </div>
                      <div className="symbol-location">
                        {result.filePath}:{result.line}:{result.column}
                      </div>
                      {result.signature && (
                        <pre className="symbol-signature">{result.signature}</pre>
                      )}
                    </li>
                  ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="close-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
