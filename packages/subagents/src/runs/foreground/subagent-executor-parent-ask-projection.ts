import type { ForegroundParentAskPause, SubagentToolResult } from "../../shared/types.js";

const parentAskPauses = new WeakMap<SubagentToolResult, ForegroundParentAskPause>();

export function markParentAskPause(result: SubagentToolResult, pause: ForegroundParentAskPause): void {
	parentAskPauses.set(result, pause);
}

export function getParentAskPause(result: SubagentToolResult): ForegroundParentAskPause | undefined {
	return parentAskPauses.get(result);
}
