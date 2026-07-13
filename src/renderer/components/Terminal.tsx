import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebglAddon } from 'xterm-addon-webgl';
import 'xterm/css/xterm.css';
import '../styles/terminal.css';

interface TerminalProps {
  sessionId: string;
  cwd: string;
  launchClaude?: boolean;
  /**
   * Provider id for agent sessions (#98). Passed explicitly to pty:create so
   * the launch never depends on the DB row already being persisted (the
   * Terminal mounts optimistically before createDbSession resolves).
   */
  provider?: string;
  isStopped?: boolean;
  restartKey?: number;
  isActive?: boolean;
  sessionState?: string;
  onStart?: () => void;
  onError?: (error: string) => void;
  /**
   * When true, skip the pty:create IPC call — caller has already spawned the
   * pty out-of-band (e.g. the add-account login flow in BDHLNDR-31). The
   * Terminal will just attach its data/exit listeners to `sessionId`.
   */
  externalPty?: boolean;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  hasSelection: boolean;
}

const PASTE_DEBOUNCE_MS = 300;
// BDHLNDR-30: Number of lines from bottom to consider "near bottom" for auto-scroll.
// If the user is within this many lines of the bottom, new output will pin the
// viewport to the bottom. If they've scrolled further up, they won't be disturbed.
const AUTO_SCROLL_THRESHOLD = 5;
// Minimum dimensions to send to the PTY. If fitAddon measures a hidden or
// not-yet-laid-out container it can return as few as 2 cols — sending that to
// the PTY causes Claude to hard-wrap output at the wrong width. Guard against
// this by requiring a sane minimum before propagating a resize.
const MIN_COLS = 10;
const MIN_ROWS = 2;

