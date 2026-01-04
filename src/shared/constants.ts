export const RELAY_URL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:3000'
  : 'https://cl-relay.sytanek.tech';

export const TIER_LIMITS = {
  free: { maxShares: 1, maxViewers: 2, maxDuration: 30, maxCodes: 2 },
  pro: { maxShares: 5, maxViewers: 10, maxDuration: null, maxCodes: null },
  admin: { maxShares: null, maxViewers: null, maxDuration: null, maxCodes: null },
} as const;

export type UserTier = 'free' | 'pro' | 'admin';
