/**
 * /sessions/:sessionId — mobile chat view (BDHLNDR-56).
 *
 * Architecture
 * ------------
 * Two data sources feed one in-memory chat log:
 *
 *   1. REST snapshot (BDHLNDR-58): GET /sessions/:id/chat-events?limit=500
 *      Fired on mount via React Query — gives us the persisted history so
 *      a fresh page-load (or PWA reinstall) doesn't show an empty chat.
 *
 *   2. WS live (BDHLNDR-55): `chat:event` frames after subscribing the
 *      session. Validated through `narrowChatEvent` (the WS client types
 *      the payload as `unknown` on purpose).
 *
 * Both append into the same `events` state array. We keep this as
 * component state rather than letting React Query own it because:
 *   - Live frames arrive between RQ refetches and we want them rendered
 *     instantly without an extra round-trip.
 *   - Pagination ("Load older") would require manual cache manipulation
 *     either way; a plain array is easier to reason about than RQ's
 *     infinite-query glue for this v1 scope.
 *
 * Snapshot loads first, then `events` is seeded from the snapshot. WS
 * frames that arrive BEFORE the snapshot resolves are buffered into a
 * ref and flushed once the snapshot lands — otherwise the very first WS
 * frame after mount could be lost or appear above older snapshot rows.
 *
 * Compose / send flow
 * -------------------
 * On tap-Send we POST /terminal/:id/input with `text + '\n'`. We do NOT
 * locally render an optimistic `response` bubble — the server parses its
 * own PTY output and broadcasts a `response` chat:event via WS within
 * milliseconds. Optimistic rendering would require dedup logic (match on
 * trimmed text? content hash?) that the server's echo will eventually
 * displace anyway, and the perceived latency is fine. The exception is
 * one-tap response buttons (yes/no/option), where we want immediate
 * visual feedback — those disable themselves on press and we rely on
 * the WS echo to render the bubble. See `handleTapResponse()`.
 *
 * 403 responses surface inline as "Read-only — can't send input to this
 * session" so view-only paired devices don't get a confusing "request
 * failed" error.
 *
 * Auto-scroll
 * -----------
 * We auto-scroll to bottom on each new event IFF the user is currently
 * within `AUTO_SCROLL_THRESHOLD_PX` of the bottom. If they've scrolled up
 * to read history, new events accumulate silently and a floating "↓ new
 * messages" pill appears; tapping it scrolls to bottom and resumes the
 * auto-scroll behavior. The detection uses scroll position rather than
 * IntersectionObserver because the chat container can resize (keyboard,
 * orientation) and IO entries lag those resizes by a frame.
 *
 * Markdown
 * --------
 * Assistant text is rendered as plain text with `\n` → `<br>` line
 * breaks. Real markdown rendering (code blocks, lists, bold/italic) is
 * deferred to a follow-up — the `marked` dependency adds ~30KB to the
 * PWA bundle and the v1 chat view ships fine without it. When it lands
 * we'll swap the `<AssistantBubble>` body for a sanitized HTML render.
 *
 * Older-history pagination
 * ------------------------
 * The snapshot endpoint supports `?since=<ms>` and returns `hasMore`,
 * but the v1 PWA does not yet expose a "Load older" button — the
 * server's 500-row default snapshot covers the typical session length.
 * Marked as a TODO below; tracked in BDHLNDR-56 follow-up notes.
 *
 * Cleanup
 * -------
 * On unmount: unsubscribe the `chat:event` handler and call the
 * `subscribeSession()` unsubscribe fn (ref-counted, so other open chat
 * views — unlikely on mobile — keep working). We do NOT disconnect the
 * WS itself; the singleton stays warm across navigation.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import {
  ApiError,
  fetchChatEvents,
  sendTerminalInput,
  startSession,
  stopSession,
} from '../lib/api';
import { getAuth } from '../lib/auth';
import {
  getCachedChatEvents,
  setCachedChatEvents,
} from '../lib/cache';
import { maybePromptAndSubscribe } from '../lib/push';
import {
  narrowChatEvent,
  type ChatEvent,
  type PersistedChatEvent,
  type PromptOption,
} from '../lib/types';
import { wsClient, type ChatEventMessage, type WsStatus } from '../lib/ws';
import { ConnectionDot } from '../components/ConnectionDot';
import { OverflowMenu } from '../components/OverflowMenu';
import { RawTerminal } from '../components/RawTerminal';
import { RelativeTime } from '../components/RelativeTime';
import { VoiceInput, isVoiceInputSupported } from '../components/VoiceInput';

// ---------------------------------------------------------------------------
// View mode (BDHLNDR-57)
// ---------------------------------------------------------------------------

/**
 * SessionDetail can render the parsed chat view (default, BDHLNDR-56) OR
 * a raw xterm.js view of `terminal:output` (BDHLNDR-57). The choice is
 * persisted per-session in localStorage so each session remembers the
 * user's preference across reloads.
 */
