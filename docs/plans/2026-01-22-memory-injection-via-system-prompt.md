# Memory Injection via System Prompt

## Problem

The current PTY-based memory injection has timing issues:
- Duplicate injections appearing in conversations
- Complex state detection logic (idle/working/waiting)
- Race conditions between Claude startup and injection timing
- Compacting re-injection causing repeated memory group messages

## Solution

Replace PTY injection with `--append-system-prompt` CLI flag. Memory context is passed at launch time, eliminating timing complexity.

## Changes

### 1. Launch Changes (`pty-manager.ts`)

**Current flow:**
```
spawn shell → write "claude\r" → wait for idle → inject via PTY write
```

**New flow:**
```
get memory content → spawn shell → write "claude --append-system-prompt \"<content>\"\r"
```

- Call `getMemoryInjectionContent()` before spawning
- Pass content as CLI argument
- No post-spawn injection needed

### 2. Code Removal (`pty-manager.ts`)

Remove ~150 lines of timing-sensitive code:
- `injectMemories()` function
- State detection for injection (`hasSeenWorking`, `memoryInjected` flags)
- 6-second fallback timeout
- Compacting re-injection logic
- `outputBuffer` accumulation for injection purposes

Keep:
- State detection for UI status display
- PTY management (resize, write, cleanup)

### 3. Injector Format Changes (`injector.ts`)

**Current format** (single-line for PTY):
```
[Memory Group: <id>] Please remember: memory1; memory2... Acknowledge briefly.
```

**New format** (multi-line for system prompt):
```
<session-memories>
You have saved memories from previous sessions in this workspace:
- Memory content here
- Another memory [PINNED]

To save new memories, use the MCP tool with group_id: <id>
</session-memories>
```

Changes:
- Multi-line bullet list format
- XML tags for clear delineation
- Remove "Acknowledge briefly" instruction
- Empty case returns empty string (skip flag entirely)
- Keep 8KB limit

### 4. Edge Cases

**Compacting:** System prompt persists through auto-compact. No re-injection needed.

**Empty memories:** Don't pass `--append-system-prompt` at all.

**Shell escaping:** Write content to temp file, use `$(cat /tmp/file)` approach for safety with special characters.

**Memory file:** Keep writing `.claudelander-memory.md` for reference/debugging.

## Files Changed

| File | Changes |
|------|---------|
| `src/main/pty-manager.ts` | Remove injection logic, pass `--append-system-prompt` on spawn |
| `src/main/memory/injector.ts` | New format for system prompt, handle escaping |

## Testing

1. Start session with memories - verify context available
2. Start session without memories - verify no flag passed
3. Trigger auto-compact - verify no duplicate injection
4. Test special characters in memories - verify escaping works
