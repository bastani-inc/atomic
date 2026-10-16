import { SessionManager } from "@bastani/atomic";

type SubagentExecutionContext = "fresh" | "fork";
type ForkableSessionManager = Pick<SessionManager, "getSessionId" | "getSessionStore" | "getLeafId" | "getCwd">;

export class SubagentForkContextError extends Error {
	constructor(
		readonly parentSessionId: string,
		readonly reason: "no_leaf" | "fork_failed",
		options?: ErrorOptions,
	) {
		super(`Cannot fork subagent session ${JSON.stringify(parentSessionId)}: ${reason}`, options);
		this.name = "SubagentForkContextError";
	}
}

export function resolveSubagentContext(value: string | undefined): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: string | undefined,
) {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return { sessionManagerForIndex: async (): Promise<SessionManager | undefined> => undefined };
	}
	const parentSessionId = sessionManager.getSessionId();
	const store = sessionManager.getSessionStore();
	const cwd = sessionManager.getCwd();
	const leafId = sessionManager.getLeafId();
	if (leafId === null) throw new SubagentForkContextError(parentSessionId, "no_leaf");
	const children = new Map<number, Promise<SessionManager>>();
	return {
		sessionManagerForIndex(index = 0): Promise<SessionManager> {
			const cached = children.get(index);
			if (cached !== undefined) return cached;
			const child = (async () => {
				try {
					const source = await SessionManager.open(store, parentSessionId, cwd);
					await source.createBranchedSession(leafId);
					return source;
				} catch (cause) {
					children.delete(index);
					throw new SubagentForkContextError(parentSessionId, "fork_failed", { cause });
				}
			})();
			children.set(index, child);
			return child;
		},
	};
}
