import type { ExtensionContext } from "@bastani/atomic";
import { findSubagentControl } from "../inprocess/control-registry.js";
import type { SubagentControlRuntime } from "../inprocess/runner.js";

/**
 * Runs a session without a task host (an SDK session) launched directly, by session id, while they run. No child
 * record is saved for them, so `quit` finds them here and stops their children through the in-process control plane.
 */
const ownerlessRuns = new Map<string, Map<string, number>>();

/** The session whose ownerless runs a context launches and controls; a context with no session shares one key. */
export function ownerlessSessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return ctx.sessionManager?.getSessionId() ?? "";
}

/** Track a run launched without a task host while it runs, so `quit` can reach its children. */
export async function trackOwnerlessRun<T>(
	ctx: Pick<ExtensionContext, "sessionManager">,
	runId: string,
	run: () => Promise<T>,
): Promise<T> {
	const sessionId = ownerlessSessionKey(ctx);
	const runs = ownerlessRuns.get(sessionId) ?? new Map<string, number>();
	ownerlessRuns.set(sessionId, runs);
	runs.set(runId, (runs.get(runId) ?? 0) + 1);
	try {
		return await run();
	} finally {
		const remaining = (runs.get(runId) ?? 1) - 1;
		if (remaining > 0) runs.set(runId, remaining);
		else runs.delete(runId);
		if (runs.size === 0 && ownerlessRuns.get(sessionId) === runs) ownerlessRuns.delete(sessionId);
	}
}

export interface OwnerlessChild {
	readonly runId: string;
	/** Its position among the run's children, in launch order. */
	readonly index: number;
	readonly path: string;
	readonly agent: string;
	readonly control: SubagentControlRuntime;
}

/** Running children of the session's ownerless runs: all of them, or those of run `id`, or the child at path `id`. */
export function ownerlessChildren(sessionId: string, id?: string): OwnerlessChild[] {
	const children: OwnerlessChild[] = [];
	for (const runId of ownerlessRuns.get(sessionId)?.keys() ?? []) {
		const control = findSubagentControl(runId);
		if (!control || control.parent.path !== runId) continue;
		for (const [index, child] of control.listChildren().entries()) {
			if (child.status !== "running") continue;
			if (id === undefined || id === runId || id === child.path)
				children.push({ runId, index, path: child.path, agent: child.taskName, control });
		}
	}
	return children;
}
