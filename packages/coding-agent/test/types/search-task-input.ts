import type { SearchToolInput } from "../../src/index.js";

// A search hook can inspect the ordinary fields without first discriminating task waits (#5479).
export function describeSearch(input: SearchToolInput): string | undefined {
	return input.paths ? input.pattern : undefined;
}

// Waits observe only: they cannot also start a search.
// @ts-expect-error a wait cannot include launch fields
export const invalidWait: SearchToolInput = { action: "wait", id: "search-1", pattern: "needle" };
