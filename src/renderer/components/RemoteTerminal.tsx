import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import '../styles/terminal.css';

interface RemoteTerminalProps {
  code: string;
  permission: 'read' | 'control';
  isActive: boolean;
}

const RemoteTerminal: React.FC<RemoteTerminalProps> = ({ code, permission, isActive }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  // Listen for focus-terminal event
  useEffect(() => {
    const handleFocusTerminal = () => {
      if (isActive && xtermRef.current) {
        xtermRef.current.focus();
      }
    };

    window.addEventListener('focus-terminal', handleFocusTerminal);
    return () => window.removeEventListener('focus-terminal', handleFocusTerminal);
  }, [isActive]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: permission === 'control' ? '#d4d4d4' : '#666666',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#2a3570',
      },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: permission === 'control',
      disableStdin: permission === 'read',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle incoming data from host
    const cleanupData = window.electronAPI.onShareData((event) => {
      if (event.code === code) {
        term.write(event.data);
      }
    });

    // Handle disconnection
    const cleanupEnded = window.electronAPI.onShareEnded((event) => {
      if (event.code === code) {
        setDisconnected(true);
        term.write('\r\n\x1b[31m[Host disconnected]\x1b[0m\r\n');
      }
    });

    // Handle keyboard shortcuts
    term.attachCustomKeyEventHandler((event) => {
      const isMod = event.ctrlKey || event.metaKey;

      // Ctrl+Shift+C = Copy
      if (isMod && event.shiftKey && event.key === 'C') {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }

      // Global shortcuts
      const key = event.key.toLowerCase();
      const isGlobalShortcut = (
        (isMod && key === 'q') ||
        (isMod && event.key === 'Tab') ||
        (isMod && key === 'w') ||
        (isMod && key === 'n') ||
        (isMod && key === 'g')
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

    // Handle user input (only if control permission)
    if (permission === 'control') {
      term.onData((data) => {
        window.electronAPI.writeToRemote(code, data);
      });
    }

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        requestAnimationFrame(handleResize);
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    window.addEventListener('resize', handleResize);
    requestAnimationFrame(() => setTimeout(handleResize, 50));

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      cleanupData();
      cleanupEnded();
      term.dispose();
    };
  }, [code, permission]);

  if (disconnected) {
    return (
      <div className="terminal-error">
        <div className="error-icon">!</div>
        <p className="error-title">Session Ended</p>
        <p className="error-message">The host has disconnected.</p>
      </div>
    );
  }

  return (
    <div
      ref={terminalRef}
      className="terminal-container"
    />
  );
};

export default RemoteTerminal;
