import type { ForegroundParentAskHandoff, SubagentToolResult } from "../../shared/types.js";

const parentAskHandoffs = new WeakMap<SubagentToolResult, ForegroundParentAskHandoff>();

export function markParentAskHandoff(result: SubagentToolResult, handoff: ForegroundParentAskHandoff): void {
	parentAskHandoffs.set(result, handoff);
}

export function getParentAskHandoff(result: SubagentToolResult): ForegroundParentAskHandoff | undefined {
	return parentAskHandoffs.get(result);
}
