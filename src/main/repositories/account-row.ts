import { ClaudeAccount } from '../../shared/types';

/** claude_accounts row → domain object. Shared by the accounts repository and
 *  the account resolver so both agree on defaults for nullable columns. */
export function mapAccountRow(row: any): ClaudeAccount {
  return {
    id: row.id,
    label: row.label,
    configDir: row.config_dir,
    email: row.email ?? null,
    color: row.color ?? '#888888',
    isDefault: Boolean(row.is_default),
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    fallbackRank: row.fallback_rank ?? null,
    limitedUntil: row.limited_until ? new Date(row.limited_until) : null,
    limitedAt: row.limited_at ? new Date(row.limited_at) : null,
  };
}
