import { getDefaultSessionDirPath } from "../../session-manager-paths.ts";

export function sessionScratchDir(agentDir: string, cwd: string, _sessionId: string): string {
	return getDefaultSessionDirPath(cwd, agentDir);
}
