import React, { useState, useCallback, useRef, useEffect } from 'react';
import './Panel.css';

interface PanelProps {
  isOpen: boolean;
  onToggle: () => void;
  title: string;
  icon?: string;
  children: React.ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

export function Panel({
  isOpen,
  onToggle,
  title,
  icon,
  children,
  defaultWidth = 320,
  minWidth = 250,
  maxWidth = 600,
}: PanelProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const panelRect = panelRef.current.getBoundingClientRect();
      const newWidth = panelRect.right - e.clientX;
      setWidth(Math.min(Math.max(minWidth, newWidth), maxWidth));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, minWidth, maxWidth]);

  if (!isOpen) {
    return null;
  }

  return (
    <aside
      ref={panelRef}
      className={`panel ${isResizing ? 'resizing' : ''}`}
      style={{ width }}
    >
      <div
        className="panel-resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="panel-header">
        <div className="panel-title">
          {icon && <span className="panel-icon">{icon}</span>}
          <span>{title}</span>
        </div>
        <button
          className="panel-close"
          onClick={onToggle}
          title="Close panel"
        >
          &times;
        </button>
      </div>
      <div className="panel-content">
        {children}
      </div>
    </aside>
  );
}
