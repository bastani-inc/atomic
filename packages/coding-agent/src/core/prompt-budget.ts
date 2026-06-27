/**
 * Airlock refusal for the `prompt` door.
 *
 * Thrown when a single user message's estimated token cost exceeds the model's
 * liveness budget (`getEffectiveInputBudget(model) - reserveTokens`). Such a
 * message could never be made to fit the model's input budget by compaction
 * (user messages are protected and un-truncated), so it is refused at submission
 * before it enters agent state — making the un-compactable-message pathology
 * structurally impossible.
 *
 * See `specs/2026-06-27-context-compaction-graduated-protection.md` §5.4.
 */

export interface PromptExceedsBudgetErrorMetadata {
	estimatedTokens: number;
	budgetTokens: number;
	modelId: string;
}

export function formatPromptExceedsBudgetMessage(metadata: PromptExceedsBudgetErrorMetadata): string {
	const { estimatedTokens, budgetTokens, modelId } = metadata;
	const over = estimatedTokens - budgetTokens;
	return (
		`This message is too large for the selected model. ` +
		`Estimated ${estimatedTokens} tokens exceed the ${budgetTokens}-token input budget for "${modelId}" by ~${over} tokens. ` +
		`Shorten or split the input, remove large attachments, or switch to a larger-context model.`
	);
}

export class PromptExceedsBudgetError extends Error {
	readonly estimatedTokens: number;
	readonly budgetTokens: number;
	readonly modelId: string;

	constructor(metadata: PromptExceedsBudgetErrorMetadata) {
		super(formatPromptExceedsBudgetMessage(metadata));
		this.name = "PromptExceedsBudgetError";
		this.estimatedTokens = metadata.estimatedTokens;
		this.budgetTokens = metadata.budgetTokens;
		this.modelId = metadata.modelId;
	}
}
