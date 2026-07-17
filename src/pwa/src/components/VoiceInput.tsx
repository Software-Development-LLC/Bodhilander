/**
 * Hold-to-speak voice input (BDHLNDR-15).
 *
 * Wraps the browser's Web Speech API (`SpeechRecognition` /
 * `webkitSpeechRecognition`) behind a single mic button that the user
 * presses and holds to dictate. The transcript is delivered back to the
 * caller as plain text — the caller decides what to do with it (typically
 * append to a textarea draft). We deliberately do NOT auto-send: this is a
 * speech-to-TEXT affordance, not a voice command.
 *
 * Capability detection
 * --------------------
 * `isVoiceInputSupported()` is exported so callers can omit the component
 * entirely on browsers without Web Speech. We don't render a "feature
 * unavailable" tooltip — when it's missing, the mic just isn't there.
 *
 * Touch UX
 * --------
 * Pointer events (`onPointerDown` / `onPointerUp` / `onPointerCancel` /
 * `onPointerLeave`) cover mouse + touch + pen uniformly on all modern
 * browsers including iOS Safari 13+. We also call `setPointerCapture` so
 * a finger that drifts off the button while the user is mid-dictation
 * doesn't accidentally stop recording — only an actual lift releases.
 *
 * Permission
 * ----------
 * `navigator.permissions.query({ name: 'microphone' })` is unreliable
 * across browsers (Firefox didn't ship it for years, Safari still varies).
 * We just attempt `recognition.start()` and translate the `not-allowed`
 * error from the `onerror` handler into a human-readable message via
 * `onError`.
 *
 * Lifecycle
 * ---------
 * A single `SpeechRecognition` instance lives in a ref for the component
 * lifetime — re-creating it per press would lose the lang preference and
 * the browser sometimes throws if you `start()` two instances back-to-
 * back. On unmount we `abort()` to release the mic immediately.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Web Speech API typing
// ---------------------------------------------------------------------------
// The W3C Web Speech spec isn't in the default lib.dom typings (it's still a
// draft). We declare just enough of the surface we use rather than pulling in
// a third-party @types package — keeps the dep tree clean and the types
// scoped to this file.

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognitionInstance, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognitionInstance, ev: Event) => void) | null;
  onstart: ((this: SpeechRecognitionInstance, ev: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
  return typeof SR === 'function' ? SR : null;
}

/** Exported for callers to gate whether to mount `<VoiceInput>` at all. */
export function isVoiceInputSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface VoiceInputProps {
  /** True when the parent is read-only or currently sending — disables the mic. */
  disabled: boolean;
  /**
   * Called with the FINAL transcript when the user releases the button.
   * Caller decides whether to overwrite or append (typically:
   * `setDraft(d => d + text)`). Empty strings are not delivered.
   */
  onTranscript: (text: string) => void;
  /** Caller surfaces this in its existing error banner. */
  onError: (message: string) => void;
}

