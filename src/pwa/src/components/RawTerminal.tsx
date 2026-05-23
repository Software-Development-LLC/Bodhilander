/**
 * Raw xterm.js view (BDHLNDR-57) — belt-and-suspenders fallback for the
 * chat view in `/sessions/:sessionId`.
 *
 * Why
 * ---
 * The default view (BDHLNDR-56) parses Claude Code's PTY output into
 * structured chat events. That works great for `claude` sessions but:
 *   - shell sessions (`bash`, `pwsh`, etc.) have no chat conversation to
 *     chatify, so the chat view is mostly empty;
 *   - if the parser ever misses something (new Claude output format,
 *     unexpected ANSI sequence, etc.) the user has no way to see what's
 *     actually on the terminal.
 *
 * This component bypasses the parser entirely — it just renders raw
 * `terminal:output` frames into an xterm.js instance, the same way the
 * desktop renderer does.
 *
 * Mobile constraints (PM-5 mitigation)
 * ------------------------------------
 * We DO NOT resize the PTY from the PWA. The desktop owns the PTY
 * dimensions (~80 cols by default). On a phone, fitting the PTY to the
 * viewport would mangle output on every other open device. Instead, we
 * let xterm render at whatever width the desktop chose and the container
 * scrolls horizontally on narrow viewports. The fit-addon is wired up
 * for future use but `wsClient.send({type: 'terminal:resize', ...})` is
 * never called from here.
 *
 * Input
 * -----
 * Tapping the terminal focuses xterm → the mobile virtual keyboard
 * appears → typed chars (including IME composition output) hit
 * `xterm.onData(d => wsClient.send(...))`. One WS frame per keystroke —
 * the desktop's PTY handles batching/echo. If the device is read-only
 * (no canControl perm), the server emits a generic `error` frame which
 * we surface as a small banner inside this component.
 *
 * Cleanup
 * -------
 * On unmount: dispose xterm, unsubscribe the WS handler, drop the
 * session subscription (ref-counted; the chat view may still be holding
 * one — but in practice we render EITHER chat or raw, not both, so the
 * count drops to zero and the desktop sends `terminal:unsubscribe`).
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

import {
  wsClient,
  type ErrorMessage,
  type TerminalOutputMessage,
} from '../lib/ws';

interface RawTerminalProps {
  sessionId: string;
}

/**
 * Dark theme tuned to match the PWA's neutral-900 backdrop. Mirrors the
 * desktop renderer's palette closely enough that users moving between
 * devices don't get whiplash.
 */
const XTERM_THEME = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(255,255,255,0.2)',
  black: '#000000',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e5e5e5',
  brightBlack: '#525252',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
} as const;

export function RawTerminal({ sessionId }: RawTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [permError, setPermError] = useState<string | null>(null);

  // ---- Mount xterm + wire WS subscriptions -----------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const xterm = new XTerm({
      theme: XTERM_THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      // Default cursorBlink off — saves a redraw loop on mobile.
      cursorBlink: true,
      // Scrollback enough to cover a typical session-end review without
      // ballooning memory on a phone.
      scrollback: 5000,
      // PM-5: do NOT call fit() with the intent of resizing the PTY. We
      // pre-size xterm with desktop-ish dimensions so output stays
      // readable; the container will horizontally scroll on narrow
      // viewports. See file header.
      cols: 80,
      rows: 24,
      // Phones tend to have small viewports; allow text wrapping selection.
      allowProposedApi: false,
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(host);
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Fit vertically only — we don't propagate cols/rows to the PTY (see
    // header). Calling fit() makes xterm size its viewport to the host
    // container; the resulting cols may differ from the PTY's cols, in
    // which case content wider than the viewport scrolls horizontally
    // inside xterm's own scroll area. That's the explicit trade-off.
    try {
      fitAddon.fit();
    } catch {
      // First-paint race with layout — non-fatal, output still renders.
    }

    // Send typed input through the WS — one frame per keystroke. The
    // desktop's `terminal:input` handler writes to the PTY; if the device
    // is read-only, the server replies with an `error` frame which the
    // error handler below picks up.
    const inputDisposable = xterm.onData((data) => {
      wsClient.send({
        type: 'terminal:input',
        sessionId,
        payload: { data },
      });
    });

    // Subscribe to terminal:output for THIS session id only.
    const offOutput = wsClient.on('terminal:output', (msg: TerminalOutputMessage) => {
      if (msg.sessionId !== sessionId) return;
      xterm.write(msg.payload.data);
    });

    // Surface server-side permission failures (read-only paired devices).
    // The server emits a generic `error` frame, not a 403. We can't
    // perfectly attribute it to a specific terminal:input call, but the
    // message text is descriptive enough ("Control permission required").
    const offError = wsClient.on('error', (msg: ErrorMessage) => {
      if (typeof msg.payload?.message === 'string' && /control permission/i.test(msg.payload.message)) {
        setPermError(msg.payload.message);
      }
    });

    // Ensure we're subscribed to session-scoped frames. Ref-counted, so
    // safe even if SessionDetail had its own subscribeSession running.
    const unsubSession = wsClient.subscribeSession(sessionId);

    return () => {
      offOutput();
      offError();
      unsubSession();
      inputDisposable.dispose();
      try {
        xterm.dispose();
      } catch {
        // xterm sometimes throws during dispose if a deferred resize is
        // still queued — non-fatal, mirrors the desktop renderer guard.
      }
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ---- Re-fit on viewport changes (orientation, keyboard) --------------
  // We fit vertically only — see header re: not propagating cols/rows to
  // the PTY. xterm's own column count won't change since the host width
  // is bounded by the viewport, but the row count tracks the host height
  // so the scroll buffer behaves correctly as the keyboard opens/closes.
  useEffect(() => {
    const onResize = () => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Layout race — ignore.
      }
    };
    window.addEventListener('resize', onResize);
    // visualViewport fires when the on-screen keyboard expands/collapses.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      vv?.removeEventListener('resize', onResize);
    };
  }, []);

  // Tapping anywhere on the host focuses xterm so the mobile keyboard
  // opens. The xterm helper textarea is invisible; without an explicit
  // focus call iOS sometimes leaves the keyboard down on the first tap.
  const focusXterm = () => {
    xtermRef.current?.focus();
  };

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-[#0a0a0a]">
      {permError && (
        <div
          role="alert"
          className="border-b border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200"
        >
          {permError} — this device can view but not control. Re-pair as a
          control device to type.
        </div>
      )}
      <div
        ref={hostRef}
        onClick={focusXterm}
        className="flex-1 overflow-auto"
        // The xterm.css handles internal styling; we just provide a
        // scrollable host that occupies the remaining flex space.
      />
    </div>
  );
}
