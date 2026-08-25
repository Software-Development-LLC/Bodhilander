import { useState, useCallback, useEffect } from 'react';
import { Session, SessionState, DEFAULT_SESSION_PROVIDER } from '../../shared/types';

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * Re-read the list from main. Part of what a session reports is derived
   * there from the filesystem — `workingDirMissing` above all — so no local
   * merge can produce it, and a stale copy outlives the change it describes.
   */
  const refreshSessions = useCallback(async () => {
    try {
      const dbSessions = await window.electronAPI.getAllSessions();
      setSessions(dbSessions);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSessions();

    // Listen for state changes from hooks
    const cleanupStateChange = window.electronAPI.onStateChange((event) => {
      // Validate state is a valid SessionState
      const validStates: SessionState[] = ['idle', 'working', 'waiting', 'error', 'stopped'];
      if (!validStates.includes(event.state as SessionState)) {
        console.error('Invalid session state received:', event.state);
        return;
      }

      setSessions(prev => prev.map(s =>
        s.id === event.sessionId
          ? { ...s, state: event.state as SessionState, lastActivityAt: new Date(event.timestamp * 1000) }
          : s
      ));
    });

    // Reload the list when a session is created remotely (relay / mobile) so the
    // desktop UI stays in sync with sessions started from the web client.
    const cleanupRefresh = window.electronAPI.onSessionsRefresh(() => { void refreshSessions(); });

    // A working directory can be moved or deleted while the app is running.
    // Returning to the window is when that matters, and it costs one stat per
    // distinct folder.
    const onFocus = () => { void refreshSessions(); };
    window.addEventListener('focus', onFocus);

    return () => {
      cleanupStateChange();
      cleanupRefresh();
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshSessions]);

  const createSession = useCallback(async (
    groupId: string,
    name: string,
    workingDir: string,
    launchClaude: boolean = true,
    provider: string = DEFAULT_SESSION_PROVIDER
  ): Promise<Session> => {
    return new Promise((resolve, reject) => {
      setSessions(prev => {
        const session: Session = {
          id: crypto.randomUUID(),
          groupId,
          name,
          workingDir,
          state: 'idle',
          shellType: launchClaude ? 'claude' : 'bash',
          order: prev.filter(s => s.groupId === groupId).length,
          createdAt: new Date(),
          lastActivityAt: new Date(),
          claudeSessionId: null,
          endedAt: null,
          durationSeconds: 0,
          claudeAccountId: null,
          provider,
        };

        // Activate immediately so the Terminal mounts in a visible container.
        // Previously this was deferred to the .then() below, which meant the
        // terminal wrapper had display:none during the first render. fitAddon
        // would measure a hidden container (≈2 cols) and send that bogus size
        // to the PTY, causing Claude to output at the wrong column width.
        setActiveSessionId(session.id);

        // Persist asynchronously
        window.electronAPI.createDbSession(session)
          .then(() => {
            resolve(session);
          })
          .catch((error) => {
            console.error('Failed to create session:', error);
            // Rollback by removing the session
            setSessions(current => current.filter(s => s.id !== session.id));
            reject(error);
          });

        return [...prev, session]; // Optimistic update
      });
    });
  }, []);

  const updateSessionState = useCallback(async (id: string, state: SessionState) => {
    try {
      const updates = { state, lastActivityAt: new Date() };
      await window.electronAPI.updateDbSession(id, updates);
      setSessions(prev => prev.map(s =>
        s.id === id
          ? { ...s, ...updates }
          : s
      ));
    } catch (error) {
      console.error('Failed to update session state:', error);
      // Don't update state - DB failed
    }
  }, []);

  const updateSession = useCallback(async (id: string, updates: Partial<Session>) => {
    try {
      await window.electronAPI.updateDbSession(id, updates);
      // Merge first so the row reacts immediately, then take main's answer:
      // the patch cannot carry the derived fields, and relinking a session
      // changes exactly one of them.
      setSessions(prev => prev.map(s =>
        s.id === id ? { ...s, ...updates } : s
      ));
      await refreshSessions();
    } catch (error) {
      console.error('Failed to update session:', error);
    }
  }, [refreshSessions]);

  /**
   * Reassign a session's Claude account (BDHLNDR-31). Goes through the
   * dedicated channel rather than updateSession because main has to carry the
   * conversation transcript into the new account's config dir and tell us which
   * ptys need restarting — the column write alone leaves a live session on the
   * old account.
   */
  const setSessionAccount = useCallback(async (id: string, accountId: string | null): Promise<string[]> => {
    try {
      const { affectedSessionIds } = await window.electronAPI.assignAccountToSession(id, accountId);
      setSessions(prev => prev.map(s =>
        s.id === id ? { ...s, claudeAccountId: accountId } : s
      ));
      return affectedSessionIds;
    } catch (error) {
      console.error('Failed to assign account to session:', error);
      return [];
    }
  }, []);

  const removeSession = useCallback(async (id: string) => {
    try {
      await window.electronAPI.deleteDbSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
      if (activeSessionId === id) {
        setActiveSessionId(null);
      }
    } catch (error) {
      console.error('Failed to remove session:', error);
      // Don't update state - DB failed
    }
  }, [activeSessionId]);

  const getSessionsByGroup = useCallback((groupId: string) => {
    return sessions.filter(s => s.groupId === groupId);
  }, [sessions]);

  const getStateCounts = useCallback(() => {
    return {
      waiting: sessions.filter(s => s.state === 'waiting').length,
      working: sessions.filter(s => s.state === 'working').length,
      idle: sessions.filter(s => s.state === 'idle').length,
      error: sessions.filter(s => s.state === 'error').length,
      stopped: sessions.filter(s => s.state === 'stopped').length,
    };
  }, [sessions]);

  const reorderSession = useCallback(async (sessionId: string, targetGroupId: string, newOrder: number) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId);
      if (!session) return prev;

      // Get sessions in target group, excluding the moved session
      const targetGroupSessions = prev
        .filter(s => s.groupId === targetGroupId && s.id !== sessionId)
        .sort((a, b) => a.order - b.order);

      // Insert at new position
      targetGroupSessions.splice(newOrder, 0, { ...session, groupId: targetGroupId });

      // Update orders for all sessions in target group
      const updatedTargetSessions = targetGroupSessions.map((s, idx) => ({
        ...s,
        order: idx,
      }));

      // Keep sessions from other groups, and replace target group sessions
      const otherSessions = prev.filter(s => s.groupId !== targetGroupId && s.id !== sessionId);
      const newSessions = [...otherSessions, ...updatedTargetSessions];

      // Persist changes
      updatedTargetSessions.forEach(s => {
        window.electronAPI.updateDbSession(s.id, { groupId: s.groupId, order: s.order })
          .catch(err => console.error('Failed to update session order:', err));
      });

      return newSessions;
    });
  }, []);

  return {
    sessions,
    loading,
    activeSessionId,
    setActiveSessionId,
    createSession,
    updateSession,
    updateSessionState,
    setSessionAccount,
    removeSession,
    getSessionsByGroup,
    getStateCounts,
    refreshSessions,
    reorderSession,
  };
}
