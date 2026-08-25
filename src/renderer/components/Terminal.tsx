import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebglAddon } from 'xterm-addon-webgl';
import { ProviderInstallHint, RelayResizeRequest } from '../../shared/types';
import { ProviderInstallModal } from './ProviderInstallModal';
import { KEEP_MY_SIZE, RESIZE_ONCE, resizeRequestCopy, shouldPrompt } from './resizeRequestPrompt';
// The keyboard scheme lives in one place — see the table at the top of
// useKeyboardShortcuts.ts. Importing the predicates (instead of re-deriving
// them here) is what keeps the xterm allowlist and the app handler in sync.
import { IS_MAC, isAppShortcut, isCopyShortcut, isPasteShortcut } from '../hooks/useKeyboardShortcuts';
import 'xterm/css/xterm.css';
import '../styles/terminal.css';

interface TerminalProps {
  sessionId: string;
  cwd: string;
  launchClaude?: boolean;
  /**
   * Provider id for agent sessions (#98). Forwarded to pty:create as a
   * fallback for first launches where the Terminal mounted before
   * createDbSession persisted the row; once the row exists it is
   * authoritative (#96).
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
// Context-menu hints. Copy/paste are Cmd+C/Cmd+V on macOS and Ctrl+Shift+C/V
// elsewhere, because bare Ctrl+C must stay available to send SIGINT.
const COPY_SHORTCUT_LABEL = IS_MAC ? 'Cmd+C' : 'Ctrl+Shift+C';
const PASTE_SHORTCUT_LABEL = IS_MAC ? 'Cmd+V' : 'Ctrl+Shift+V';

const Terminal: React.FC<TerminalProps> = ({ sessionId, cwd, launchClaude = true, provider, isStopped = false, restartKey = 0, isActive = false, sessionState, onStart, onError, externalPty = false }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const lastPasteTimeRef = useRef<number>(0);
  const prevSessionStateRef = useRef<string | undefined>(sessionState);
  const [isRunning, setIsRunning] = useState(!isStopped);
  /**
   * A restart or retry is between "killed the pty" and "spawned its
   * replacement" (#164).
   *
   * Waiting for the process to really die replaced a 100ms flash with a wait
   * as long as Claude Code takes to exit, and the stopped view — "Session
   * stopped", with a Start button — is the wrong thing to show for seconds of
   * it. It reads as a failed restart, and its Start button spawns a pty with no
   * kill and no ordering, which is precisely the create-before-death race this
   * whole change removes. So the in-between gets its own view, with no button
   * to press.
   */
  const [restarting, setRestarting] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, hasSelection: false });
  const [error, setError] = useState<string | null>(null);
  // Launch-failure hint from main (provider CLI missing or broken): shown as
  // a dismissible banner over the terminal, with a one-click (re)install.
  const [installHint, setInstallHint] = useState<ProviderInstallHint | null>(null);
  const [installFlow, setInstallFlow] = useState<{ ptyId: string; command: string } | null>(null);
  const [installSucceeded, setInstallSucceeded] = useState(false);
  // Dynamic sizing: when a remote/mobile viewer shrinks the shared PTY below this
  // desktop's size, we show a banner + a Resume button. `desktopSizeRef` tracks
  // the size THIS window last asked for, so we can tell a mobile resize (smaller,
  // unrequested) from our own.
  const desktopSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [mobileSize, setMobileSize] = useState<{ cols: number; rows: number } | null>(null);
  // A guest asked to be fitted to their screen. Held until the owner answers:
  // guests never resize this PTY themselves, so nothing has happened yet.
  const [resizeRequest, setResizeRequest] = useState<RelayResizeRequest | null>(null);
  // Whether this window is currently holding a size it granted to a guest.
  const heldFitRef = useRef(false);

  // Track isActive in a ref so handleResize (set up in the main effect which
  // does NOT depend on isActive) can skip background sessions without a layout
  // measurement. It is only a fast path — the authoritative "is this terminal
  // actually on screen" test lives in handleResize itself, because isActive
  // says nothing about which content view is showing.
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);

  // Whether this component is still on screen (#164). The restart/retry paths
  // now await the pty's real death, so their continuation runs at a moment no
  // effect scope covers — closing the session mid-restart must not flip a
  // torn-down terminal back to "running" and respawn the pty behind it. This is
  // component lifetime, distinct from the per-run `mounted` flag inside the
  // xterm effect, which only guards that effect's own async work.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Stop is a decision the user can take DURING a restart's kill window, and
  // that window is now as long as the process takes to die (#164). The [isStopped]
  // effect below can't carry it: it sets isRunning to false, which it already
  // is mid-restart, so React re-renders nothing and the restart's continuation
  // goes on to spawn a replacement the user just asked not to exist. Worse, a
  // second Stop click changes no prop, so that effect never fires again. The
  // ref lets the continuation read the prop as of the moment it resumes.
  const isStoppedRef = useRef(isStopped);
  useEffect(() => { isStoppedRef.current = isStopped; }, [isStopped]);

  // Fit the xterm renderer to the current container size AND propagate the new
  // cols/rows to the PTY (BDHLNDR-12). Kept as a single source of truth so the
  // ResizeObserver, the window resize listener, and the session-activation
  // effect all go through the same path.
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    // Cheap first cut: a non-active session is always hidden (App.tsx gives
    // every .terminal-wrapper but the active one display:none), so this
    // early-out spares the layout flush below for every background session on
    // each window resize.
    if (!isActiveRef.current) return;
    // A fit granted to a guest is held until this window takes it back on
    // purpose. Without this the next focus, window resize or session switch
    // re-measures an unchanged container and pushes the desktop grid back —
    // silently, and with no message to the guest, who cannot ask again for
    // ten seconds and is panning a 164-column terminal in the meantime.
    if (heldFitRef.current) return;
    // …but isActive only tracks which SESSION is selected; it says nothing
    // about which CONTENT VIEW is showing. App.tsx hides the whole
    // .terminal-area with display:none while Analytics or Arena is active, and
    // those are first-class destinations with their own accelerators — so the
    // active session is routinely off-screen. fitAddon.fit() on a hidden
    // container measures ≈2 cols and reflows xterm to that bogus width,
    // re-wrapping the entire scrollback; the MIN_COLS guard below only stops
    // the bogus size reaching the PTY, far too late to save the buffer. Gate on
    // ACTUAL visibility instead. A display:none ancestor makes
    // getBoundingClientRect() all-zero — the same condition the ResizeObserver
    // already screens for on its own path. What re-fits the terminal when the
    // view comes back is that same ResizeObserver, firing on the 0 → N
    // contentRect transition — NOT the session-activation effect, which keys on
    // the selected session and does not re-run when only the content view
    // changes. Do not remove the observer on the assumption that it does.
    const rect = terminalRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;

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
        desktopSizeRef.current = { cols, rows };
        setMobileSize(null); // we're (re)asserting the desktop's own size
        window.electronAPI.resizeSession(sessionId, cols, rows);
      }
    } catch (e) {
      console.warn('[Terminal] resize during teardown (non-fatal):', e);
    }
  }, [sessionId]);

  // Resume the desktop's own size (undo a mobile viewer's shrink, or a fit
  // this window granted to a guest — taking it back is a deliberate act).
  const resumeDesktopSize = useCallback(() => {
    heldFitRef.current = false;
    setMobileSize(null);
    handleResize();
  }, [handleResize]);

  // Dynamic sizing: react to PTY resizes driven by another viewer. If the shared
  // terminal was shrunk (by a phone) below this window's size, follow it locally
  // (so nothing renders stale/garbled) and show the banner. When it matches our
  // own size again, clear the banner.
  useEffect(() => {
    return window.electronAPI.onPtyResize((id, cols, rows) => {
      if (id !== sessionId) return;
      const desk = desktopSizeRef.current;
      if (!desk) return; // haven't fit yet — nothing to compare against
      if (cols === desk.cols && rows === desk.rows) {
        // Back at this window's own size by some other route — whatever was
        // being held for a guest is over, so re-fitting is allowed again.
        heldFitRef.current = false;
        setMobileSize(null);
        return;
      }
      if (cols < desk.cols || rows < desk.rows) {
        setMobileSize({ cols, rows });
        try { xtermRef.current?.resize(cols, rows); } catch { /* disposed */ }
      }
    });
  }, [sessionId]);

  // A guest asked for this session to be fitted to their screen. It is a
  // request and only a request: it reaches a prompt, never the PTY.
  useEffect(() => {
    return window.electronAPI.onRelayResizeRequest((request) => {
      if (!shouldPrompt(request, sessionId, desktopSizeRef.current)) return;
      // The prompt in front of the owner is the one they answer. Replacing it
      // means the size they read is not the size they agree to — a second
      // guest asking between the reading and the click would resize this
      // terminal to a number nobody ever saw.
      setResizeRequest((pending) => pending ?? request);
    });
  }, [sessionId]);

  // Accepting resizes once — one act, not a standing rule. The size is then
  // HELD against this window's own re-fits until the owner takes it back
  // through the banner below, because a fit that dies at the next focus is a
  // promise to the guest that this window quietly breaks.
  const acceptResizeRequest = useCallback(() => {
    const request = resizeRequest;
    setResizeRequest(null);
    if (!request) return;
    heldFitRef.current = true;
    setMobileSize({ cols: request.cols, rows: request.rows });
    try { xtermRef.current?.resize(request.cols, request.rows); } catch { /* disposed */ }
    window.electronAPI.resizeSession(sessionId, request.cols, request.rows);
  }, [resizeRequest, sessionId]);

  // Declining tells the guest nothing and changes nothing: their view stays
  // exactly as it was, and they may ask again later.
  const declineResizeRequest = useCallback(() => setResizeRequest(null), []);

  // Surface provider launch failures (spawn ENOENT / command not found)
  // detected by main for this session's pty.
  useEffect(() => {
    if (externalPty) return; // login/install ptys never produce hints
    return window.electronAPI.onProviderInstallHint((hint) => {
      if (hint.sessionId === sessionId) {
        setInstallHint(hint);
        setInstallSucceeded(false);
      }
    });
  }, [sessionId, externalPty]);

  const handleRunInstall = useCallback(async () => {
    if (!installHint?.installCommand) return;
    // Install commands run remote scripts / global npm installs — show the
    // exact command before executing anything.
    if (!window.confirm(`This will run in your shell:\n\n${installHint.installCommand}\n\nContinue?`)) return;
    try {
      const flow = await window.electronAPI.runProviderInstall(installHint.providerId);
      setInstallFlow(flow);
    } catch (err) {
      console.error('Failed to start provider install:', err);
    }
  }, [installHint]);

  // Sync isStopped prop changes to isRunning state (fixes stop button)
  useEffect(() => {
    setIsRunning(!isStopped);
  }, [isStopped]);

  /**
   * Restart: kill the pty, wait for it to actually be dead, then spawn again.
   *
   * This used to be a fixed 100ms timer (#164). Claude Code takes far longer
   * than that to exit, so the replacement pty was inserted under this session
   * id while the old one was still dying — and the old process's exit then
   * landed on its own replacement. Depending on the exit code that either
   * orphaned the new pty (main dropped it from its map, so every keystroke and
   * every byte of output was silently discarded and the switch looked like a
   * no-op) or ran the BDHLNDR-9 resume-failure fallback against it, which
   * cleared the stored conversation UUID and started the user over on a blank
   * conversation. 'pty:kill' is an invoke handle now and main resolves it on
   * the process's real exit, so the respawn is ordered after the death instead
   * of guessing at how long one takes.
   *
   * Deliberately NOT keyed on isActive: this effect kills a pty, and re-running
   * it because the user clicked a different session in the sidebar would
   * restart every session that has ever been restarted, every time focus moved.
   * The focus follow-up reads isActiveRef so it still only steals focus for the
   * session actually on screen.
   */
  useEffect(() => {
    if (restartKey === 0) return;

    let cancelled = false;
    let focusTimer: number | undefined;

    setIsRunning(false);
    setRestarting(true);

    void (async () => {
      try {
        await window.electronAPI.killSession(sessionId);
      } catch (err) {
        // safeHandle re-throws into the renderer now, so a kill can fail here.
        // A session left stopped is worse than one restarted over a pty that
        // may still be draining — main coalesces per id, so the respawn's own
        // kill still waits on whatever teardown is in flight.
        console.warn('Kill before restart failed; restarting anyway:', err);
      }
      if (cancelled || !isMountedRef.current) return;
      setRestarting(false);
      // The user pressed Stop while we were waiting for the old pty to die.
      // The kill they wanted has already happened; finishing the restart would
      // hand them back a running session they explicitly asked to end.
      if (isStoppedRef.current) return;
      setError(null);
      setIsRunning(true);
      // Focus after the replacement terminal has had a frame to be created.
      focusTimer = window.setTimeout(() => {
        if (isActiveRef.current && xtermRef.current) {
          xtermRef.current.focus();
        }
      }, 200);
    })();

    return () => {
      cancelled = true;
      setRestarting(false);
      if (focusTimer !== undefined) clearTimeout(focusTimer);
    };
  }, [restartKey, sessionId]);

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

  // Paste is the one clipboard action that is NOT idempotent, and it can reach
  // us from three places: the context menu, the terminal's own key handler, and
  // the Edit menu accelerator (main -> 'menu:paste'). Funnel all three through
  // here so PASTE_DEBOUNCE_MS collapses any duplicate delivery into a single
  // write to the PTY.
  const pasteFromClipboard = useCallback(async () => {
    const now = Date.now();
    if (now - lastPasteTimeRef.current < PASTE_DEBOUNCE_MS) return;
    lastPasteTimeRef.current = now;

    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        window.electronAPI.writeToSession(sessionId, text);
      }
    } catch (err) {
      console.error('Failed to paste:', err);
    }
  }, [sessionId]);

  // Paste text into terminal (context menu entry point)
  const handlePaste = useCallback(async () => {
    await pasteFromClipboard();
    setContextMenu(prev => ({ ...prev, visible: false }));
  }, [pasteFromClipboard]);

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

    cleanups.push(window.electronAPI.onMenuPaste(() => {
      // Shares the debounce with the key handler and context menu — if a
      // platform ever delivers the accelerator to both the menu and the
      // renderer, the second one is swallowed instead of pasting twice.
      pasteFromClipboard();
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
  }, [isActive, sessionId, pasteFromClipboard]);

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

    // Keyboard routing. The scheme (and the reason for it) lives in
    // hooks/useKeyboardShortcuts.ts. Only two classes of keystroke are taken
    // from the terminal here:
    //   1. the terminal-local copy/paste bindings, and
    //   2. app-level shortcuts, which are simply withheld from the PTY and left
    //      to bubble to the window listener in useKeyboardShortcuts.
    // EVERYTHING else returns true and goes straight to the PTY. That is what
    // makes bare Ctrl+C (SIGINT), Ctrl+W (delete word), Ctrl+N (history),
    // Ctrl+G (abort), Ctrl+Q (XON), Ctrl+A/E (line motion), Ctrl+K (kill line)
    // and Ctrl+F work again — the old allowlist matched `ctrlKey || metaKey`
    // and swallowed all of them, while simultaneously failing to forward the
    // view shortcuts, so Analytics never opened while the terminal had focus
    // (i.e. essentially always).
    term.attachCustomKeyEventHandler((event) => {
      // Copy — Cmd+C (macOS) / Ctrl+Shift+C (Windows/Linux)
      if (isCopyShortcut(event) && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }

      // Paste — Cmd+V (macOS) / Ctrl+Shift+V (Windows/Linux). Goes through the
      // shared debounce so it can never double-paste alongside the Edit menu.
      if (isPasteShortcut(event) && event.type === 'keydown') {
        event.preventDefault();
        event.stopPropagation();
        pasteFromClipboard();
        return false;
      }

      // App-level shortcuts: keep them away from the PTY and let the ORIGINAL
      // event carry on to the window listener in useKeyboardShortcuts.
      //
      // Do NOT re-dispatch a synthetic KeyboardEvent here. Returning false is
      // all xterm needs — its handler is
      //   _keyDown(e){ ... if (this._customKeyEventHandler(e) === false) return false; ... }
      // which bails BEFORE its cancel(e), so it never calls preventDefault or
      // stopPropagation. The real event therefore still bubbles from xterm's
      // hidden <textarea> up to window, where useKeyboardShortcuts' keydown
      // listener handles it exactly once. A synthetic dispatch would be a
      // SECOND delivery: New Group fired twice, creating two groups and opening
      // two directory pickers.
      //
      // Unlike copy/paste above we also must not preventDefault/stopPropagation
      // — that would kill the very bubble the window listener depends on.
      if (isAppShortcut(event) && event.type === 'keydown') {
        return false;
      }

      // Not ours — the shell gets it.
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
    // Dynamic sizing: a remote viewer (phone) can shrink the shared PTY to fit
    // its screen while the user is away. When the desktop window regains focus,
    // re-assert its own fit size so the terminal snaps back to full width.
    window.addEventListener('focus', handleResize);

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
      window.removeEventListener('focus', handleResize);
      resizeObserver.disconnect();
      cleanupPtyData();
      // killSession is an invoke handle now (#164) and safeHandle re-throws, so
      // an unswallowed rejection here would surface as an unhandled rejection
      // during teardown — reported by window.onunhandledrejection with no
      // context and nothing the user can act on. Silent on purpose: a cleanup
      // has no UI left to report into, and the restart path above logs the same
      // failure at the point where it still means something.
      void window.electronAPI.killSession(sessionId).catch(() => {});

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
  }, [sessionId, cwd, launchClaude, isRunning, handleResize, pasteFromClipboard]);

  /**
   * Start a stopped session — and, like every other respawn path, only once
   * whatever pty this id had is gone (#164).
   *
   * Stop's own kill comes from the xterm effect's cleanup, which is
   * fire-and-forget, so nothing used to order it against the create that a
   * Start issues next. Killing again is free when there is nothing to kill:
   * main resolves immediately for an unknown id, and joins the teardown
   * already in flight when there is one.
   */
  const handleStart = () => {
    setError(null);
    setInstallHint(null);
    setInstallSucceeded(false);
    void (async () => {
      try {
        await window.electronAPI.killSession(sessionId);
      } catch (err) {
        console.warn('Kill before start failed; starting anyway:', err);
      }
      if (!isMountedRef.current) return;
      setIsRunning(true);
      onStart?.();
    })();
  };

  // Same ordering rule as the restart effect (#164): the old pty has to be gone
  // before a replacement is spawned under the same session id, or the dying
  // process's exit lands on its successor. The 100ms guess this replaces was
  // the shorter of the two windows, since a retry usually follows a launch that
  // already failed — but "usually already dead" is not an ordering guarantee.
  const handleRetry = () => {
    setError(null);
    setInstallHint(null);
    setInstallSucceeded(false);
    setIsRunning(false);
    setRestarting(true);
    void (async () => {
      try {
        await window.electronAPI.killSession(sessionId);
      } catch (err) {
        console.warn('Kill before retry failed; retrying anyway:', err);
      }
      if (!isMountedRef.current) return;
      setRestarting(false);
      if (isStoppedRef.current) return;
      setIsRunning(true);
      onStart?.();
    })();
  };

  // Launch-failure banner + install modal, shared by the running and stopped
  // views (a 'missing' CLI usually exits the shell, flipping this component
  // into its stopped state — the hint must survive that).
  const renderBannerText = (hint: ProviderInstallHint): React.ReactNode => {
    if (installSucceeded) {
      return <>Install finished — restart the session to try again.</>;
    }
    if (hint.kind === 'missing') {
      return (
        <>
          The {hint.providerName} CLI (<code>{hint.command}</code>) wasn't found on your
          PATH. Install it with <code>{hint.installHint}</code>, or let Bodhilander do it.
        </>
      );
    }
    return (
      <>
        The <code>{hint.command}</code> CLI is installed but failed to start — its install
        looks broken (often a missing native binary after an interrupted or
        wrong-architecture install). Reinstalling usually fixes it.
      </>
    );
  };

  const renderBannerAction = (hint: ProviderInstallHint): React.ReactNode => {
    if (installSucceeded) {
      return <button className="primary" onClick={handleRetry}>Restart session</button>;
    }
    if (hint.installCommand) {
      return (
        <button className="primary" disabled={!!installFlow} onClick={handleRunInstall}>
          {hint.kind === 'missing' ? 'Install for me' : 'Reinstall for me'}
        </button>
      );
    }
    return null;
  };

  const installHintUi = installHint && (
    <>
      <div className="provider-install-banner">
        <div className="provider-install-banner-text">{renderBannerText(installHint)}</div>
        <div className="provider-install-banner-actions">
          {renderBannerAction(installHint)}
          <button onClick={() => window.electronAPI.openExternal(installHint.docsUrl)}>Docs ↗</button>
          <button onClick={() => setInstallHint(null)}>Dismiss</button>
        </div>
      </div>
      {installFlow && (
        <ProviderInstallModal
          providerName={installHint.providerName}
          command={installFlow.command}
          ptyId={installFlow.ptyId}
          onClose={(succeeded) => {
            setInstallFlow(null);
            if (succeeded) setInstallSucceeded(true);
          }}
        />
      )}
    </>
  );

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

  // Ordered before the stopped view on purpose: both are "no terminal on
  // screen", but only one of them is waiting for something, and only one of
  // them should offer a button that spawns a pty (#164).
  if (restarting) {
    return (
      <output className="terminal-stopped terminal-restarting">
        {installHintUi}
        <p>Waiting for the session to exit…</p>
        <p className="terminal-restarting-detail">
          It will start again on its own. Claude Code can take a few seconds to shut down.
        </p>
      </output>
    );
  }

  if (!isRunning) {
    return (
      <div className="terminal-stopped">
        {installHintUi}
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
      {resizeRequest && (
        <output className="resize-request-banner">
          <span className="resize-request-text">
            👀 {resizeRequestCopy(resizeRequest, desktopSizeRef.current)}
          </span>
          <div className="resize-request-actions">
            <button className="primary" onClick={acceptResizeRequest}>{RESIZE_ONCE}</button>
            <button onClick={declineResizeRequest}>{KEEP_MY_SIZE}</button>
          </div>
        </output>
      )}
      {mobileSize && (
        <div className="mobile-resize-banner">
          <span className="mobile-resize-banner-text">
            📱 Resized to fit a mobile viewer ({mobileSize.cols}×{mobileSize.rows}).
          </span>
          <button className="mobile-resize-banner-btn" onClick={resumeDesktopSize}>
            Resume desktop size
          </button>
        </div>
      )}
      {installHintUi}
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
            Copy{' '}
            <span className="shortcut">{COPY_SHORTCUT_LABEL}</span>
          </button>
          <button onClick={handlePaste}>
            Paste{' '}
            <span className="shortcut">{PASTE_SHORTCUT_LABEL}</span>
          </button>
        </div>
      )}
    </>
  );
};

export default Terminal;