const Terminal: React.FC<TerminalProps> = ({ sessionId, cwd, launchClaude = true, provider, isStopped = false, restartKey = 0, isActive = false, sessionState, onStart, onError, externalPty = false }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const lastPasteTimeRef = useRef<number>(0);
  const prevSessionStateRef = useRef<string | undefined>(sessionState);
  const [isRunning, setIsRunning] = useState(!isStopped);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, hasSelection: false });
  const [error, setError] = useState<string | null>(null);

  // Track isActive in a ref so handleResize (set up in the main effect which
  // does NOT depend on isActive) can skip hidden terminals. Without this,
  // window-resize and ResizeObserver events call fitAddon.fit() on a
  // display:none container, corrupting xterm's internal column count.
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  // Fit the xterm renderer to the current container size AND propagate the new
  // cols/rows to the PTY (BDHLNDR-12). Kept as a single source of truth so the
  // ResizeObserver, the window resize listener, and the session-activation
  // effect all go through the same path.
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    // Skip hidden terminals entirely. fitAddon.fit() on a display:none
    // container measures ≈2 cols and internally resizes xterm to that bogus
    // value, corrupting the buffer. The session-activation effect handles
    // resize when the terminal becomes visible again.
    if (!isActiveRef.current) return;

    // BDHLNDR-43: fitAddon.fit() drives xterm's internal resize
    // (onResize → _renderService.handleResize / the deferred
    // _pausedResizeTask). If a queued resize (ResizeObserver rAF, window
    // 'resize', activation-effect timers) lands during/after teardown, those
    // xterm internals are undefined and throw the recurring
    // "Cannot read properties of undefined (reading 'handleResize')". Refs are
    // nulled on cleanup so this normally early-returns; this try/catch is the
    // final safety net so any residual dispose/paused-renderer race can never
    // escape to window.onerror (same posture as the BDHLNDR-8 dispose guards).
    try {
      fitAddonRef.current.fit();
      const { cols, rows } = xtermRef.current;
      // Guard: don't propagate bogus dimensions from an unsized container.
      if (cols >= MIN_COLS && rows >= MIN_ROWS) {
        window.electronAPI.resizeSession(sessionId, cols, rows);
      }
    } catch (e) {
      console.warn('[Terminal] resize during teardown (non-fatal):', e);
    }
  }, [sessionId]);

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

  // Refit and scroll to bottom when terminal becomes active (session switch).
  // Critically, this must also resize the PTY (via handleResize) — the
  // previously active layout may have changed while this session was hidden
  // with `display: none` (App.tsx:1293). Without a PTY resize here, the shell
  // keeps emitting at the stale column count and the visible output appears
  // hard-wrapped to a narrow width (BDHLNDR-12).
  //
  // Multiple attempts at increasing delays because:
  // - rAF may fire before the browser has flushed display:none→flex layout
  // - xterm.js internal renderer state may be stale from being hidden
  // - The grid/flex layout may settle across multiple frames
  useEffect(() => {
    if (isActive && xtermRef.current && fitAddonRef.current) {
      const timers: number[] = [];

      requestAnimationFrame(() => {
        handleResize();
        xtermRef.current?.scrollToBottom();
        requestAnimationFrame(() => {
          handleResize();
          xtermRef.current?.scrollToBottom();
        });
      });

      // Safety net attempts at increasing delays for slow layout transitions
      for (const delay of [100, 250, 500]) {
        timers.push(window.setTimeout(() => {
          if (fitAddonRef.current && xtermRef.current) {
            handleResize();
            xtermRef.current.scrollToBottom();
          }
        }, delay));
      }

      return () => timers.forEach(t => clearTimeout(t));
    }
  }, [isActive, handleResize]);

  // Scroll to bottom when Claude transitions to idle or waiting (i.e. it
  // finished a burst of work). This keeps the latest output visible without
  // the user having to manually scroll down after every task.
  useEffect(() => {
    const prev = prevSessionStateRef.current;
    prevSessionStateRef.current = sessionState;

    if (!xtermRef.current || !isActive) return;

    const scrollTargets = ['idle', 'waiting'];
    if (sessionState && scrollTargets.includes(sessionState) && prev && prev !== sessionState) {
      requestAnimationFrame(() => {
        xtermRef.current?.scrollToBottom();
      });
    }
  }, [sessionState, isActive]);

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

  // Handle Edit menu events from the menu bar
  useEffect(() => {
    if (!isActive) return;

    const cleanups: (() => void)[] = [];

    cleanups.push(window.electronAPI.onMenuCopy(() => {
      const term = xtermRef.current;
      if (term) {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
      }
    }));

    cleanups.push(window.electronAPI.onMenuPaste(async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          window.electronAPI.writeToSession(sessionId, text);
        }
      } catch (err) {
        console.error('Failed to paste:', err);
      }
    }));

    cleanups.push(window.electronAPI.onMenuSelectAll(() => {
      const term = xtermRef.current;
      if (term) {
        term.selectAll();
      }
    }));

    cleanups.push(window.electronAPI.onMenuClearTerminal(() => {
      const term = xtermRef.current;
      if (term) {
        term.clear();
      }
    }));

    return () => cleanups.forEach(fn => fn());
  }, [isActive, sessionId]);

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

    let mounted = true;

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
      minimumContrastRatio: 4.5,
      // BDHLNDR-13: xterm.js defaults to 1000 lines, which fills up quickly
      // during Claude Code sessions. 10k lines ≈ 2MB/terminal — negligible.
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    // Load WebGL renderer after terminal is fully rendered for better performance.
    // Guard with `mounted` so the addon is not attached after effect cleanup —
    // otherwise its dispose cascades through a torn-down RenderService and crashes.
    requestAnimationFrame(() => {
      if (!mounted) return;
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => { webglAddon.dispose(); });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
      } catch (e) {
        console.warn('WebGL addon failed to load, using canvas renderer:', e);
      }
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Create PTY session with error handling. When externalPty is true, the
    // caller has already spawned the pty out-of-band (account login flow,
    // BDHLNDR-31) and we should just attach listeners below.
    if (externalPty) {
      // Still kick a resize so the initial dimensions reach the existing pty.
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        if (cols >= MIN_COLS && rows >= MIN_ROWS) {
          window.electronAPI.resizeSession(sessionId, cols, rows);
        }
      }
    } else {
      window.electronAPI.createSession(sessionId, cwd, launchClaude, provider)
        .then(() => {
          // Send resize after PTY creation to fix Windows ConPTY race condition
          // where input doesn't register until a resize event syncs the terminal.
          // Guard against bogus dimensions from a container that hasn't laid out yet.
          if (fitAddonRef.current && xtermRef.current) {
            fitAddonRef.current.fit();
            const { cols, rows } = xtermRef.current;
            if (cols >= MIN_COLS && rows >= MIN_ROWS) {
              window.electronAPI.resizeSession(sessionId, cols, rows);
            }
          }
        })
        .catch((err) => {
          const errorMsg = err?.message || 'Failed to start session';
          console.error('Failed to create PTY session:', err);
          setError(errorMsg);
          onError?.(errorMsg);
        });
    }

    // Handle PTY data with smart auto-scroll (BDHLNDR-30)
    // During rapid streaming — especially when Claude rewrites lines in-place
    // (task lists, progress indicators) via ANSI cursor-movement codes — the
    // xterm.js viewport can desync and jump to random positions. Fix: if the
    // user is near the bottom before the write, schedule a single
    // requestAnimationFrame scroll correction that fires after the browser has
    // processed all writes and redraws for that frame.
    let scrollRafId = 0;
    // BDHLNDR-43: the ResizeObserver schedules a deferred handleResize via rAF;
    // tracked so cleanup can cancel it before it fires into a disposed xterm.
    let resizeRafId = 0;
    let shouldPin = false;
    const cleanupPtyData = window.electronAPI.onPtyData((id, data) => {
      if (id === sessionId) {
        const buf = term.buffer.active;
        const nearBottom = (buf.baseY - buf.viewportY) <= AUTO_SCROLL_THRESHOLD;
        if (nearBottom) {
          shouldPin = true;
        }
        term.write(data);
        // Coalesce: many writes per frame → one scroll correction after paint
        if (shouldPin && !scrollRafId) {
          scrollRafId = requestAnimationFrame(() => {
            scrollRafId = 0;
            if (shouldPin) {
              term.scrollToBottom();
              shouldPin = false;
            }
          });
        }
      }
    });

    // Prime external ptys (BDHLNDR-33). The login-flow pty in the Add Account
    // modal is spawned in main before this component renders, so any output
    // claude produced during the IPC round-trip + React render would be lost.
    // primePty asks main to flush the accumulated scrollback as a 'data' event
    // and unlock live emission atomically — the listener above receives the
    // flush first, then subsequent live events in correct order.
    if (externalPty) {
      window.electronAPI.primePty(sessionId);
    }

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

    // Use the hoisted handleResize (BDHLNDR-12) so the ResizeObserver, window
    // resize listener, and session-activation effect all share one fit+PTY-resize path.

    // Use ResizeObserver to detect when container actually has dimensions
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        if (resizeRafId) cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
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
      mounted = false;
      if (scrollRafId) cancelAnimationFrame(scrollRafId);
      // BDHLNDR-43: cancel the ResizeObserver's deferred resize so it can't
      // fire handleResize into the disposed terminal after this cleanup.
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      cleanupPtyData();
      window.electronAPI.killSession(sessionId);

      // Dispose the WebGL addon explicitly before term.dispose() so its internal
      // RenderService is still valid. Letting term.dispose() cascade into the
      // addon can throw "Cannot read properties of undefined (reading 'onRequestRedraw')"
      // when the addon was loaded async and is being torn down in the same tick.
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose();
        } catch (e) {
          console.warn('WebGL addon dispose error (non-fatal):', e);
        }
        webglAddonRef.current = null;
      }

      // Safety net: never let a terminal/addon dispose error escape to the React tree.
      try {
        term.dispose();
      } catch (e) {
        console.warn('Terminal dispose error (non-fatal):', e);
      }

      // BDHLNDR-43: null the refs so any handleResize that still slips through
      // (a window 'resize' between dispose and listener removal, or the
      // activation-effect rAF/timer chain) hits the early-return guard instead
      // of calling fit() on the disposed terminal.
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, cwd, launchClaude, isRunning, handleResize]);

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
