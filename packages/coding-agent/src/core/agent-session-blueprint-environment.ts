import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { sessionEnvironmentPrefix } from "./resume/blueprint/envrc.ts";
import { restoredWorktreeOf } from "./resume/blueprint/resume.ts";
import { currentWorktreeRootMappings } from "./resume/path-mapping.ts";
import { resumeStoreDir } from "./resume/session-resume.ts";
import { mapRestoredPath } from "./session-worktree-snapshots.ts";

/**
 * The bash prefix that gives the session's shell the variables the blueprint builds of its restored worktrees wrote to
 * `$ENVRC` (#4588); undefined when the session has no such worktree or no agent directory to look in. A stage of a resumed workflow run and a pooled child have
 * no restores of their own on their session: theirs come from the run, or from the restored worktree they run in.
 */
export function blueprintEnvironmentPrefix(session: AgentSession): string | undefined {
	const agentDir = session._storageAgentDir;
	if (agentDir === undefined) return undefined;
	const storeDir = resumeStoreDir(agentDir);
	const mappings = [...session.sessionManager.getWorktreeRootMappings(), ...currentWorktreeRootMappings()];
	const roots = mappings.map((mapping) => mapping.to);
	const own = restoredWorktreeOf(storeDir, mapRestoredPath(session.sessionManager.getCwd(), mappings));
	return sessionEnvironmentPrefix(storeDir, own === undefined ? roots : [...roots, own]);
}

/** `prefix`, the user's `shellCommandPrefix`, and the blueprint environment prefix, joined as one bash prefix. */
export function shellCommandPrefixFor(session: AgentSession, userPrefix: string | undefined): string | undefined {
	const joined = [userPrefix, blueprintEnvironmentPrefix(session)]
		.filter((part): part is string => part !== undefined && part !== "")
		.join("\n");
	return joined === "" ? undefined : joined;
}
