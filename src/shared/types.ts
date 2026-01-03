export type SessionState = 'idle' | 'working' | 'waiting' | 'error' | 'stopped';

export interface Session {
  id: string;
  groupId: string;
  name: string;
  workingDir: string;
  state: SessionState;
  shellType: string;
  order: number;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  workingDir: string;
  order: number;
  createdAt: Date;
  parentId: string | null;
  collapsed: boolean;
}

export interface AppState {
  groups: Group[];
  sessions: Session[];
  activeSessionId: string | null;
}

// Sharing types
export interface ShareUser {
  id: string;
  username: string;
  email?: string;
  tier: 'free' | 'pro' | 'admin';
}

export interface ShareSession {
  id: string;
  hostPublicKey: string;
  startedAt: string;
  codes: ShareCode[];
}

export interface ShareCode {
  code: string;
  permission: 'read' | 'control';
  maxUses: number | null;
  currentUses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateCodeOptions {
  permission: 'read' | 'control';
  maxUses?: number;
  expiresInMinutes?: number;
}

export interface SharedSessionInfo {
  sessionId: string;
  hostUsername: string;
  permission: 'read' | 'control';
  connectedAt: Date;
}

export interface GuestInfo {
  userId: string;
  username: string;
  permission: 'read' | 'control';
  publicKey: string;
}