type ViewMode = 'chat' | 'raw';

const VIEW_MODE_STORAGE_PREFIX = 'bodhilander.view-mode.';

function viewModeStorageKey(sessionId: string): string {
  return `${VIEW_MODE_STORAGE_PREFIX}${sessionId}`;
}

function loadViewMode(sessionId: string): ViewMode {
  try {
    const v = localStorage.getItem(viewModeStorageKey(sessionId));
    return v === 'raw' ? 'raw' : 'chat';
  } catch {
    return 'chat';
  }
}

function saveViewMode(sessionId: string, mode: ViewMode): void {
  try {
    localStorage.setItem(viewModeStorageKey(sessionId), mode);
  } catch {
    // Quota or disabled storage — non-fatal; just don't remember.
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Snapshot page size; matches the server-side hard cap. */
const SNAPSHOT_LIMIT = 500;

/**
 * Distance from the bottom of the scroll container (in CSS pixels) below
 * which we still consider the user to be "looking at the latest" — new
 * events auto-scroll silently. Above this, we surface the "↓ new messages"
 * pill instead. 120px ≈ one chat bubble plus padding on phone screens.
 */
const AUTO_SCROLL_THRESHOLD_PX = 120;

/** Compose textarea autosize cap — beyond this we let it scroll internally. */
const COMPOSE_MAX_ROWS = 4;

// ---------------------------------------------------------------------------
// Internal display model
// ---------------------------------------------------------------------------

/**
 * What we actually render in the log. Combines persisted (REST snapshot)
 * and live (WS) events under one shape so the renderer doesn't care which
 * source they came from. WS-sourced events get a synthesized id so React
 * keys stay stable across re-renders.
 */
interface DisplayEvent {
  id: string;
  timestamp: number;
  event: ChatEvent;
  /** Which prompt option (if any) the user already tapped — disables the buttons. */
  consumedKey?: string;
}

let synthIdCounter = 0;
function makeSynthId(): string {
  synthIdCounter += 1;
  return `ws-${Date.now()}-${synthIdCounter}`;
}

function persistedToDisplay(p: PersistedChatEvent): DisplayEvent {
  // The REST snapshot returns rows where { type, payload } already match the
  // ChatEvent union — we just rewrap into the discriminated shape so the
  // renderer can switch on `event.type` cleanly.
  return {
    id: p.id,
    timestamp: p.timestamp,
    event: { type: p.type, payload: p.payload } as ChatEvent,
  };
}

/**
 * Inverse of `persistedToDisplay` for caching (BDHLNDR-59). We persist the
 * in-memory display log into IndexedDB so the next cold open can render
 * immediately. WS-sourced events synthesized their own `id` (no server id
 * over the wire) — we keep that synth id in the cache; on the next cold
 * start the snapshot refetch fires with `?since=last_ts` and the server's
 * `since` is strict (timestamp >), so the same event isn't re-delivered.
 */
function displayToPersisted(sessionId: string, d: DisplayEvent): PersistedChatEvent {
  return {
    id: d.id,
    sessionId,
    type: d.event.type,
    payload: d.event.payload,
    timestamp: d.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionDetail() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  // Guard: react-router shouldn't let this happen, but if `sessionId` is
  // absent there's no point mounting the rest of the view.
  if (!sessionId) {
    return (
      <main className="mx-auto max-w-md p-4">
        <p className="text-sm text-red-300">Missing session id in URL.</p>
      </main>
    );
  }

  return <SessionDetailInner sessionId={sessionId} navigate={navigate} />;
}

function SessionDetailInner({
  sessionId,
  navigate,
}: {
  sessionId: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // The combined in-memory log. Seeded from cache first, then merged with
  // the REST snapshot delta, then appended to by WS frames. See the chunks
  // below for the three sources.
  const [events, setEvents] = useState<DisplayEvent[]>([]);

  // ---- Cache hydration (BDHLNDR-59) ------------------------------------
  // Read the offline cache BEFORE firing the snapshot query so:
  //   1. We can seed `events` immediately and unblock first paint (PWA may
  //      be offline at this exact moment — last-known events are better
  //      than a spinner).
  //   2. The snapshot fetch can use `since=cached.last_ts` for an
  //      incremental delta instead of re-downloading the full 500-event
  //      window. Cheaper, and matches the BDHLNDR-58 endpoint contract.
  //
  // `cacheReady` gates the snapshot query — we can't pass `since` until
  // we've read the cache, and we don't want the snapshot to fire with no
  // `since` and then immediately again with one.
  const [cacheReady, setCacheReady] = useState(false);
  const [cacheLastTs, setCacheLastTs] = useState<number>(0);
  const [cacheHydratedAt, setCacheHydratedAt] = useState<number | null>(null);

  useEffect(() => {
    // Reset hydration state when navigating between sessions — see the
    // session-id reset effect below; this one runs alongside it.
    let cancelled = false;
    void (async () => {
      const cached = await getCachedChatEvents(sessionId);
      if (cancelled) return;
      if (cached && cached.events.length > 0) {
        setEvents(cached.events.map(persistedToDisplay));
        setCacheLastTs(cached.last_ts);
        setCacheHydratedAt(cached.fetched_at);
      }
      setCacheReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // ---- Snapshot ---------------------------------------------------------
  // Gated on `cacheReady` so the request includes `?since=cached.last_ts`
  // for an incremental refresh when we have prior data. The server returns
  // events strictly newer than `since` (BDHLNDR-58 contract), so dedup
  // against the cached set is unnecessary — but we still id-dedup below as
  // a defensive belt-and-suspenders.
  const snapshot = useQuery({
    queryKey: ['chat-events', sessionId, cacheLastTs],
    queryFn: () =>
      fetchChatEvents(sessionId, {
        limit: SNAPSHOT_LIMIT,
        ...(cacheLastTs > 0 ? { since: cacheLastTs } : {}),
      }),
    staleTime: Infinity, // live updates come via WS — don't refetch on focus
    enabled: cacheReady,
  });

  // ---- Combined log -----------------------------------------------------
  /** WS frames that arrived before the snapshot resolved — flushed on success. */
  const pendingWsRef = useRef<DisplayEvent[]>([]);
  const snapshotLoadedRef = useRef(false);

  // Seed from snapshot when it lands; flush any buffered WS frames.
  // When `cacheLastTs > 0` the snapshot is an incremental delta — we MERGE
  // it onto the cached events that `events` was hydrated with. Otherwise
  // (cold first-ever open) it's a full snapshot and we replace.
  useEffect(() => {
    if (!snapshot.data || snapshotLoadedRef.current) return;
    snapshotLoadedRef.current = true;
    const seeded = snapshot.data.events.map(persistedToDisplay);
    setEvents((prev) => {
      const base = cacheLastTs > 0 ? prev : [];
      const ids = new Set(base.map((e) => e.id));
      const merged: DisplayEvent[] = [...base];
      for (const ev of seeded) {
        if (ids.has(ev.id)) continue;
        ids.add(ev.id);
        merged.push(ev);
      }
      // Flush any buffered WS frames that landed during the snapshot fetch.
      for (const ev of pendingWsRef.current) {
        if (ids.has(ev.id)) continue;
        ids.add(ev.id);
        merged.push(ev);
      }
      pendingWsRef.current = [];
      return merged;
    });
  }, [snapshot.data, cacheLastTs]);

  // ---- WS subscription --------------------------------------------------
  useEffect(() => {
    const handleChatEvent = (msg: ChatEventMessage) => {
      if (msg.sessionId !== sessionId) return; // shared bus — filter to ours
      const narrowed = narrowChatEvent(msg.payload);
      if (!narrowed) {
        console.warn('[SessionDetail] dropped malformed chat:event', msg);
        return;
      }
      const display: DisplayEvent = {
        id: makeSynthId(),
        timestamp: msg.timestamp,
        event: narrowed,
      };
      if (!snapshotLoadedRef.current) {
        pendingWsRef.current.push(display);
        return;
      }
      setEvents((prev) => [...prev, display]);
    };

    const unsubHandler = wsClient.on('chat:event', handleChatEvent);
    const unsubSession = wsClient.subscribeSession(sessionId);
    return () => {
      unsubHandler();
      unsubSession();
    };
  }, [sessionId]);

  // Reset state when navigating between sessions (sessionId in deps).
  // Cache-hydration state resets too so the new session can re-hydrate from
  // its own cache row.
  useEffect(() => {
    snapshotLoadedRef.current = false;
    pendingWsRef.current = [];
    setEvents([]);
    setCacheReady(false);
    setCacheLastTs(0);
    setCacheHydratedAt(null);
  }, [sessionId]);

  // ---- Persist to cache (BDHLNDR-59) -----------------------------------
  // Write the in-memory event log back to IndexedDB whenever it changes
  // (snapshot resolves, WS frame appends, one-tap response edits). The
  // cache module dedups + caps internally, so we can pass the full array
  // unconditionally. Skipping the empty-array case avoids overwriting a
  // valid cache row on the brief moment between the sessionId-reset effect
  // clearing state and the cache-hydration effect re-populating it.
  useEffect(() => {
    if (events.length === 0) return;
    void setCachedChatEvents(
      sessionId,
      events.map((d) => displayToPersisted(sessionId, d)),
    );
  }, [events, sessionId]);

  // ---- WS status (for the header dot) ----------------------------------
  const [wsStatus, setWsStatus] = useState<WsStatus>(wsClient.status);
  useEffect(() => wsClient.onStatusChange(setWsStatus), []);

  // ---- Auto-scroll + "new messages" pill -------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const prevEventCountRef = useRef(0);

  const isNearBottom = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Pin-to-bottom detection — re-evaluated on every user scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = isNearBottom();
      setPinnedToBottom(near);
      if (near) setUnreadCount(0);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isNearBottom]);

  // Auto-scroll OR bump unread count on new events. useLayoutEffect so the
  // measurement happens before paint (avoids a flash where the new bubble is
  // briefly visible above the viewport before we jump down).
  useLayoutEffect(() => {
    const grew = events.length > prevEventCountRef.current;
    const added = events.length - prevEventCountRef.current;
    prevEventCountRef.current = events.length;
    if (!grew) return;
    if (pinnedToBottom) {
      scrollToBottom('smooth');
    } else {
      setUnreadCount((c) => c + added);
    }
  }, [events, pinnedToBottom, scrollToBottom]);

  // On initial mount: jump to bottom without animation once the snapshot
  // paints — otherwise we'd start at the top and "smooth-scroll" through
  // hundreds of bubbles, which looks awful on a phone.
  useLayoutEffect(() => {
    if (snapshot.isSuccess && events.length > 0 && prevEventCountRef.current === events.length) {
      scrollToBottom('auto');
    }
    // We only want this when the snapshot first loads, not on every event
    // append — the auto-scroll effect above handles those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.isSuccess]);

  // ---- Compose ---------------------------------------------------------
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);

  const send = useCallback(
    async (text: string) => {
      if (!text || sending) return;
      setSending(true);
      setSendError(null);
      // BDHLNDR-68: any send (free-text or one-tap response) is a user
      // gesture — fire the push subscribe in the background. Idempotent and
      // self-gating in push.ts, so safe to call on every send. Browser
      // remembers the permission decision, so the user is prompted at most
      // once per device (and never on iOS until installed via Add to Home
      // Screen, where push is supported).
      void maybePromptAndSubscribe();
      try {
        await sendTerminalInput(sessionId, text);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setReadOnly(true);
          setSendError("Read-only — you can't send input to this session.");
        } else {
          setSendError(err instanceof Error ? err.message : String(err));
        }
        return false;
      } finally {
        setSending(false);
      }
    },
    [sessionId, sending],
  );

  // Terminal "Enter" is carriage return (\r), not LF. xterm.js's onData
  // sends \r when the user hits Enter, and Claude Code's TUI (like most
  // terminal apps) only treats \r as submit — LF alone shows the text but
  // never triggers the prompt. BDHLNDR-70.
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await send(text + '\r');
    if (ok) setDraft('');
  }, [draft, send]);

  // ---- One-tap prompt response -----------------------------------------
  // We need to disable the buttons on a prompt after the user taps one of
  // them so they can't be re-pressed. We track this by event id on the
  // DisplayEvent (`consumedKey`). The WS echo will append a `response`
  // bubble shortly after, which is what the user sees as their answer.
  const handleTapResponse = useCallback(
    async (eventId: string, optionKey: string) => {
      // Optimistically mark the prompt as consumed BEFORE the network round-
      // trip so the user sees instant feedback (buttons fade out).
      setEvents((prev) =>
        prev.map((e) => (e.id === eventId ? { ...e, consumedKey: optionKey } : e)),
      );
      // \r (CR), not \n — terminal Enter convention. See handleSend above.
      const ok = await send(optionKey + '\r');
      if (!ok) {
        // Roll back the consumed flag so the user can retry — the inline
        // error from `send()` tells them why it failed.
        setEvents((prev) =>
          prev.map((e) => (e.id === eventId ? { ...e, consumedKey: undefined } : e)),
        );
      }
    },
    [send],
  );

  // ---- Header bits -----------------------------------------------------
  const [menuOpen, setMenuOpen] = useState(false);

  // ---- Session control (BDHLNDR-62) ------------------------------------
  // Restart / Kill buttons live in the header overflow menu. Server enforces
  // canControl on /sessions/:id/start and /stop; we additionally hide the
  // items client-side so read-only devices don't see disabled affordances
  // they can't use. Defensive default: assume false until getAuth() resolves
  // — better to flicker an item IN than show it to a device that turns out
  // not to have permission.
  const [canControl, setCanControl] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getAuth()
      .then((auth) => {
        if (!cancelled) setCanControl(auth?.device.canControl === true);
      })
      .catch(() => {
        if (!cancelled) setCanControl(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Modal state for the Kill confirmation. Null when closed. */
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  /**
   * In-flight tracker for the two control actions. We disable BOTH buttons
   * while either is firing — they're mutually-exclusive operations on the
   * same PTY and racing them server-side would just produce a 400 anyway.
   */
  const [controlBusy, setControlBusy] = useState<null | 'restarting' | 'stopping'>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlFlash, setControlFlash] = useState<string | null>(null);
  // Auto-dismiss the success banner so the chat view goes back to normal.
  useEffect(() => {
    if (!controlFlash) return;
    const handle = window.setTimeout(() => setControlFlash(null), 2000);
    return () => window.clearTimeout(handle);
  }, [controlFlash]);

  const runControlAction = useCallback(
    async (
      kind: 'restarting' | 'stopping',
      action: () => Promise<void>,
      successMessage: string,
    ) => {
      setControlBusy(kind);
      setControlError(null);
      setControlFlash(null);
      try {
        await action();
        setControlFlash(successMessage);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setControlError("Read-only — this device can't control sessions.");
        } else if (err instanceof ApiError && err.status === 400) {
          // Server-side "already running" / "not running" lands here. The
          // error body usually has a useful `error` field, but we don't want
          // to render arbitrary server text — keep it generic.
          setControlError(
            kind === 'restarting'
              ? 'Could not start session (already running?).'
              : 'Could not stop session (not running?).',
          );
        } else {
          setControlError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setControlBusy(null);
      }
    },
    [],
  );

  const handleRestart = useCallback(() => {
    setMenuOpen(false);
    void runControlAction('restarting', () => startSession(sessionId), 'Session restarted');
  }, [runControlAction, sessionId]);

  const handleConfirmKill = useCallback(() => {
    setKillConfirmOpen(false);
    void runControlAction('stopping', () => stopSession(sessionId), 'Session stopped');
  }, [runControlAction, sessionId]);

  const shortSessionId = useMemo(() => sessionId.slice(0, 8), [sessionId]);

  // ---- View mode (BDHLNDR-57) ------------------------------------------
  // Persisted per-session in localStorage. Default 'chat'. Toggled via
  // the overflow-menu item below.
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode(sessionId));
  // Re-read when the session id changes (the inner component is mounted
  // per-session so this is mostly belt-and-suspenders).
  useEffect(() => {
    setViewMode(loadViewMode(sessionId));
  }, [sessionId]);
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next: ViewMode = prev === 'chat' ? 'raw' : 'chat';
      saveViewMode(sessionId, next);
      return next;
    });
  }, [sessionId]);

  // ---- Render ----------------------------------------------------------
  // TODO(BDHLNDR-56-followup): "Load older" pagination using
  //   fetchChatEvents(sessionId, { since: oldestTs - 1, limit: 500 })
  // and snapshot.data.hasMore. Out of scope for v1 — 500 rows covers the
  // typical session and adding a sticky "Load older" button competes for
  // attention with the scroll-back UX.

  return (
    <main className="flex h-screen flex-col bg-neutral-900 text-neutral-100">
      <Header
        sessionId={sessionId}
        wsStatus={wsStatus}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        onBack={() => navigate('/sessions')}
        canControl={canControl}
        controlBusy={controlBusy}
        onRestart={handleRestart}
        onRequestKill={() => {
          setMenuOpen(false);
          setKillConfirmOpen(true);
        }}
        viewMode={viewMode}
        onToggleViewMode={toggleViewMode}
      />

      {/* BDHLNDR-62: session-control feedback. The flash auto-dismisses
          (success); the error banner persists until the user takes another
          action so they can read it. Matches the inline sendError pattern
          used by Compose to keep the UX consistent. */}
      {controlError && (
        <div
          role="alert"
          className="border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-200"
        >
          {controlError}
        </div>
      )}
      {controlFlash && (
        <div
          role="status"
          className="border-b border-emerald-900/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200"
        >
          {controlFlash}
        </div>
      )}

      {/*
        Stale-cache indicator (BDHLNDR-59). Surfaced only in chat mode AND
        when the snapshot query is in an error state AND we hydrated from
        cache — i.e. we're showing the user something but it might be stale.
        Healthy network or raw mode → hidden so it doesn't add header noise.
      */}
      {viewMode === 'chat' && snapshot.isError && cacheHydratedAt != null && (
        <div className="border-b border-amber-900/40 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-300/90" role="status">
          Offline — showing cached chat from <RelativeTime ts={cacheHydratedAt} />.
        </div>
      )}

      {/* BDHLNDR-57: render EITHER chat log + compose OR the raw xterm
          view — never both, to avoid duplicate WS handlers and double
          render of incoming output. Header (incl. overflow menu) stays
          identical between modes. */}
      {viewMode === 'raw' ? (
        <RawTerminal sessionId={sessionId} />
      ) : (
        <>
          <div
            ref={scrollRef}
            className="relative flex-1 overflow-y-auto px-3 py-3"
            aria-live="polite"
            aria-relevant="additions"
          >
            {/*
              Loading / error gates. If we have cached events (BDHLNDR-59),
              render them even while the snapshot is loading or has errored —
              the stale-cache indicator above tells the user what they're
              looking at.
            */}
            {snapshot.isLoading && events.length === 0 ? (
              <ChatSkeleton />
            ) : snapshot.isError && events.length === 0 ? (
              <ChatLoadError
                message={
                  snapshot.error instanceof ApiError && snapshot.error.status === 404
                    ? 'Session not found.'
                    : snapshot.error instanceof Error
                      ? snapshot.error.message
                      : 'Failed to load chat history.'
                }
                onRetry={() => void snapshot.refetch()}
              />
            ) : events.length === 0 ? (
              <EmptyChat />
            ) : (
              <ul className="space-y-2">
                {events.map((e, idx) => (
                  <li key={e.id}>
                    <EventRenderer
                      display={e}
                      onTapResponse={handleTapResponse}
                      isLatest={idx === events.length - 1}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Floating "↓ new messages" pill */}
          {!pinnedToBottom && unreadCount > 0 && (
            <button
              type="button"
              onClick={() => {
                scrollToBottom('smooth');
                setUnreadCount(0);
              }}
              className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-lg shadow-blue-900/40 hover:bg-blue-500"
            >
              ↓ {unreadCount} new {unreadCount === 1 ? 'message' : 'messages'}
            </button>
          )}

          <Compose
            draft={draft}
            onDraftChange={setDraft}
            onSend={handleSend}
            sending={sending}
            readOnly={readOnly}
            error={sendError}
            onVoiceTranscript={(text) =>
              setDraft((d) => (d.length === 0 || d.endsWith(' ') ? d + text : d + ' ' + text))
            }
            onVoiceError={setSendError}
          />
        </>
      )}
      {/* BDHLNDR-62: Kill-session confirmation. Controlled JSX overlay
          (no native <dialog> to avoid the platform inconsistencies in
          mobile Safari, which still has incomplete <dialog> support).
          Lives outside the chat/raw view switch so the modal is reachable
          from both modes. */}
      {killConfirmOpen && (
        <KillConfirmDialog
          shortSessionId={shortSessionId}
          stopping={controlBusy === 'stopping'}
          onCancel={() => setKillConfirmOpen(false)}
          onConfirm={handleConfirmKill}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  sessionId,
  wsStatus,
  menuOpen,
  onMenuOpenChange,
  onBack,
  canControl,
  controlBusy,
  onRestart,
  onRequestKill,
  viewMode,
  onToggleViewMode,
}: {
  sessionId: string;
  wsStatus: WsStatus;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onBack: () => void;
  /** BDHLNDR-62: only render control items when the device may use them. */
  canControl: boolean;
  /** Which control action (if any) is currently in flight — disables both. */
  controlBusy: null | 'restarting' | 'stopping';
  onRestart: () => void;
  onRequestKill: () => void;
  viewMode: ViewMode;
  onToggleViewMode: () => void;
}) {
  // We don't fetch the session here just for the name — the session list
  // shows it on the row the user tapped to get here, and the URL id is the
  // authoritative pointer. Showing the (short) id keeps the header
  // self-describing without an extra REST round-trip. A follow-up could pull
  // the name from the same `['sessions']` cache populated by SessionList.
  const shortId = useMemo(() => sessionId.slice(0, 8), [sessionId]);

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-800 bg-neutral-900/95 px-2 py-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to sessions"
          className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="min-w-0">
          <Link
            to="/sessions"
            className="block truncate text-sm font-semibold text-neutral-100 hover:text-white"
          >
            Session <span className="font-mono text-xs text-neutral-400">{shortId}</span>
          </Link>
        </div>
        <ConnectionDot status={wsStatus} />
      </div>
      <OverflowMenu
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        items={[
          // BDHLNDR-57: view-mode toggle. Placed at the TOP per the
          // wave-6 coordination notes — BDHLNDR-62 (Kill / Restart) will
          // append its items at the BOTTOM, so the merge is mechanical.
          {
            label: viewMode === 'chat' ? 'Show raw terminal' : 'Show chat view',
            onSelect: () => {
              onMenuOpenChange(false);
              onToggleViewMode();
            },
          },
          {
            label: 'Back to sessions',
            onSelect: () => {
              onMenuOpenChange(false);
              onBack();
            },
          },
          // BDHLNDR-62: session control items, appended at the BOTTOM of the
          // menu by coordination with BDHLNDR-57 (which inserts its "Show
          // raw terminal" toggle at the TOP). Only rendered when the device
          // has canControl — the server enforces the same gate, so this is
          // purely UX clutter reduction for read-only viewers.
          ...(canControl
            ? [
                {
                  label:
                    controlBusy === 'restarting'
                      ? 'Restarting…'
                      : 'Restart session',
                  disabled: controlBusy !== null,
                  onSelect: () => {
                    if (controlBusy !== null) return;
                    onRestart();
                  },
                },
                {
                  label:
                    controlBusy === 'stopping' ? 'Stopping…' : 'Kill session',
                  danger: true,
                  disabled: controlBusy !== null,
                  onSelect: () => {
                    if (controlBusy !== null) return;
                    onRequestKill();
                  },
                },
              ]
            : []),
        ]}
      />
    </header>
  );
}

// ---------------------------------------------------------------------------
// Event renderers
// ---------------------------------------------------------------------------

function EventRenderer({
  display,
  onTapResponse,
  isLatest: _isLatest,
}: {
  display: DisplayEvent;
  onTapResponse: (eventId: string, optionKey: string) => void;
  isLatest: boolean;
}) {
  const { event, id, consumedKey } = display;
  switch (event.type) {
    case 'assistant_text':
      return <AssistantBubble text={event.payload.text} />;
    case 'tool_call':
      return <ToolCallRow tool={event.payload.tool} argsBrief={event.payload.argsBrief} />;
    case 'error':
      return <ErrorCard text={event.payload.text} />;
    case 'prompt_yes_no':
      return (
        <PromptYesNo
          question={event.payload.question}
          consumedKey={consumedKey}
          onTap={(key) => onTapResponse(id, key)}
        />
      );
    case 'prompt_options':
      return (
        <PromptOptions
          question={event.payload.question}
          options={event.payload.options}
          consumedKey={consumedKey}
          onTap={(key) => onTapResponse(id, key)}
        />
      );
    case 'response':
      return <ResponseBubble text={event.payload.text} />;
    default:
      // Exhaustiveness guard — if a new event type is added to ChatEvent
      // we want the type error here at compile time.
      return null;
  }
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[85%] break-words rounded-2xl rounded-tl-sm bg-neutral-800 px-3 py-2 text-sm text-neutral-100">
      <PlainTextWithBreaks text={text} />
    </div>
  );
}

function ResponseBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] break-words rounded-2xl rounded-tr-sm bg-blue-600/30 px-3 py-2 text-sm text-blue-100">
        <PlainTextWithBreaks text={text} />
      </div>
    </div>
  );
}

function ToolCallRow({ tool, argsBrief }: { tool: string; argsBrief: string }) {
  return (
    <div className="break-all rounded-md bg-neutral-800/40 px-3 py-1 font-mono text-xs text-neutral-400">
      <span className="text-neutral-500">⏺ </span>
      <span className="text-neutral-300">{tool}</span>
      <span className="text-neutral-500">({argsBrief})</span>
    </div>
  );
}

function ErrorCard({ text }: { text: string }) {
  return (
    <div className="max-w-[85%] rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-200">
      {text}
    </div>
  );
}

function PromptYesNo({
  question,
  consumedKey,
  onTap,
}: {
  question: string;
  consumedKey?: string;
  onTap: (key: string) => void;
}) {
  return (
    <div className="space-y-2">
      <AssistantBubble text={question} />
      <div className="flex gap-2 pl-1">
        <TapResponseButton
          label="Yes"
          sendingBytes="y\n"
          onTap={() => onTap('y')}
          used={consumedKey === 'y'}
          dimmed={consumedKey !== undefined && consumedKey !== 'y'}
        />
        <TapResponseButton
          label="No"
          sendingBytes="n\n"
          onTap={() => onTap('n')}
          used={consumedKey === 'n'}
          dimmed={consumedKey !== undefined && consumedKey !== 'n'}
        />
      </div>
    </div>
  );
}

function PromptOptions({
  question,
  options,
  consumedKey,
  onTap,
}: {
  question: string;
  options: PromptOption[];
  consumedKey?: string;
  onTap: (key: string) => void;
}) {
  return (
    <div className="space-y-2">
      <AssistantBubble text={question} />
      <div className="flex flex-col gap-2 pl-1">
        {options.map((opt) => (
          <TapResponseButton
            key={opt.key}
            label={opt.label}
            sendingBytes={`${opt.key}\\n`}
            onTap={() => onTap(opt.key)}
            used={consumedKey === opt.key}
            dimmed={consumedKey !== undefined && consumedKey !== opt.key}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One-tap response button. The subtext shows the LITERAL bytes about to be
 * sent — design rule: never hide what's going down the wire. We render
 * "\n" as the two-character escape sequence rather than an actual newline
 * (a real newline in the subtext would just produce a blank line and the
 * user would be left guessing what "Sending: y[blank]" means).
 *
 * Once `used` flips true, the button shrinks visually and becomes
 * non-interactive — the prompt isn't actionable a second time because the
 * server's next state will be a different event entirely.
 *
 * `dimmed` is the sibling-of-used state: the OTHER button(s) on the same
 * prompt fade further so it's clear which one was picked.
 */
function TapResponseButton({
  label,
  sendingBytes,
  onTap,
  used,
  dimmed,
}: {
  label: string;
  sendingBytes: string;
  onTap: () => void;
  used: boolean;
  dimmed: boolean;
}) {
  const disabled = used || dimmed;
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      className={`flex flex-col items-start rounded-lg border px-4 py-2 text-left transition-all disabled:cursor-not-allowed ${
        used
          ? 'border-blue-700 bg-blue-700/40 text-blue-100 opacity-70'
          : dimmed
            ? 'border-neutral-800 bg-neutral-900/40 text-neutral-500 opacity-50'
            : 'border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700 active:bg-neutral-600'
      }`}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="mt-0.5 font-mono text-[10px] text-neutral-400">
        Sending: {sendingBytes}
      </span>
    </button>
  );
}

/**
 * Render text with `\n` → `<br>`. Minimal "markdown" — actually just
 * paragraph breaks. See file header for rationale on deferring real MD.
 */
function PlainTextWithBreaks({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

function Compose({
  draft,
  onDraftChange,
  onSend,
  sending,
  readOnly,
  error,
  onVoiceTranscript,
  onVoiceError,
}: {
  draft: string;
  onDraftChange: (s: string) => void;
  onSend: () => void;
  sending: boolean;
  readOnly: boolean;
  error: string | null;
  onVoiceTranscript: (text: string) => void;
  onVoiceError: (message: string) => void;
}) {
  // BDHLNDR-15: detect Web Speech API support ONCE per component mount.
  // The capability doesn't change at runtime, so this avoids re-checking on
  // every keystroke (the parent re-renders this component on every draft
  // change for the auto-size effect). Mic button is omitted entirely on
  // unsupported browsers — no "feature unavailable" cruft.
  const voiceSupported = useMemo(() => isVoiceInputSupported(), []);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-size the textarea up to COMPOSE_MAX_ROWS. We reset height to 'auto'
  // first so scrollHeight reflects the natural content height; then clamp.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const max = lineHeight * COMPOSE_MAX_ROWS + 16; // +16 ≈ vertical padding
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  }, [draft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline. This matches every chat
    // app on every platform — users expect it.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sending && draft.trim() && !readOnly) onSend();
    }
  };

  const canSend = !sending && !readOnly && draft.trim().length > 0;

  return (
    <div className="sticky bottom-0 z-10 border-t border-neutral-800 bg-neutral-900/95 px-2 py-2 backdrop-blur">
      {error && (
        <p role="alert" className="px-2 pb-1 text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2">
        {voiceSupported && (
          <VoiceInput
            disabled={sending || readOnly}
            onTranscript={onVoiceTranscript}
            onError={onVoiceError}
          />
        )}
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={readOnly ? 'Read-only device' : 'Message Claude…'}
          disabled={readOnly}
          rows={1}
          className="min-h-[40px] flex-1 resize-none rounded-2xl border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-blue-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
        >
          {sending ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
              <path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.4 1.06l1.45 5.79a1 1 0 0 0 .82.74L12 12l-7.73 1.81a1 1 0 0 0-.82.74L2 19.34a1 1 0 0 0 1.4 1.06z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function ChatSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <div className="h-10 w-3/4 animate-pulse rounded-2xl bg-neutral-800" />
      <div className="ml-auto h-8 w-1/2 animate-pulse rounded-2xl bg-blue-900/30" />
      <div className="h-16 w-4/5 animate-pulse rounded-2xl bg-neutral-800" />
      <div className="h-6 w-2/3 animate-pulse rounded-md bg-neutral-800/40" />
      <div className="h-10 w-3/5 animate-pulse rounded-2xl bg-neutral-800" />
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="px-4 text-center text-sm text-neutral-500">
        No conversation yet — Claude hasn&apos;t said anything in this session.
      </p>
    </div>
  );
}

function ChatLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-md border border-red-900/60 bg-red-950/30 p-4">
      <p className="text-sm text-red-200">Couldn&apos;t load chat history.</p>
      <p className="mt-1 text-xs text-red-300/80">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-md border border-red-800 bg-red-900/40 px-3 py-1 text-xs text-red-100 hover:bg-red-900/60"
      >
        Try again
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kill confirmation modal (BDHLNDR-62)
// ---------------------------------------------------------------------------

/**
 * Tiny controlled-JSX confirm modal for the destructive "Kill session"
 * action. We avoid the native `<dialog>` element because mobile Safari's
 * `<dialog>` implementation still has gaps (focus-trap, backdrop interop)
 * that aren't worth chasing for a single confirm, and bringing in a modal
 * lib for one prompt would dwarf the feature. The overlay is fixed-position
 * with an ARIA-labeled inner card; tapping the dim backdrop cancels.
 */
function KillConfirmDialog({
  shortSessionId,
  stopping,
  onCancel,
  onConfirm,
}: {
  shortSessionId: string;
  stopping: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kill-confirm-title"
      onClick={(e) => {
        // Click on backdrop only — taps inside the card shouldn't dismiss.
        if (e.target === e.currentTarget && !stopping) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xl">
        <h2 id="kill-confirm-title" className="text-base font-semibold text-neutral-100">
          Stop session?
        </h2>
        <p className="mt-2 text-sm text-neutral-300">
          This will kill the PTY for session{' '}
          <span className="font-mono text-neutral-100">{shortSessionId}</span>.
          Any unsaved work in the terminal will be lost.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={stopping}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={stopping}
            className="rounded-md border border-red-800 bg-red-700/80 px-3 py-1.5 text-sm font-medium text-red-50 hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {stopping ? 'Stopping…' : 'Stop session'}
          </button>
        </div>
      </div>
    </div>
  );
}
