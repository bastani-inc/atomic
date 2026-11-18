import { createForkedSession, forkPointEntryId, SessionManager } from "@bastani/atomic";
import type { ToolCall } from "@bastani/atomic-ai/compat";

type SubagentExecutionContext = "fresh" | "fork";
type ForkableSessionManager = Pick<
	SessionManager,
	"getSessionId" | "getSessionStore" | "getLeafId" | "getCwd" | "getBranch"
>;

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

/** Which tool call launched a forked child, and the child's place among the children that call launched. */
export interface ForkedChildLaunch {
	/** The `subagent` tool call that launched the child, when a tool call did. */
	readonly toolCallId?: string;
	/** The child's place among that call's children, from 1. */
	readonly ordinal: number;
	/** How many children that call launched. */
	readonly count: number;
}

/** How the children of one launch were launched: the `subagent` calls, and which of them launched each child. */
export interface ForkLaunch {
	/** The `subagent` tool calls of the launch: one, or several a burst of calls in one message merged. */
	readonly toolCallIds?: readonly string[];
	/** The call that launched the child at a task index; defaults to the first call and the child's index. */
	readonly childLaunch?: (index: number) => ForkedChildLaunch;
}

/**
 * How the children of one execution were launched. `taskCallIds` names, for each task of a parallel launch, the
 * `subagent` call it came from when a burst of calls in one message was merged; a task without one, and a single
 * child (`taskCallIds` undefined or empty), came from `toolCallId`. A child's place counts only its own call's children.
 */
export function forkLaunchOfTasks(
	taskCallIds: readonly (string | undefined)[] | undefined,
	toolCallId: string | undefined,
): ForkLaunch {
	const callIds = taskCallIds && taskCallIds.length > 0 ? taskCallIds.map((id) => id ?? toolCallId) : [toolCallId];
	const launches = callIds.map((callId, index): ForkedChildLaunch => {
		const ofCall = (other: string | undefined): boolean => other === callId;
		return {
			...(callId === undefined ? {} : { toolCallId: callId }),
			ordinal: callIds.slice(0, index).filter(ofCall).length + 1,
			count: callIds.filter(ofCall).length,
		};
	});
	return {
		toolCallIds: [...new Set(callIds.filter((id): id is string => id !== undefined))],
		childLaunch: (index) => launches[index] ?? { ordinal: index + 1, count: launches.length },
	};
}

/** The result a forked child's copy of the parent conversation holds for one tool call the parent has in flight. */
export function forkedChildToolCallAnswer(launch: ForkedChildLaunch): (call: ToolCall) => string {
	return (call) => {
		if (call.id === launch.toolCallId) {
			const children = launch.count === 1 ? "one forked subagent" : `${launch.count} forked subagents`;
			return `This call launched ${children}. This session is forked child ${launch.ordinal} of ${launch.count}: it continues the conversation from here, and its task follows.`;
		}
		if (call.name === "subagent")
			return "This call launched other subagents of the parent session, which run alongside this session. Their results go to the parent session and are not available here.";
		return "This call runs in the parent session. Its result goes to the parent session and is not available here.";
	};
}

/**
 * Forks for the children of one launch.
 *
 * Every child starts from the same fork point, captured once here at launch: the parent's conversation up to and
 * including the assistant message that holds the launching `subagent` call, or the parent's leaf when no tool call
 * launched it. The child's session holds that branch unchanged and then answers each tool call of that message once,
 * its own launching call with its place among the children, before its task. A child started later, because it waited
 * for a slot or was retried, branches at the same point, so later parent turns never reach it.
 */
export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: string | undefined,
	launch: ForkLaunch = {},
) {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return { sessionManagerForIndex: async (): Promise<SessionManager | undefined> => undefined };
	}
	const parentSessionId = sessionManager.getSessionId();
	const store = sessionManager.getSessionStore();
	const cwd = sessionManager.getCwd();
	const parentLeafId = sessionManager.getLeafId();
	if (parentLeafId === null) throw new SubagentForkContextError(parentSessionId, "no_leaf");
	const forkEntryId = forkPointEntryId(sessionManager.getBranch(), launch.toolCallIds ?? []) ?? parentLeafId;
	const childLaunch =
		launch.childLaunch ??
		((index: number): ForkedChildLaunch => ({ toolCallId: launch.toolCallIds?.[0], ordinal: index + 1, count: 1 }));
	const children = new Map<number, Promise<SessionManager>>();
	return {
		sessionManagerForIndex(index = 0): Promise<SessionManager> {
			const cached = children.get(index);
			if (cached !== undefined) return cached;
			const child = (async () => {
				try {
					const source = await SessionManager.open(store, parentSessionId, cwd);
					await createForkedSession(source, forkEntryId, forkedChildToolCallAnswer(childLaunch(index)));
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
