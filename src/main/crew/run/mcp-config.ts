/** The crew.json servers: the approve broker and the Crew tools, both the relay script under Electron's node. */
import { PERMISSION_PROMPT_TOOL } from './env';

export const APPROVE_SERVER = 'crew_approve';
export const TOOLS_SERVER = 'crew_tools';

export interface RelayLaunch {
  execPath: string;
  script: string;
  socket: string;
  token: string;
}

export function crewMcpServers(launch: RelayLaunch): Record<string, unknown> {
  const env = { ELECTRON_RUN_AS_NODE: '1', CREW_MCP_SOCKET: launch.socket, CREW_MCP_TOKEN: launch.token };
  const server = (name: 'approve' | 'tools') => ({ command: launch.execPath, args: [launch.script, name], env });
  return { [APPROVE_SERVER]: server('approve'), [TOOLS_SERVER]: server('tools') };
}

export const approveToolMatches = (): boolean => PERMISSION_PROMPT_TOOL === `mcp__${APPROVE_SERVER}__approve`;
