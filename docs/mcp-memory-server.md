# ClaudeLander Memory MCP Server

The ClaudeLander Memory MCP Server gives Claude Code direct access to search, add, and manage memories stored in ClaudeLander's database. This enables Claude to use memories as long-term knowledge that persists across sessions.

## Available Tools

| Tool | Description |
|------|-------------|
| `search_memories` | Search for memories by keyword or phrase |
| `add_memory` | Store a new memory (decision, error fix, pattern, context, or note) |
| `list_memories` | List recent memories, optionally filtered by group or type |
| `delete_memory` | Delete a memory by ID |
| `pin_memory` | Pin or unpin a memory (pinned memories appear first) |
| `list_groups` | List available memory groups |

## Configuration

### Option 1: Using the built-in binary (after npm install)

If you've cloned and built ClaudeLander, the MCP server is available at:
```
./dist/mcp-server/index.js
```

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "claudelander-memory": {
      "command": "node",
      "args": ["D:/Projects/claudelander/dist/mcp-server/index.js"]
    }
  }
}
```

### Option 2: Global installation

```bash
# From the ClaudeLander directory
npm link

# Or install globally when published
npm install -g claudelander
```

Then configure Claude Code:

```json
{
  "mcpServers": {
    "claudelander-memory": {
      "command": "claudelander-memory-server"
    }
  }
}
```

### Option 3: Custom database path

Set the `CLAUDELANDER_DB` environment variable to specify a custom database location:

```json
{
  "mcpServers": {
    "claudelander-memory": {
      "command": "node",
      "args": ["D:/Projects/claudelander/dist/mcp-server/index.js"],
      "env": {
        "CLAUDELANDER_DB": "C:/path/to/your/claudelander.db"
      }
    }
  }
}
```

## Database Locations

The MCP server automatically searches for the ClaudeLander database in these locations:

- **Windows**: `%APPDATA%/claudelander/claudelander.db`
- **macOS**: `~/Library/Application Support/claudelander/claudelander.db`
- **Linux**: `~/.config/claudelander/claudelander.db`

## Usage Examples

Once configured, Claude can use the memory tools:

```
Claude, search my memories for "authentication"
```

```
Claude, remember this: Use React Query for data fetching in this project
```

```
Claude, list all my pinned memories
```

## Memory Types

- **decision** - Architectural or design decisions
- **error_fix** - Solutions to errors encountered
- **pattern** - Coding patterns or conventions
- **context** - Important project context
- **note** - General notes

## Prerequisites

- ClaudeLander must have been run at least once to create the database
- At least one group must exist in ClaudeLander to store memories
