import * as path from "node:path";
import { getAgentDir } from "./utils.js";

const SUBAGENT_SESSIONS_DIR = "subagent-sessions";

/**
 * Where the child sessions of a parent are kept. A parent with a session file keeps them beside it. A parent without
 * one (the default database-backed store) keeps them under the agent directory, in a directory named for the parent
 * session, so a resumed parent finds them again: a temporary directory does not survive a reboot (#4660).
 */
export function subagentSessionRoot(parentSessionFile: string | null, parentSessionId: string): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return path.join(getAgentDir(), SUBAGENT_SESSIONS_DIR, parentSessionId.replace(/[^\w.-]/g, "_"));
}
