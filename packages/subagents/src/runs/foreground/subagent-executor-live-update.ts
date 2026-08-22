import type { SubagentToolResult } from "../../shared/types.js";

const liveResultIndices = new WeakMap<SubagentToolResult, readonly number[]>();

export function markLiveResultIndices(result: SubagentToolResult, indices: readonly number[]): void {
	liveResultIndices.set(result, indices);
}

export function getLiveResultIndices(result: SubagentToolResult): readonly number[] | undefined {
	return liveResultIndices.get(result);
}
