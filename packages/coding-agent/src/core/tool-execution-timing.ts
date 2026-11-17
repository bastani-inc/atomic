const startedAtBySession = new WeakMap<object, Map<string, number>>();

interface ToolTimingEvent {
	readonly type: string;
	readonly toolCallId?: unknown;
	readonly parentToolCallId?: unknown;
}

export function observeToolExecutionTiming(session: object, event: ToolTimingEvent): void {
	if (event.type === "agent_end") {
		startedAtBySession.delete(session);
		return;
	}
	if (typeof event.toolCallId !== "string" || typeof event.parentToolCallId === "string") return;
	if (event.type === "tool_execution_start") {
		let starts = startedAtBySession.get(session);
		if (starts === undefined) {
			starts = new Map();
			startedAtBySession.set(session, starts);
		}
		if (!starts.has(event.toolCallId)) starts.set(event.toolCallId, Date.now());
	} else if (event.type === "tool_execution_end") {
		const starts = startedAtBySession.get(session);
		starts?.delete(event.toolCallId);
		if (starts?.size === 0) startedAtBySession.delete(session);
	}
}

export function getToolExecutionStartedAt(session: object, toolCallId: string): number | undefined {
	return startedAtBySession.get(session)?.get(toolCallId);
}

export interface ToolExecutionStart {
	readonly toolCallId: string;
	readonly startedAt: number;
}

export function activeToolExecutionStarts(session: object): readonly ToolExecutionStart[] {
	const starts = startedAtBySession.get(session);
	return starts === undefined ? [] : [...starts].map(([toolCallId, startedAt]) => ({ toolCallId, startedAt }));
}
