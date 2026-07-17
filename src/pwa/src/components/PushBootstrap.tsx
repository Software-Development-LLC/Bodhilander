/**
 * <PushBootstrap /> — Web Push registration trigger (BDHLNDR-49).
 *
 * Mounted as an always-on sibling of <Routes> in App.tsx. Renders nothing.
 *
 * Gating (intentionally conservative — never prompt for permission when the
 * user doesn't expect it):
 *   - PushManager + Notification + ServiceWorker must exist in this browser
 *   - Auth row must be present (so we have a token to POST with)
 *   - The PWA must be running in standalone display mode (iOS won't grant
 *     push to a regular Safari tab anyway, and on Android the install
 *     prompt is the natural lead-in)
 *   - Permission must not be `denied` already
 *   - We must not have already kicked off a subscribe attempt this session
 *
 * If `Notification.permission === 'default'` we still defer to a real
 * user gesture in the future (the chat-view's first-message hook —
 * BDHLNDR-56 territory). For v1 we only proactively re-bind an existing
 * `granted` permission to a fresh subscription, which is permission-free
 * and silent for the user. This is the "simplest correct thing"
 * compromise the ticket calls out — see the README of this file's
 * companion lib (`lib/push.ts`) for the full subscribe flow.
 */

import { useEffect, useRef } from 'react';

import { getAuth } from '../lib/auth';
import { isStandalone } from '../lib/install-prompt';
import { isPushSupported, subscribeToPush } from '../lib/push';

export function PushBootstrap() {
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;

    if (!isPushSupported()) return;
    if (!isStandalone()) return;
    if (Notification.permission !== 'granted') {
      // We don't prompt here. The Settings UI / chat-view first-message
      // hook owns the prompt-on-gesture path. If permission is already
      // granted (user opted in previously) we silently re-bind.
      return;
    }

    attempted.current = true;

    (async () => {
      const auth = await getAuth();
      if (!auth) return;

      const result = await subscribeToPush();
      if (!result.ok) {
        // Soft-fail: the dispatcher on the desktop just won't have a row
        // for this device until the next time the user re-enables push.
        console.warn('[PushBootstrap] Subscribe failed:', result.reason);
      }
    })();
  }, []);

  return null;
}
