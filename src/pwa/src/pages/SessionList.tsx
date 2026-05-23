/**
 * /sessions — real session list view (BDHLNDR-55).
 *
 * Architecture notes:
 *   - React Query owns the cache for `['sessions']` and `['groups']`.
 *   - WS `sessions:updated` / `groups:updated` invalidate the matching
 *     query so the list refetches; `session:state` patches the cache in
 *     place to avoid refetching the whole list on every state pill flip.
 *   - Group collapsed state persists in localStorage so the user's layout
 *     survives reloads (PWA stays installed across days).
 *   - The unpair button now lives in a header overflow menu so other
 *     pages (SessionDetail in BDHLNDR-56) can render the same menu later.
 *
 * Pull-to-refresh is implemented inline with touch events (~30 LOC, no
 * new dependency). It triggers a full React Query invalidation rather
 * than a soft refetch so we pick up any drift since the last `sessions:
 * updated` broadcast.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch, fetchGroups, fetchSessions } from '../lib/api';
import { clearAuth, getAuth } from '../lib/auth';
import type { Group, Session, SessionState } from '../lib/types';
import { wsClient, type SessionStateMessage, type WsStatus } from '../lib/ws';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLAPSED_GROUPS_KEY = 'bodhilander:collapsedGroups';
const UNGROUPED_KEY = '__ungrouped__';
const PULL_TO_REFRESH_THRESHOLD = 70; // px the user must drag past

const STATE_PILL: Record<SessionState, { label: string; className: string }> = {
  waiting: {
    label: 'Waiting',
    className: 'bg-amber-500/20 text-amber-300',
  },
  working: {
    label: 'Working',
    className: 'bg-blue-500/20 text-blue-300',
  },
  idle: {
    label: 'Idle',
    className: 'bg-neutral-700/40 text-neutral-300',
  },
  error: {
    label: 'Error',
    className: 'bg-red-500/20 text-red-300',
  },
  stopped: {
    label: 'Stopped',
    className: 'bg-neutral-800 text-neutral-500',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionList() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: fetchSessions,
  });
  const groupsQuery = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
  });

  // ---- WS live updates -------------------------------------------------
  useEffect(() => {
    const unsubSessionsUpdated = wsClient.on('sessions:updated', () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    });
    const unsubGroupsUpdated = wsClient.on('groups:updated', () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
    });

    // session:state — surgical patch. Avoids a full list refetch every time
    // a single session flips between waiting/working/idle (which can happen
    // many times per second during an active turn).
    const unsubSessionState = wsClient.on(
      'session:state',
      (msg: SessionStateMessage) => {
        qc.setQueryData<Session[] | undefined>(['sessions'], (prev) => {
          if (!prev) return prev;
          const nextState = msg.payload.state as SessionState;
          let changed = false;
          const next = prev.map((s) => {
            if (s.id !== msg.sessionId) return s;
            if (s.state === nextState) return s;
            changed = true;
            return { ...s, state: nextState };
          });
          return changed ? next : prev;
        });
      },
    );

    return () => {
      unsubSessionsUpdated();
      unsubGroupsUpdated();
      unsubSessionState();
    };
  }, [qc]);

  // ---- WS status (for the dot) ----------------------------------------
  const [wsStatus, setWsStatus] = useState<WsStatus>(wsClient.status);
  useEffect(() => wsClient.onStatusChange(setWsStatus), []);

  // ---- Collapsed-group persistence ------------------------------------
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return new Set(parsed as string[]);
      return new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_GROUPS_KEY,
        JSON.stringify(Array.from(collapsed)),
      );
    } catch {
      // localStorage can throw in private-browsing — non-fatal.
    }
  }, [collapsed]);
  const toggleCollapsed = useCallback((groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  // ---- Group sessions --------------------------------------------------
  const grouped = useMemo(
    () => groupSessions(sessionsQuery.data ?? [], groupsQuery.data ?? []),
    [sessionsQuery.data, groupsQuery.data],
  );

  // ---- Pull-to-refresh ------------------------------------------------
  const containerRef = useRef<HTMLDivElement>(null);
  const pullStateRef = useRef<{ startY: number; pulling: boolean }>({
    startY: 0,
    pulling: false,
  });
  const [pullOffset, setPullOffset] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    // Only engage when scrolled to the very top — otherwise we're competing
    // with native scroll which is jankier than just yielding.
    if ((containerRef.current?.scrollTop ?? 0) > 0) return;
    pullStateRef.current = { startY: e.touches[0].clientY, pulling: true };
  };
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!pullStateRef.current.pulling) return;
    const delta = e.touches[0].clientY - pullStateRef.current.startY;
    if (delta <= 0) {
      setPullOffset(0);
      return;
    }
    // Apply a rubber-band so the indicator feels weighted past the threshold.
    setPullOffset(Math.min(delta * 0.5, PULL_TO_REFRESH_THRESHOLD * 1.5));
  };
  const onTouchEnd = async () => {
    if (!pullStateRef.current.pulling) return;
    pullStateRef.current.pulling = false;
    const triggered = pullOffset >= PULL_TO_REFRESH_THRESHOLD;
    setPullOffset(0);
    if (!triggered) return;
    setRefreshing(true);
    try {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sessions'] }),
        qc.invalidateQueries({ queryKey: ['groups'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  // ---- Unpair ---------------------------------------------------------
  const [menuOpen, setMenuOpen] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);

  async function handleUnpair() {
    setMenuOpen(false);
    setUnpairError(null);
    setUnpairing(true);
    try {
      const auth = await getAuth();
      if (!auth) {
        navigate('/pair', { replace: true });
        return;
      }
      await apiFetch(`/pairing/devices/${encodeURIComponent(auth.device.id)}`, {
        method: 'DELETE',
      });
      // Close the WS BEFORE clearing auth so the server sees a clean 1000.
      wsClient.disconnect();
      await clearAuth();
      navigate('/pair', { replace: true });
    } catch (err) {
      setUnpairError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnpairing(false);
    }
  }

  // ---- Render ---------------------------------------------------------
  return (
    <main
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className="mx-auto min-h-screen max-w-md overflow-y-auto"
    >
      {/* Pull-to-refresh indicator */}
      {(pullOffset > 0 || refreshing) && (
        <div
          className="flex items-center justify-center text-xs text-neutral-500"
          style={{ height: refreshing ? PULL_TO_REFRESH_THRESHOLD : pullOffset }}
        >
          {refreshing
            ? 'Refreshing…'
            : pullOffset >= PULL_TO_REFRESH_THRESHOLD
              ? 'Release to refresh'
              : 'Pull to refresh'}
        </div>
      )}

      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-800 bg-neutral-900/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">Sessions</h1>
          <ConnectionDot status={wsStatus} />
        </div>
        <OverflowMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={[
            {
              label: unpairing ? 'Unpairing…' : 'Unpair this device',
              onSelect: handleUnpair,
              disabled: unpairing,
              danger: true,
            },
          ]}
        />
      </header>

      {unpairError && (
        <p role="alert" className="px-4 pt-2 text-xs text-red-300">
          {unpairError}
        </p>
      )}

      <div className="p-4">
        {sessionsQuery.isLoading || groupsQuery.isLoading ? (
          <SessionListSkeleton />
        ) : sessionsQuery.isError ? (
          <ErrorState
            message={
              sessionsQuery.error instanceof Error
                ? sessionsQuery.error.message
                : 'Failed to load sessions'
            }
            onRetry={() => {
              void sessionsQuery.refetch();
              void groupsQuery.refetch();
            }}
          />
        ) : grouped.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {grouped.map((g) => (
              <GroupBlock
                key={g.group?.id ?? UNGROUPED_KEY}
                group={g.group}
                sessions={g.sessions}
                collapsed={collapsed.has(g.group?.id ?? UNGROUPED_KEY)}
                onToggle={() =>
                  toggleCollapsed(g.group?.id ?? UNGROUPED_KEY)
                }
                onOpen={(id) => navigate(`/sessions/${id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

interface GroupedRow {
  /** null for sessions whose groupId doesn't match any known group. */
  group: Group | null;
  sessions: Session[];
}

/**
 * Bucket sessions by their `groupId`, ordered by group `order` then session
 * `order`. Sessions referencing an unknown group fall into a single
 * "Ungrouped" bucket rendered last so they're not lost.
 */
function groupSessions(sessions: Session[], groups: Group[]): GroupedRow[] {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const buckets = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = groupsById.has(s.groupId) ? s.groupId : UNGROUPED_KEY;
    const list = buckets.get(key) ?? [];
    list.push(s);
    buckets.set(key, list);
  }

  const rows: GroupedRow[] = [];
  // Known groups in their declared order.
  const orderedGroups = [...groups].sort((a, b) => a.order - b.order);
  for (const g of orderedGroups) {
    const list = buckets.get(g.id);
    if (!list || list.length === 0) continue;
    rows.push({ group: g, sessions: list.sort((a, b) => a.order - b.order) });
  }
  // Ungrouped last.
  const orphans = buckets.get(UNGROUPED_KEY);
  if (orphans && orphans.length > 0) {
    rows.push({ group: null, sessions: orphans.sort((a, b) => a.order - b.order) });
  }
  return rows;
}

function GroupBlock({
  group,
  sessions,
  collapsed,
  onToggle,
  onOpen,
}: {
  group: Group | null;
  sessions: Session[];
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const label = group?.name ?? 'Ungrouped';
  const color = group?.color ?? '#525252';

  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left text-sm text-neutral-300 hover:bg-neutral-800/40"
        aria-expanded={!collapsed}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="font-medium">{label}</span>
          <span className="text-xs text-neutral-500">{sessions.length}</span>
        </span>
        <span
          aria-hidden
          className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
        >
          ›
        </span>
      </button>
      {!collapsed && (
        <ul className="mt-2 space-y-1.5">
          {sessions.map((s) => (
            <li key={s.id}>
              <SessionRow session={s} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: Session;
  onOpen: (id: string) => void;
}) {
  const pill = STATE_PILL[session.state] ?? STATE_PILL.idle;
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2.5 text-left transition-colors hover:bg-neutral-800/60 active:bg-neutral-800"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-neutral-100">
          {session.name || '(unnamed)'}
        </div>
        <div className="mt-0.5 truncate text-xs text-neutral-500">
          {session.workingDir}
        </div>
      </div>
      <span
        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${pill.className}`}
      >
        {pill.label}
      </span>
    </button>
  );
}

function ConnectionDot({ status }: { status: WsStatus }) {
  const tone =
    status === 'connected'
      ? { color: 'bg-emerald-500', label: 'Connected' }
      : status === 'connecting' || status === 'reconnecting'
        ? { color: 'bg-amber-400 animate-pulse', label: 'Reconnecting' }
        : { color: 'bg-red-500', label: 'Disconnected' };
  return (
    <span
      role="status"
      aria-label={tone.label}
      title={tone.label}
      className={`inline-block h-2 w-2 rounded-full ${tone.color}`}
    />
  );
}

interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * Tiny 3-dot overflow menu. Inline rather than a standalone component
 * because right now SessionList is the only consumer; when SessionDetail
 * (BDHLNDR-56) needs the same menu we'll lift it to
 * `src/pwa/src/components/OverflowMenu.tsx` and parameterize the items.
 */
function OverflowMenu({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: MenuItem[];
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Open menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex h-9 w-9 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
          <circle cx="12" cy="5" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="12" cy="19" r="1.6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-lg"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={item.onSelect}
              className={`block w-full px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                item.danger
                  ? 'text-red-300 hover:bg-red-900/30'
                  : 'text-neutral-200 hover:bg-neutral-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionListSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-md border border-neutral-800 bg-neutral-900"
        />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed border-neutral-800 p-6 text-center">
      <p className="text-sm font-medium text-neutral-200">No sessions yet</p>
      <p className="mt-1 text-xs text-neutral-500">
        Create a session in the Bodhilander desktop app — it&apos;ll show up
        here automatically.
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-md border border-red-900/60 bg-red-950/30 p-4">
      <p className="text-sm text-red-200">Couldn&apos;t load sessions.</p>
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
