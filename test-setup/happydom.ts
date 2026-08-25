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
import log from 'electron-log';

/**
 * Stop the suite writing into the installed app's log file.
 *
 * electron-log's file transport resolves a default path per platform — on macOS
 * `~/Library/Logs/<appName>/main.log`, which is the same file a running
 * Bodhilander is appending to. Any module under test that imports electron-log
 * therefore logs into it, at an offset of its own, while the app writes at its
 * own: the two interleave and overwrite, and the result is a log that is not a
 * record of either.
 *
 * That is not a tidiness problem. It was found while reading that log to
 * diagnose a real account-switch bug (#213), where the file contained fixture
 * accounts from `account-auth.test.ts` — labels "Work" and "Doomed",
 * will@acme.test, "teardown glitched" — interleaved with, and in places on top
 * of, the app's own entries. Tests corrupting the evidence you debug with is
 * worse than tests being noisy.
 *
 * Disabling the transport rather than redirecting it: nothing asserts on log
 * FILES, so a temp path would only move the litter somewhere else. Console
 * output is untouched, so a test that needs to see a log line still can.
 */
log.transports.file.level = false;

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
