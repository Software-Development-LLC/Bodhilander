import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';

// Forward uncaught renderer errors to main process log file
window.onerror = (message, source, lineno, colno, error) => {
  const msg = typeof message === 'string' ? message : 'Unknown error';
  const loc = source ? `${source}:${lineno}:${colno}` : 'unknown';
  window.electronAPI?.logError?.('window.onerror', `${msg} at ${loc}`, error?.stack);
};

window.onunhandledrejection = (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  window.electronAPI?.logError?.('unhandledrejection', msg, stack);
};

// Set up sound player to respond to main process sound events
if (window.electronAPI?.onSoundPlay) {
  window.electronAPI.onSoundPlay(({ path, volume }) => {
    try {
      const audio = new Audio(`file://${path}`);
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.play().catch((err) => {
        console.warn('Failed to play sound:', err);
      });
    } catch (err) {
      console.warn('Failed to create audio:', err);
    }
  });
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<ErrorBoundary><App /></ErrorBoundary>);
}
