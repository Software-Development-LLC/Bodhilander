/**
 * Registers a DOM implementation so component tests can render React.
 *
 * Wired in via `bunfig.toml` -> [test] preload, which Bun applies to EVERY test
 * file in the repo — including `relay/`, which has no DOM but does exercise
 * fetch/WebSocket. happy-dom overwrites those network globals with its own
 * implementations (its `Headers`, for one, strips `cookie` as a forbidden
 * header), which breaks those suites.
 *
 * So: register happy-dom for the DOM, then put Bun's native network/crypto
 * globals back. Component tests only need document/window/HTMLElement.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Capture Bun's natives before happy-dom replaces them.
// Network/crypto only. DOM-side globals (Event, EventTarget, MessageEvent, …)
// must stay happy-dom's, or its event dispatch and React's synthetic events
// stop agreeing.
const preserved = [
  'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File',
  'WebSocket', 'crypto', 'TextEncoder', 'TextDecoder',
  'ReadableStream', 'WritableStream', 'TransformStream',
] as const;

const natives = new Map<string, unknown>();
for (const name of preserved) {
  if (name in globalThis) natives.set(name, (globalThis as Record<string, unknown>)[name]);
}

GlobalRegistrator.register();

// Restore the non-DOM globals happy-dom shadowed.
for (const [name, value] of natives) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}
