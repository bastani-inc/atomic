import { visibleRunTreeMembers } from "../shared/run-indicator-status.js";
import type { PendingPrompt, RunSnapshot } from "../shared/store-types.js";

/**
 * One safe, displayable pending-input request attributed to a visible run.
 * The identity retains the concrete owner even when the owner is a hidden
 * nested run, while `visibleRunId` remains the command target users can open.
 */
export interface PendingInputAffordance {
	/** Concrete ownership tuple: owner run, stage (or null), and prompt id. */
	readonly identity: readonly [ownerRunId: string, stageId: string | null, promptId: string];
	/** Visible top-level run targeted by `/workflow connect`. */
	readonly visibleRunId: string;
	/** Whitespace-normalized, non-empty single-line prompt text. */
	readonly message: string;
}

interface PendingInputOccurrence {
	readonly identity: readonly [ownerRunId: string, stageId: string | null, promptId: string];
	readonly message: string;
	readonly displayable: boolean;
}

function normalizePromptMessage(message: string): string {
	return message.trim().replace(/\s+/g, " ");
}

function runPromptOccurrence(run: RunSnapshot, prompt: PendingPrompt): PendingInputOccurrence {
	const message = normalizePromptMessage(prompt.message);
	return {
		identity: [run.id, null, prompt.id],
		message,
		displayable: message.length > 0,
	};
}

function stagePromptOccurrences(run: RunSnapshot): PendingInputOccurrence[] {
	const occurrences: PendingInputOccurrence[] = [];

	for (const stage of run.stages) {
		const prompt = stage.pendingPrompt;
		if (prompt !== undefined) {
			const message = normalizePromptMessage(prompt.message);
			occurrences.push({
				identity: [run.id, stage.id, prompt.id],
				message,
				displayable: message.length > 0,
			});
			continue;
		}

		const request = stage.inputRequest;
		if (request === undefined) continue;

		// A multi-question request is still a pending occurrence, but it is not
		// safe to choose one question for a one-line affordance. Keeping it in
		// the count also prevents another prompt from looking unambiguous.
		const question = request.questions.length === 1 ? request.questions[0]?.question : undefined;
		const message = question === undefined ? "" : normalizePromptMessage(question);
		occurrences.push({
			identity: [run.id, stage.id, request.id],
			message,
			displayable: request.questions.length === 1 && message.length > 0,
		});
	}

	return occurrences;
}

function pendingInputOccurrences(run: RunSnapshot): PendingInputOccurrence[] {
	const occurrences = run.pendingPrompt === undefined ? [] : [runPromptOccurrence(run, run.pendingPrompt)];
	return occurrences.concat(stagePromptOccurrences(run));
}

/**
 * Derive one safe prompt affordance for a visible run tree.
 *
 * Promptless awaiting markers do not count. Descriptor-bearing prompts do
 * count even when their message is empty or their structured request has
 * multiple questions, which deliberately falls back to the status-only row.
 */
export function pendingInputAffordance(
	visibleRun: RunSnapshot,
	allRuns: readonly RunSnapshot[],
): PendingInputAffordance | undefined {
	const occurrences = visibleRunTreeMembers(visibleRun, allRuns).flatMap((ownerRun) =>
		pendingInputOccurrences(ownerRun),
	);
	if (occurrences.length !== 1) return undefined;

	const [occurrence] = occurrences;
	if (occurrence === undefined || !occurrence.displayable) return undefined;

	return {
		identity: occurrence.identity,
		visibleRunId: visibleRun.id,
		message: occurrence.message,
	};
}
