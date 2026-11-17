import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import type { PiArgumentCompletion, PiArgumentCompletionResult } from "./public-types.js";

export function completeToken(argumentText: string, candidates: PiArgumentCompletion[]): PiArgumentCompletionResult {
	const tokenStart = /\s$/.test(argumentText)
		? argumentText.length
		: Math.max(argumentText.lastIndexOf(" "), argumentText.lastIndexOf("\t")) + 1;
	const head = argumentText.slice(0, tokenStart);
	const token = argumentText.slice(tokenStart);
	const normalizedToken = token.trimEnd();
	const filtered = candidates
		.filter((candidate) => candidate.value.startsWith(token) && candidate.value.trimEnd() !== normalizedToken)
		.map((candidate) => ({ ...candidate, value: `${head}${candidate.value}` }));
	return filtered.length > 0 ? filtered : null;
}

export function runIdItems(activeStore: Store): PiArgumentCompletion[] {
	return topLevelWorkflowRuns(activeStore.runs()).map((run) => ({
		value: `${run.id} `,
		label: run.id,
		description: `${run.name} — ${run.status}`,
	}));
}
