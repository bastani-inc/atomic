import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { sessionEnvironmentPrefix } from "./resume/blueprint/envrc.ts";
import { restoredWorktreeOf } from "./resume/blueprint/resume.ts";
import { currentWorktreeRootMappings } from "./resume/path-mapping.ts";
import { resumeStoreDir } from "./resume/session-resume.ts";
import { mapRestoredPathAsync } from "./session-worktree-snapshots.ts";

/**
 * The bash prefix that gives the session's shell the variables the blueprint builds of its restored worktrees wrote to
 * `$ENVRC` (#4588); undefined when the session has no such worktree or no agent directory to look in.
 */
export async function blueprintEnvironmentPrefix(session: AgentSession): Promise<string | undefined> {
	const agentDir = session._storageAgentDir;
	if (agentDir === undefined) return undefined;
	const storeDir = resumeStoreDir(agentDir);
	const mappings = [...session.sessionManager.getWorktreeRootMappings(), ...currentWorktreeRootMappings()];
	const roots = mappings.map((mapping) => mapping.to);
	const own = restoredWorktreeOf(storeDir, await mapRestoredPathAsync(session.sessionManager.getCwd(), mappings));
	return sessionEnvironmentPrefix(storeDir, own === undefined ? roots : [...roots, own]);
}

/** `prefix`, the user's `shellCommandPrefix`, and the blueprint environment prefix, joined as one bash prefix. */
export async function shellCommandPrefixFor(
	session: AgentSession,
	userPrefix: string | undefined,
): Promise<string | undefined> {
	const joined = [userPrefix, await blueprintEnvironmentPrefix(session)]
		.filter((part): part is string => part !== undefined && part !== "")
		.join("\n");
	return joined === "" ? undefined : joined;
}
