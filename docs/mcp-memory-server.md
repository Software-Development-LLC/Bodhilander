# Bodhilander Memory MCP Server

The Bodhilander Memory MCP Server gives Claude Code direct access to search, add, and manage memories stored in Bodhilander's database. This enables Claude to use memories as long-term knowledge that persists across sessions.

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

If you've cloned and built Bodhilander, the MCP server is available at:
```
./dist/mcp-server/index.js
```

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.claude/settings.json`):

```json
{
  "mcpServers": {
    "bodhilander-memory": {
      "command": "node",
      "args": ["D:/Projects/bodhilander/dist/mcp-server/index.js"]
    }
  }
}
```

### Option 2: Global installation

```bash
# From the Bodhilander directory
npm link

# Or install globally when published
npm install -g bodhilander
```

Then configure Claude Code:

```json
{
  "mcpServers": {
    "bodhilander-memory": {
      "command": "bodhilander-memory-server"
    }
  }
}
```

### Option 3: Custom database path

Set the `BODHILANDER_DB` environment variable to specify a custom database location:

```json
{
  "mcpServers": {
    "bodhilander-memory": {
      "command": "node",
      "args": ["D:/Projects/bodhilander/dist/mcp-server/index.js"],
      "env": {
        "BODHILANDER_DB": "C:/path/to/your/bodhilander.db"
      }
    }
  }
}
```

## Database Locations

The MCP server automatically searches for the Bodhilander database in these locations:

- **Windows**: `%APPDATA%/bodhilander/bodhilander.db`
- **macOS**: `~/Library/Application Support/bodhilander/bodhilander.db`
- **Linux**: `~/.config/bodhilander/bodhilander.db`

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

- Bodhilander must have been run at least once to create the database
- At least one group must exist in Bodhilander to store memories
