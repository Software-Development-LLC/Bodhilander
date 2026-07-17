/**
 * Browser / device sniffing for the PWA.
 *
 * Two outputs:
 *   - `detectPlatform()` returns one of 'ios' | 'android' | 'web', which is
 *     the value the desktop's `validatePairingConfirm` middleware expects
 *     for the `platform` field. This is also the value the QR-pair flow
 *     (BDHLNDR-14) will send, so keep them in sync.
 *   - `suggestDeviceName()` produces a friendly default for the device-name
 *     input on /pair, e.g. "iPhone (Safari)" or "Pixel (Chrome)".
 *
 * Best-effort UA sniffing — we don't need this to be perfect, the user can
 * always edit the name. We avoid `navigator.userAgentData` because it's
 * gated behind a permissions prompt in some browsers and not yet
 * universally supported on iOS.
 */

export type Platform = 'ios' | 'android' | 'web';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'web';
  const ua = navigator.userAgent;
  // iPad on iPadOS 13+ reports as Mac; check for touch points to catch it.
  const isIpadOS =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || isIpadOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'web';
}

/**
 * Build a default device-name string like `Pixel (Chrome)` or
 * `iPhone (Safari)`. Falls back to platform + generic browser when the UA
 * doesn't yield anything more specific.
 */
export function suggestDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Web';
  const ua = navigator.userAgent;
  const device = detectDeviceModel(ua);
  const browser = detectBrowser(ua);
  return `${device} (${browser})`;
}

function detectDeviceModel(ua: string): string {
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPod/.test(ua)) return 'iPod';
  if (/Android/.test(ua)) {
    // Try to pull a model name out of the UA: `; <Model> Build/...`
    const m = /Android[^;]*;\s*([^;)]+?)(?:\s+Build|;|\))/.exec(ua);
    if (m && m[1]) return m[1].trim();
    return 'Android';
  }
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Device';
}

function detectBrowser(ua: string): string {
  // Order matters: Edge / Opera / Brave masquerade as Chrome.
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS\//.test(ua)) return 'Chrome'; // Chrome on iOS
  if (/FxiOS\//.test(ua)) return 'Firefox'; // Firefox on iOS
  // Safari check must come after CriOS/FxiOS because iOS browsers also
  // include "Safari" in the UA.
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}
