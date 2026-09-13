/**
 * Killing a spawned CLI and everything it started.
 *
 * Extracted from the arena engine when the run engine needed the same thing
 * (CO-722). A second copy would have been the easier change and the wrong
 * one: this routine encodes three platform facts that were learned the hard
 * way, and a copy of it drifts from the copy it was made of.
 */
import { execFile, ChildProcess } from 'child_process';
import * as path from 'path';

/** Grace period between SIGTERM and the SIGKILL escalation. */
const KILL_GRACE_MS = 3000;

/**
 * Kill a child's whole process tree.
 *
 * A CLI launched through a wrapper shell is a grandchild, so signalling the
 * child alone leaves the actual agent running detached — still spending
 * tokens, still holding the worktree, and invisible to whatever thought it
 * had cancelled it. POSIX children are spawned detached (their own process
 * group) and killed by group, escalating to SIGKILL if the tree ignores
 * SIGTERM: without the escalation `close` never fires and the caller waits
 * forever on a process it already gave up on. Windows `taskkill /F /T` is
 * already both forceful and recursive.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    // Absolute path so a poisoned PATH can't substitute the binary (S4036).
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    execFile(taskkill, ['/F', '/T', '/PID', String(pid)], () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill();
    return;
  }
  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Process group already gone — nothing to escalate.
    }
  }, KILL_GRACE_MS);
  escalation.unref?.();
  child.once('close', () => clearTimeout(escalation));
}
