/** The crew.json servers: the approve broker and the Crew tools, both the relay script under Electron's node. */
import { PERMISSION_PROMPT_TOOL } from './env';

export const APPROVE_SERVER = 'crew_approve';
export const TOOLS_SERVER = 'crew_tools';

export interface RelayLaunch {
  execPath: string;
  script: string;
  socket: string;
  /** A 0600 file in the run dir holding the MCP token; the relay reads it on descriptor 3. */
  tokenFile: string;
}

/** Drops the run's tokens from the env, then opens the token file as descriptor 3 for the relay. */
const RELAY_EXEC = 'unset CREW_GH_TOKEN CREW_MCP_TOKEN; exec "$0" "$1" "$2" 3<"$3"';

export function crewMcpServers(launch: RelayLaunch): Record<string, unknown> {
  const env = { ELECTRON_RUN_AS_NODE: '1', CREW_MCP_SOCKET: launch.socket };
  const server = (name: 'approve' | 'tools') => ({ command: '/bin/sh', args: ['-c', RELAY_EXEC, launch.execPath, launch.script, name, launch.tokenFile], env });
  return { [APPROVE_SERVER]: server('approve'), [TOOLS_SERVER]: server('tools') };
}

export const approveToolMatches = (): boolean => PERMISSION_PROMPT_TOOL === `mcp__${APPROVE_SERVER}__approve`;
