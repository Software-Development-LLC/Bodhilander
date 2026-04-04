import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import '../styles/terminal.css';

interface TerminalProps {
  sessionId: string;
  cwd: string;
  launchClaude?: boolean;
  isStopped?: boolean;
  restartKey?: number;
  isActive?: boolean;
  onStart?: () => void;
  onError?: (error: string) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
}

const PASTE_DEBOUNCE_MS = 300;

const Terminal: React.FC<TerminalProps> = ({ sessionId, cwd, launchClaude = true, isStopped = false, restartKey = 0, isActive = false, onStart, onError }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastPasteTimeRef = useRef<number>(0);
  const [isRunning, setIsRunning] = useState(!isStopped);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, hasSelection: false });
  const [error, setError] = useState<string | null>(null);

  // Sync isStopped prop changes to isRunning state (fixes stop button)
  useEffect(() => {
    setIsRunning(!isStopped);
  }, [isStopped]);

  // Handle restart: cycle isRunning off then on to kill PTY and start fresh
  useEffect(() => {
    if (restartKey > 0) {
      setIsRunning(false);
      const timer = setTimeout(() => {
        setError(null);
        setIsRunning(true);
        // Focus terminal after restart is complete (wait for terminal to be created)
        setTimeout(() => {
          if (isActive && xtermRef.current) {
            xtermRef.current.focus();
          }
        }, 200);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [restartKey, isActive]);

  // Listen for focus-terminal event to focus this terminal
  useEffect(() => {
    const handleFocusTerminal = () => {
      if (isActive && xtermRef.current) {
        xtermRef.current.focus();
      }
    };

    window.addEventListener('focus-terminal', handleFocusTerminal);
    return () => window.removeEventListener('focus-terminal', handleFocusTerminal);
  }, [isActive]);

  // Scroll to bottom when terminal becomes active (session switch)
  useEffect(() => {
    if (isActive && xtermRef.current && fitAddonRef.current) {
      // Fit first to ensure dimensions are correct, then scroll to bottom
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        xtermRef.current?.scrollToBottom();
      });
    }
  }, [isActive]);

  // Copy text from terminal selection
  const handleCopy = useCallback(() => {
    const term = xtermRef.current;
    if (term) {
      const selection = term.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection);
      }
    }
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, []);

  // Paste text into terminal (with debounce)
  const handlePaste = useCallback(async () => {
    const now = Date.now();
    if (now - lastPasteTimeRef.current < PASTE_DEBOUNCE_MS) {
      setContextMenu(prev => ({ ...prev, visible: false }));
      return;
    }
    lastPasteTimeRef.current = now;

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        window.electronAPI.writeToSession(sessionId, text);
      }
    } catch (err) {
      console.error('Failed to paste:', err);
    }
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, [sessionId]);

  // Handle right-click context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const term = xtermRef.current;
    const hasSelection = term ? term.getSelection().length > 0 : false;
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      hasSelection,
    });
  }, []);

  // Close context menu when clicking elsewhere
  useEffect(() => {
    const handleClick = () => setContextMenu(prev => ({ ...prev, visible: false }));
    if (contextMenu.visible) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu.visible]);

  useEffect(() => {
    if (!terminalRef.current || !isRunning) return;

    const term = new XTerm({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#2a3570',
      },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Create PTY session with error handling
    window.electronAPI.createSession(sessionId, cwd, launchClaude)
      .then(() => {
        // Immediately send resize after PTY creation to fix Windows ConPTY race condition
        // where input doesn't register until a resize event syncs the terminal
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = xtermRef.current;
          window.electronAPI.resizeSession(sessionId, cols, rows);
        }
      })
      .catch((err) => {
        const errorMsg = err?.message || 'Failed to start session';
        console.error('Failed to create PTY session:', err);
        setError(errorMsg);
        onError?.(errorMsg);
      });

    // Handle PTY data
    const cleanupPtyData = window.electronAPI.onPtyData((id, data) => {
      if (id === sessionId) {
        term.write(data);
      }
    });

    // Handle keyboard shortcuts
    term.attachCustomKeyEventHandler((event) => {
      const isMod = event.ctrlKey || event.metaKey;

      // Ctrl+Shift+C = Copy (only on keydown)
      if (isMod && event.shiftKey && event.key === 'C' && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }
      // Ctrl+Shift+V = Paste (only on keydown, with debounce)
      if (isMod && event.shiftKey && event.key === 'V' && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        if (now - lastPasteTimeRef.current < PASTE_DEBOUNCE_MS) {
          return false;
        }
        lastPasteTimeRef.current = now;

        navigator.clipboard.readText().then(text => {
          if (text) {
            window.electronAPI.writeToSession(sessionId, text);
          }
        });
        return false;
      }

      // Global shortcuts - dispatch to window so useKeyboardShortcuts handles them
      // Use toLowerCase() for case-insensitive matching (key can be 'W' or 'w' depending on shift/OS)
      const key = event.key.toLowerCase();
      const isGlobalShortcut = (
        (isMod && key === 'q') ||                                // Ctrl+Q
        (isMod && event.key === 'Tab') ||                        // Ctrl+Tab
        (isMod && key === 'w') ||                                // Ctrl+W / Ctrl+Shift+W
        (isMod && key === 'n') ||                                // Ctrl+N
        (isMod && key === 'g')                                   // Ctrl+G / Ctrl+Shift+G
      );

      if (isGlobalShortcut && event.type === 'keydown') {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          bubbles: true,
        }));
        return false;
      }

      return true;
    });

    // Handle user input
    term.onData((data) => {
      window.electronAPI.writeToSession(sessionId, data);
    });

    // Handle resize with ResizeObserver for reliable sizing
    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        window.electronAPI.resizeSession(sessionId, cols, rows);
      }
    };

    // Use ResizeObserver to detect when container actually has dimensions
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        requestAnimationFrame(() => {
          handleResize();
        });
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    window.addEventListener('resize', handleResize);

    // Initial fit after layout settles
    requestAnimationFrame(() => {
      setTimeout(() => handleResize(), 50);
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      cleanupPtyData();
      window.electronAPI.killSession(sessionId);
      term.dispose();
    };
  }, [sessionId, cwd, launchClaude, isRunning]);

  const handleStart = () => {
    setError(null);
    setIsRunning(true);
    onStart?.();
  };

  const handleRetry = () => {
    setError(null);
    setIsRunning(false);
    // Small delay then restart
    setTimeout(() => {
      setIsRunning(true);
      onStart?.();
    }, 100);
  };

  if (error) {
    return (
      <div className="terminal-error">
        <div className="error-icon">!</div>
        <p className="error-title">Session Error</p>
        <p className="error-message">{error}</p>
        <div className="error-actions">
          <button onClick={handleRetry}>Retry</button>
        </div>
      </div>
    );
  }

  if (!isRunning) {
    return (
      <div className="terminal-stopped">
        <p>Session stopped</p>
        <button onClick={handleStart}>Start Session</button>
      </div>
    );
  }

  return (
    <>
      <div
        ref={terminalRef}
        className="terminal-container"
        onContextMenu={handleContextMenu}
      />
      {contextMenu.visible && (
        <div
          className="terminal-context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
          }}
        >
          <button
            onClick={handleCopy}
            disabled={!contextMenu.hasSelection}
            className={!contextMenu.hasSelection ? 'disabled' : ''}
          >
            Copy
            <span className="shortcut">Ctrl+Shift+C</span>
          </button>
          <button onClick={handlePaste}>
            Paste
            <span className="shortcut">Ctrl+Shift+V</span>
          </button>
        </div>
      )}
    </>
  );
};

export default Terminal;
