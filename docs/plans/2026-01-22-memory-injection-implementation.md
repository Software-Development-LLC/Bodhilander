# Memory Injection via System Prompt - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace PTY-based memory injection with `--append-system-prompt` CLI flag to eliminate timing issues and duplicate injections.

**Architecture:** Memory content is fetched before spawning Claude and passed as a CLI argument. The complex state detection for injection purposes is removed while keeping state detection for UI display.

**Tech Stack:** TypeScript, node-pty, Claude CLI

---

### Task 1: Update Memory Injector Format

**Files:**
- Modify: `src/main/memory/injector.ts:141-178`

**Step 1: Update `getMemoryInjectionContent()` for system prompt format**

Replace the function (lines 141-178) with:

```typescript
/**
 * Get formatted memory content for system prompt injection.
 * Returns content suitable for --append-system-prompt CLI flag.
 * Returns null if no groupId provided or empty string if no memories.
 */
export function getMemoryInjectionContent(
  sessionId: string,
  groupId: string
): string | null {
  if (!groupId) {
    return null;
  }

  const memories = getMemoriesForInjection(sessionId, groupId);

  // Build memory list with pinned items marked
  const memoryItems: string[] = [];

  // Add pinned memories first (most important)
  const pinnedMemories = memories.filter(m => m.pinned);
  for (const memory of pinnedMemories) {
    memoryItems.push(`- ${memory.content} [PINNED]`);
  }

  // Add other memories
  for (const memory of memories.filter(m => !m.pinned)) {
    memoryItems.push(`- ${memory.content}`);
  }

  if (memoryItems.length === 0) {
    // No memories yet, just provide group_id for saving new ones
    return `<session-memories>
No saved memories for this session yet.
To save new memories, use the MCP tool with group_id: ${groupId}
</session-memories>`;
  }

  // Format as multi-line system prompt content
  return `<session-memories>
You have saved memories from previous sessions in this workspace:
${memoryItems.join('\n')}

To save new memories, use the MCP tool with group_id: ${groupId}
</session-memories>`;
}
```

**Step 2: Run TypeScript compiler to verify no errors**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/memory/injector.ts
git commit -m "refactor(memory): update injection format for system prompt"
```

---

### Task 2: Add Helper for Shell-Safe System Prompt

**Files:**
- Modify: `src/main/memory/injector.ts`

**Step 1: Add shell escaping helper function**

Add after the imports (around line 8):

```typescript
/**
 * Escape content for use in shell command arguments.
 * Uses single quotes with proper escaping for special characters.
 */
export function escapeForShell(content: string): string {
  // For Windows cmd/powershell and Unix shells, double-quote escaping works
  // Escape backslashes first, then double quotes
  return content
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}
```

**Step 2: Run TypeScript compiler to verify no errors**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/memory/injector.ts
git commit -m "feat(memory): add shell escaping helper for system prompt"
```

---

### Task 3: Update PTY Manager to Use System Prompt Flag

**Files:**
- Modify: `src/main/pty-manager.ts:7,58-178`

**Step 1: Update import to include escapeForShell**

Change line 7 from:
```typescript
import { writeMemoryFile, getMemoryInjectionContent } from './memory/injector';
```

To:
```typescript
import { writeMemoryFile, getMemoryInjectionContent, escapeForShell } from './memory/injector';
```

**Step 2: Get memory content before spawning and build Claude command with flag**

In `createSession()`, after line 84 (after `getClaudeCommand` call), add logic to get memory content and build the claude command string. Replace the Claude launch sections (lines 86-114) with:

```typescript
      // Get memory content for system prompt injection
      let claudeCmd = 'claude';
      if (groupId) {
        const memoryContent = getMemoryInjectionContent(id, groupId);
        if (memoryContent) {
          const escapedContent = escapeForShell(memoryContent);
          claudeCmd = `claude --append-system-prompt "${escapedContent}"`;
        }
      }

      if (shellInfo.isWSL) {
        // Launch Claude inside WSL
        shell = 'wsl.exe';
        args = [...shellInfo.args, '--', 'bash', '-c', claudeCmd];
        env = { ...env, ...claudeConfig.env } as { [key: string]: string };
      } else if (process.platform === 'win32') {
        // On Windows without WSL, run Claude through the shell
        shell = shellInfo.shell;
        if (shellInfo.shell.toLowerCase().includes('powershell')) {
          args = ['-NoLogo', '-Command', claudeCmd];
        } else if (shellInfo.shell.toLowerCase().includes('cmd')) {
          args = ['/c', claudeCmd];
        } else {
          // Assume bash-like shell (Git Bash, etc.)
          args = ['-c', claudeCmd];
        }
        env = { ...env, ...claudeConfig.env } as { [key: string]: string };
      } else {
        // macOS/Linux: run Claude through interactive login shell
        shell = shellInfo.shell;
        args = ['-l', '-i', '-c', claudeCmd];
        env = { ...env, ...claudeConfig.env } as { [key: string]: string };
      }
```

