import { SessionManager } from "@bastani/atomic";

type SubagentExecutionContext = "fresh" | "fork";
type ForkableSessionManager = Pick<
	SessionManager,
	"getSessionId" | "getSessionStore" | "getLeafId" | "getCwd" | "getBranch" | "captureFork"
>;
type BranchEntry = ReturnType<SessionManager["getBranch"]>[number];

/**
 * The entry a subagent fork appends right after the parent history it copied, naming its own session: on a reopen,
 * what comes after it is the child's own.
 */
const SUBAGENT_FORK_START_TYPE = "subagent-fork-start";

/** Where the parent history copied into session `sessionId` ends on `branch`, or -1 when no fork start of its own says. */
export function subagentForkStartIndex(branch: readonly BranchEntry[], sessionId: string): number {
	return branch.findLastIndex(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === SUBAGENT_FORK_START_TYPE &&
			(entry.data as { readonly sessionId?: string } | undefined)?.sessionId === sessionId,
	);
}

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

/**
 * The entry a fork branches at: the parent's leaf, minus the parent's own in-flight turn.
 *
 * While the `subagent` tool runs, the parent's newest assistant entry is the turn that
 * issued the call, and its tool calls have no results yet. Replaying that turn would
 * hand the child someone else's unanswered tool call, and the child's projection strips
 * parent-only `subagent` calls from it. A stripped copy of the latest assistant turn is
 * a modified turn, which providers that sign thinking reject outright (#3987). The turn
 * is still being produced, so the fork starts at the last settled entry before it.
 */
function settledForkLeaf(branch: readonly BranchEntry[], leafId: string): string | null {
	const answered = new Set<string>();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		// A user turn after it means that assistant turn is history, not the one running now.
		if (message.role === "user") return leafId;
		if (message.role !== "assistant") continue;
		const inFlight = message.content.some((block) => block.type === "toolCall" && !answered.has(block.id));
		return inFlight ? entry.parentId : leafId;
	}
	return leafId;
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
	const parentLeafId = sessionManager.getLeafId();
	if (parentLeafId === null) throw new SubagentForkContextError(parentSessionId, "no_leaf");
	const leafId = settledForkLeaf(sessionManager.getBranch(), parentLeafId);
	if (leafId === null) throw new SubagentForkContextError(parentSessionId, "no_leaf");
	const openFork = sessionManager.captureFork(leafId);
	const children = new Map<number, { id: string; manager: WeakRef<SessionManager> }>();
	const opening = new Map<number, Promise<SessionManager>>();
	return {
		sessionManagerForIndex(index = 0): Promise<SessionManager> {
			const pending = opening.get(index);
			if (pending) return pending;
			const saved = children.get(index);
			const live = saved?.manager.deref();
			if (live) return Promise.resolve(live);
			const child = (async () => {
				try {
					const manager = saved ? await SessionManager.open(store, saved.id, cwd) : await openFork();
					if (!saved) {
						await manager.appendCustomEntry(SUBAGENT_FORK_START_TYPE, { sessionId: manager.getSessionId() });
					}
					children.set(index, { id: manager.getSessionId(), manager: new WeakRef(manager) });
					return manager;
				} catch (cause) {
					throw new SubagentForkContextError(parentSessionId, "fork_failed", { cause });
				}
			})();
			opening.set(index, child);
			void child.then(
				() => opening.delete(index),
				() => opening.delete(index),
			);
			return child;
		},
	};
}
