import React from 'react';
import { useCodeSearch } from '../hooks/useCodeSearch';
import './IndexStatus.css';

interface IndexStatusProps {
  directoryPath: string | null;
  onClick?: () => void;
  compact?: boolean;
}

export const IndexStatus: React.FC<IndexStatusProps> = ({
  directoryPath,
  onClick,
  compact = false,
}) => {
  const { index, indexProgress, isIndexing, startIndexing } = useCodeSearch(directoryPath);

  if (!directoryPath) {
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onClick) {
      onClick();
    } else if (!index && !isIndexing) {
      startIndexing();
    }
  };

  const getStatusIcon = () => {
    if (isIndexing) {
      return (
        <svg className="index-icon spinning" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
      );
    }

    if (index?.status === 'ready') {
      return (
        <svg className="index-icon ready" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      );
    }

    if (index?.status === 'error') {
      return (
        <svg className="index-icon error" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      );
    }

    // Not indexed
    return (
      <svg className="index-icon not-indexed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
        <path d="M11 8v6M11 16h.01" />
      </svg>
    );
  };

  const getStatusText = () => {
    if (isIndexing && indexProgress) {
      const pct = indexProgress.filesTotal > 0
        ? Math.round((indexProgress.filesIndexed / indexProgress.filesTotal) * 100)
        : 0;
      return `Indexing ${pct}%`;
    }

    if (index?.status === 'ready') {
      return compact ? 'Indexed' : `${index.fileCount} files indexed`;
    }

    if (index?.status === 'error') {
      return 'Index error';
    }

    return 'Not indexed';
  };

  const getStatusClass = () => {
    if (isIndexing) return 'indexing';
    if (index?.status === 'ready') return 'ready';
    if (index?.status === 'error') return 'error';
    return 'not-indexed';
  };

  return (
    <button
      className={`index-status-indicator ${getStatusClass()} ${compact ? 'compact' : ''}`}
      onClick={handleClick}
      title={index?.status === 'ready'
        ? `${index.fileCount} files, ${index.chunkCount} chunks indexed`
        : isIndexing
          ? 'Indexing in progress...'
          : 'Click to index this directory'}
    >
      {getStatusIcon()}
      {!compact && <span className="status-text">{getStatusText()}</span>}
    </button>
  );
};