**Step 3: Remove fallback injection timeout**

Delete lines 169-178 (the setTimeout fallback):
```typescript
      // Memory injection happens in detectClaudeState when Claude becomes idle,
      // but add a time-based fallback in case state detection doesn't trigger
      setTimeout(() => {
        const sess = this.sessions.get(id);
        if (sess && !sess.memoryInjected) {
          console.log(`[Memory] Fallback injection for session ${id}`);
          this.injectMemories(id);
        }
      }, 6000);  // 6 second fallback
```

Keep only the `writeMemoryFile` call for reference file.

**Step 4: Run TypeScript compiler to verify no errors**

Run: `npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/main/pty-manager.ts
git commit -m "feat(pty): pass memory content via --append-system-prompt flag"
```

---

### Task 4: Remove Injection-Related Code from PTY Manager

**Files:**
- Modify: `src/main/pty-manager.ts`

**Step 1: Remove injection tracking fields from PtySession interface**

In the `PtySession` interface (lines 9-27), remove these fields:
- `memoryInjected: boolean;` (line 23)
- `hasSeenWorking: boolean;` (line 24)
- `lastCompactTime: number;` (line 25)
- `compactReinjectionTimeout: NodeJS.Timeout | null;` (line 26)

**Step 2: Remove injectMemories method**

Delete the entire `injectMemories` method (lines 248-278).

**Step 3: Remove compactReinjectionTimeout cleanup from kill()**

In the `kill()` method, remove lines 224-226:
```typescript
      if (session.compactReinjectionTimeout) {
        clearTimeout(session.compactReinjectionTimeout);
      }
```

**Step 4: Remove injection field initializations from createSession()**

In the session object creation (lines 180-198), remove:
- `memoryInjected: false,`
- `hasSeenWorking: false,`
- `lastCompactTime: 0,`
- `compactReinjectionTimeout: null,`

**Step 5: Remove compacting detection and re-injection logic from detectClaudeState()**

Delete lines 350-386 (compacting detection):
```typescript
    // Detect conversation compacting/summarization
    // Claude Code outputs messages like "Auto-compacting conversation..." when context gets long
    const compactingPatterns = [
      /auto[- ]?compact/i,
      ...
    ];
    ... (entire compacting block)
```

**Step 6: Remove memory injection calls from state detection**

In `detectClaudeState()`, remove these injection calls (3 locations):

Location 1 (around line 301-304):
```typescript
          // Inject memories when Claude first becomes idle after starting
          if (sess.hasSeenWorking && !sess.memoryInjected) {
            this.injectMemories(id);
          }
```

Location 2 (around line 476-479):
```typescript
                  // Inject memories when Claude first becomes idle after starting
                  if (sess.hasSeenWorking && !sess.memoryInjected) {
                    this.injectMemories(id);
                  }
```

Location 3 (around line 513-516):
```typescript
          // Inject memories when Claude first becomes idle after starting
          if (currentSession.hasSeenWorking && !currentSession.memoryInjected) {
            this.injectMemories(id);
          }
```

**Step 7: Remove hasSeenWorking assignment**

In `detectClaudeState()`, remove line 454:
```typescript
            currentSession.hasSeenWorking = true;  // Mark that Claude has started
```

**Step 8: Run TypeScript compiler to verify no errors**

Run: `npm run build`
Expected: Build succeeds

**Step 9: Commit**

```bash
git add src/main/pty-manager.ts
git commit -m "refactor(pty): remove PTY injection logic, use system prompt only"
```

---

### Task 5: Manual Testing

**Step 1: Start ClaudeLander and create a new session with a memory group**

1. Run the app: `npm start`
2. Create or select a memory group
3. Start a new Claude session

**Step 2: Verify memory context appears**

- Check that Claude's first response acknowledges the session context
- Verify no duplicate memory injection messages appear
- Verify the `<session-memories>` content is being used

**Step 3: Test auto-compact scenario**

- Have a long conversation that triggers auto-compact
- Verify no duplicate injection after compacting

**Step 4: Test empty memories case**

- Create session with a new empty memory group
- Verify Claude still knows the group_id for saving new memories

---

### Task 6: Final Commit

**Step 1: Review all changes**

Run: `git diff main`

**Step 2: Verify build and no lint errors**

Run: `npm run build && npm run lint`
Expected: Both pass

**Step 3: Create final summary commit if needed**

If any cleanup needed, commit with appropriate message.
