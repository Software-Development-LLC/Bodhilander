/**
 * <InstallPrompt /> — first-pair install walkthrough (BDHLNDR-61).
 *
 * Mounted as an always-on sibling of <Routes> in App.tsx. Renders nothing
 * until the user has successfully paired (BDHLNDR-54 wrote `paired_at`),
 * then shows a platform-specific modal:
 *
 *   - iOS Safari: full-screen "Add to Home Screen" walkthrough with
 *     inline SVG step icons. Safari doesn't expose a programmatic install
 *     API so we have to teach the user the manual gesture; this is the
 *     only path to working Web Push on iOS (BDHLNDR-49).
 *
 *   - Android Chrome: a one-screen primer that, on tap, fires the
 *     captured `beforeinstallprompt` event. We *don't* fire it as soon as
 *     Chrome offers it — Chrome's mini-infobar is way out of context and
 *     gets dismissed reflexively. Showing it right after pair, framed
 *     around notifications, gets far better acceptance.
 *
 * On install (detected via `appinstalled` event OR display-mode change),
 * we show a one-time toast confirming push will work, then mark
 * `installed_at` so the prompt never re-appears.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getAuth } from '../lib/auth';
import { detectPlatform, type Platform } from '../lib/platform';
import {
  isStandalone,
  markDismissed,
  markInstalled,
  markShown,
  shouldShowPrompt,
} from '../lib/install-prompt';

/**
 * The `beforeinstallprompt` event isn't in the standard lib.dom types yet
 * (Chrome-only API). Minimal local shim covering what we actually call.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

type Mode = 'hidden' | 'ios' | 'android' | 'installed-toast';

export function InstallPrompt() {
  const [mode, setMode] = useState<Mode>('hidden');
  const [platform] = useState<Platform>(() => detectPlatform());
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  // Re-evaluate the gating condition. Called on mount, when auth changes
  // (best-effort: focus/visibility), and after the user pairs.
  const reevaluate = useCallback(async () => {
    const auth = await getAuth();
    const show = await shouldShowPrompt(auth?.paired_at ?? null);
    if (!show) {
      setMode((m) => (m === 'installed-toast' ? m : 'hidden'));
      return;
    }
    if (platform === 'ios') {
      setMode('ios');
      void markShown();
    } else if (platform === 'android') {
      // Don't surface the Android modal until we've actually captured a
      // `beforeinstallprompt` event — otherwise tapping "Install" does
      // nothing. If the event hasn't fired yet, wait for it (handled by
      // the listener below, which calls reevaluate() again).
      if (deferredPromptRef.current) {
        setMode('android');
        void markShown();
      }
    }
  }, [platform]);

  // Capture `beforeinstallprompt` so we can fire it on user gesture.
  // Chrome dispatches this once, eagerly; we must call preventDefault to
  // stop the mini-infobar and stash the event for later.
  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      // If gating already wanted us to show but we were waiting for the
      // event, this is our cue.
      void reevaluate();
    }
    function onAppInstalled() {
      deferredPromptRef.current = null;
      void markInstalled();
      setMode('installed-toast');
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [reevaluate]);

  // Watch the standalone media query — on iOS there's no `appinstalled`
  // event, the only signal we get is the next launch happening in
  // standalone mode. We still want to fire the toast that first time.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(display-mode: standalone)');
    function onChange(e: MediaQueryListEvent) {
      if (e.matches) {
        void markInstalled();
        setMode('installed-toast');
      }
    }
    mq.addEventListener?.('change', onChange);
    return () => {
      mq.removeEventListener?.('change', onChange);
    };
  }, []);

  // Initial gating check + re-check when the user returns to the tab.
  // The latter catches the common case of pairing in another tab / via
  // the desktop and then switching back here.
  useEffect(() => {
    void reevaluate();
    function onVisibility() {
      if (document.visibilityState === 'visible') void reevaluate();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [reevaluate]);

  // If we became standalone between reads (e.g. user installed via
  // browser menu while a modal was up), hide the modal proactively.
  useEffect(() => {
    if (mode === 'ios' || mode === 'android') {
      if (isStandalone()) setMode('installed-toast');
    }
  }, [mode]);

  const handleDismiss = useCallback(async () => {
    await markDismissed();
    setMode('hidden');
  }, []);

  const handleIosGotIt = useCallback(() => {
    // "Got it" acknowledges the walkthrough without snoozing — we already
    // called markShown() when we opened the modal, so just close.
    setMode('hidden');
  }, []);

  const handleAndroidInstall = useCallback(async () => {
    const ev = deferredPromptRef.current;
    if (!ev) {
      // Shouldn't happen — we only surface the Android modal once the
      // event is captured. Belt-and-braces: dismiss so the user isn't
      // stuck looking at a no-op button.
      await markDismissed();
      setMode('hidden');
      return;
    }
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      deferredPromptRef.current = null;
      if (choice.outcome === 'accepted') {
        // `appinstalled` will fire and handle the toast + markInstalled.
        setMode('hidden');
      } else {
        await markDismissed();
        setMode('hidden');
      }
    } catch (err) {
      console.error('[InstallPrompt] beforeinstallprompt.prompt() failed:', err);
      setMode('hidden');
    }
  }, []);

  // Auto-hide the success toast after a few seconds. Cheap and non-modal.
  useEffect(() => {
    if (mode !== 'installed-toast') return;
    const t = window.setTimeout(() => setMode('hidden'), 5000);
    return () => window.clearTimeout(t);
  }, [mode]);

  if (mode === 'hidden') return null;

  if (mode === 'installed-toast') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4"
      >
        <div className="pointer-events-auto max-w-sm rounded-lg border border-emerald-700/60 bg-emerald-900/90 px-4 py-3 text-sm text-emerald-100 shadow-lg backdrop-blur">
          Bodhilander installed — push notifications will work now.
        </div>
      </div>
    );
  }

  if (mode === 'ios') {
    return <IosWalkthrough onDismiss={handleDismiss} onGotIt={handleIosGotIt} />;
  }

  // android
  return <AndroidPrimer onDismiss={handleDismiss} onInstall={handleAndroidInstall} />;
}

// --------------------------------------------------------------------------
// iOS walkthrough
// --------------------------------------------------------------------------

interface IosProps {
  onDismiss: () => void;
  onGotIt: () => void;
}

function IosWalkthrough({ onDismiss, onGotIt }: IosProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-prompt-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-6 shadow-2xl ring-1 ring-white/10">
        <h2 id="install-prompt-title" className="text-xl font-semibold text-neutral-50">
          Install Bodhilander on your home screen
        </h2>
        <p className="mt-1 text-sm text-neutral-400">
          Required for push notifications when Claude needs your input.
        </p>

        <ol className="mt-5 space-y-4">
          <Step
            number={1}
            icon={<ShareIcon />}
            text={
              <>
                Tap the <span className="font-medium text-neutral-100">Share</span> button at
                the bottom of Safari.
              </>
            }
          />
          <Step
            number={2}
            icon={<AddIcon />}
            text={
              <>
                Scroll and tap{' '}
                <span className="font-medium text-neutral-100">Add to Home Screen</span>.
              </>
            }
          />
          <Step
            number={3}
            icon={<TapIcon />}
            text={
              <>
                Tap <span className="font-medium text-neutral-100">Add</span> in the top-right
                corner.
              </>
            }
          />
        </ol>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onGotIt}
            className="rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Got it
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-neutral-700 bg-transparent px-4 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({
  number,
  icon,
  text,
}: {
  number: number;
  icon: React.ReactNode;
  text: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs font-semibold text-neutral-300"
      >
        {number}
      </span>
      <div className="flex-1 text-sm text-neutral-200">
        <p>{text}</p>
      </div>
      <span aria-hidden className="mt-0.5 text-neutral-400">
        {icon}
      </span>
    </li>
  );
}

// --------------------------------------------------------------------------
// Inline SVG icons (matching Apple's iOS share / add affordances closely
// enough to be recognizable, without shipping their proprietary glyphs).
// All 24x24, `currentColor`-based so they inherit Tailwind text color.
// --------------------------------------------------------------------------

function ShareIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Share"
    >
      {/* Up arrow */}
      <path d="M12 3v13" />
      <path d="M7 8l5-5 5 5" />
      {/* Box bottom */}
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

function AddIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Add"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

function TapIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Tap"
    >
      {/* Finger tap glyph: small circle inside ripple */}
      <circle cx="12" cy="12" r="3" />
      <path d="M12 5V3" />
      <path d="M12 21v-2" />
      <path d="M5 12H3" />
      <path d="M21 12h-2" />
      <path d="M6.34 6.34 4.93 4.93" />
      <path d="M19.07 19.07l-1.41-1.41" />
    </svg>
  );
}

// --------------------------------------------------------------------------
// Android primer
// --------------------------------------------------------------------------

interface AndroidProps {
  onDismiss: () => void;
  onInstall: () => void;
}

function AndroidPrimer({ onDismiss, onInstall }: AndroidProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-prompt-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-6 shadow-2xl ring-1 ring-white/10">
        <h2 id="install-prompt-title" className="text-xl font-semibold text-neutral-50">
          Install Bodhilander
        </h2>
        <p className="mt-2 text-sm text-neutral-300">
          Add Bodhilander to your home screen for faster access and notifications.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onInstall}
            className="rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Install
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-neutral-700 bg-transparent px-4 py-2.5 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-800"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