export function VoiceInput({ disabled, onTranscript, onError }: VoiceInputProps) {
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  /** Accumulated FINAL chunks since the current press started. */
  const finalTranscriptRef = useRef('');
  /** Whether the user is currently pressing the mic. */
  const [recording, setRecording] = useState(false);
  /** Live preview shown above the compose box while holding. */
  const [interim, setInterim] = useState('');

  // Lazy-create the recognition instance on first interaction. Doing this in
  // useEffect on mount would create a Recognition for users who never touch
  // the mic; lazy keeps cold-load cheap.
  const getRecognition = useCallback((): SpeechRecognitionInstance | null => {
    if (recognitionRef.current) return recognitionRef.current;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return null;
    const r = new Ctor();
    r.continuous = false; // hold-to-speak = single phrase
    r.interimResults = true; // for the live preview
    r.maxAlternatives = 1;
    r.lang = navigator.language || 'en-US';
    recognitionRef.current = r;
    return r;
  }, []);

  // Release the mic on unmount — abort() is synchronous and doesn't fire
  // onend, which is what we want (component is gone, no state to update).
  useEffect(() => {
    return () => {
      const r = recognitionRef.current;
      if (r) {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.onstart = null;
        try {
          r.abort();
        } catch {
          // Already stopped — ignore.
        }
      }
    };
  }, []);

  const stopRecording = useCallback(() => {
    const r = recognitionRef.current;
    if (!r) return;
    try {
      r.stop();
    } catch {
      // Not currently started — ignore.
    }
  }, []);

  const startRecording = useCallback(() => {
    if (disabled || recording) return;
    const r = getRecognition();
    if (!r) return;

    finalTranscriptRef.current = '';
    setInterim('');

    r.onresult = (event: SpeechRecognitionEvent) => {
      let interimChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alt = result[0];
        if (!alt) continue;
        if (result.isFinal) {
          finalTranscriptRef.current += alt.transcript;
        } else {
          interimChunk += alt.transcript;
        }
      }
      setInterim(interimChunk);
    };

    r.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Browsers report different `error` codes; the ones worth translating:
      //   not-allowed / service-not-allowed → user denied or OS blocked mic
      //   no-speech → user held the button but didn't say anything (quiet)
      //   audio-capture → no microphone available
      //   aborted → we called abort() ourselves on unmount; not an error
      //   network → speech service unreachable (Chrome routes via Google)
      const code = event.error;
      if (code === 'aborted') return;
      if (code === 'no-speech') {
        // Silent close — pressing and not speaking shouldn't yell at the user.
        return;
      }
      let msg: string;
      switch (code) {
        case 'not-allowed':
        case 'service-not-allowed':
          msg = 'Microphone access denied — enable it in browser settings.';
          break;
        case 'audio-capture':
          msg = 'No microphone detected.';
          break;
        case 'network':
          msg = 'Voice service unreachable — check your connection.';
          break;
        default:
          msg = `Voice input error: ${code}`;
      }
      onError(msg);
    };

    r.onend = () => {
      // `end` fires both on natural stop (continuous=false → after a final
      // chunk) and after stop()/abort(). Deliver whatever we accumulated.
      setRecording(false);
      setInterim('');
      const text = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = '';
      if (text) {
        // Prepend a space if the caller's existing draft already has content
        // — handled by the caller; we deliver the raw transcript.
        onTranscript(text);
      }
    };

    try {
      r.start();
      setRecording(true);
    } catch (err) {
      // start() throws InvalidStateError if a previous session is still
      // tearing down — clean up and surface a generic message.
      setRecording(false);
      onError(err instanceof Error ? err.message : 'Failed to start voice input.');
    }
  }, [disabled, recording, getRecognition, onError, onTranscript]);

  // Pointer event wiring. We capture the pointer so a drift off the button
  // doesn't release — only an actual `pointerup` does. `pointercancel` (e.g.
  // OS interruption, incoming call) and `pointerleave` (in case capture
  // didn't take, defensive) both stop cleanly.
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some browsers throw if the pointer is already captured elsewhere.
    }
    startRecording();
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!recording) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    stopRecording();
  };
  const onPointerCancel = onPointerUp;

  return (
    <div className="relative flex shrink-0 items-end">
      {/* Live interim transcript floats above the mic while holding. The
          parent compose box is `relative` via its sticky positioning, so this
          absolute element pins to the mic column. Using max-w + truncate
          prevents long phrases from pushing past the screen edge. */}
      {recording && (
        <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap">
          <div className="flex items-center gap-1.5 rounded-full bg-neutral-800/95 px-3 py-1 text-xs italic text-neutral-300 shadow-lg shadow-black/40">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
            <span className="max-w-[60vw] truncate">
              {interim || 'Listening…'}
            </span>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label={recording ? 'Stop recording' : 'Hold to speak'}
        aria-pressed={recording}
        disabled={disabled}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerUp}
        // Prevent the browser's default text-selection / context-menu on
        // long-press, which would otherwise interrupt the hold gesture.
        onContextMenu={(e) => e.preventDefault()}
        className={`flex h-10 w-10 shrink-0 touch-none items-center justify-center rounded-full transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40 ${
          recording
            ? 'bg-red-600 text-white shadow-inner'
            : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700 active:bg-neutral-600'
        }`}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
          {/* Classic mic glyph — capsule + stand. */}
          <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z" />
          <path d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.08A7 7 0 0 0 19 11z" />
        </svg>
      </button>
    </div>
  );
}
