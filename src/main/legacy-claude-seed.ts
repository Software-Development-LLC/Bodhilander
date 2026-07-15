import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log';

/**
 * Seed a brand-new account config dir with the legacy ~/.claude conversation
 * transcripts.
 *
 * Before any account exists, sessions resume against legacy ~/.claude. The
 * first registered account becomes the default and re-homes every unassigned
 * session to its config dir — which starts empty, so every stored --resume
 * UUID stops resolving ("No conversation found with session ID: x") and all
 * pre-account conversation history is orphaned. Copying projects/ (the
 * per-cwd transcript store Claude Code reads on --resume) into the first
 * account's dir preserves that continuity.
 *
 * Deliberately NOT copied: credentials (the login flow authenticates the
 * account fresh) and settings.json (MCP/hook registration writes its own).
 *
 * Failures are logged and swallowed — a missed seed degrades to the old
 * behavior (fresh conversations), never blocks account creation.
 *
 * (Lives outside account-auth so it stays importable without node-pty.)
 *
 * @returns true when transcripts were copied.
 */
export async function seedLegacyConversations(
  configDir: string,
  legacyDir: string = path.join(os.homedir(), '.claude'),
): Promise<boolean> {
  const source = path.join(legacyDir, 'projects');
  const target = path.join(configDir, 'projects');
  try {
    if (!fs.existsSync(source)) return false;
    // A populated target means this dir already has history — never clobber.
    if (fs.existsSync(target)) return false;
    await fs.promises.cp(source, target, { recursive: true });
    log.info(`[Accounts] Seeded legacy conversation transcripts: ${source} → ${target}`);
    return true;
  } catch (err) {
    log.warn(
      '[Accounts] Failed to seed legacy conversations — resume of pre-account sessions may fail:',
      err,
    );
    return false;
  }
}
