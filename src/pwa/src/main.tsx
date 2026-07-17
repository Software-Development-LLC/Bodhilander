/**
 * PWA entry point.
 *
 * Mounts the React root, wires React Query, and sets up react-router with
 * `basename="/m"` so all routes are scoped under the locked /m/* URL space.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { queryClient } from './lib/queryClient';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('PWA root element (#root) missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/m">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
