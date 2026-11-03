import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

/** The Copilot host for individual accounts, and the default when nothing names another. */
export const GITHUB_COPILOT_INDIVIDUAL_BASE_URL = "https://api.individual.githubcopilot.com";

/** The model IDs a login saves from the account's `GET /models` list. */
export interface GitHubCopilotAccountModelLists {
	/** Models the account offers in its model picker. */
	availableModelIds: string[];
	/** Fast IDs the account lists; they are not picker entries. */
	fastModelIds: string[];
	/** Built-in models whose policy the account has not configured yet, which a login enables. */
	policyModelIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Read the model lists a login saves, and its availability filter checks, from a `GET /models`
 * response of the host at `baseUrl`. A login and a catalog refresh both use these rules, so either
 * read of the account's list leaves the same lists.
 */
export function parseGitHubCopilotAccountModelLists(raw: unknown, baseUrl: string): GitHubCopilotAccountModelLists {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot models response");
	}

	// Some Individual accounts return false for every picker flag despite explicit enabled policies.
	// Limit the fallback to that endpoint so other account types keep strict picker semantics.
	const allowPolicyFallback = baseUrl === GITHUB_COPILOT_INDIVIDUAL_BASE_URL;
	const accountModels = data.flatMap((rawItem) => {
		const item = asRecord(rawItem);
		const id = item?.id;
		if (!item || typeof id !== "string") return [];

		const capabilities = asRecord(item.capabilities);
		const supports = asRecord(capabilities?.supports);
		if (supports?.tool_calls === false) return [];

		return [
			{
				id,
				pickerEnabled: item.model_picker_enabled === true,
				policyState: asRecord(item.policy)?.state,
			},
		];
	});
	const pickerModelIds = accountModels
		.filter((model) => model.pickerEnabled && model.policyState !== "disabled")
		.map((model) => model.id);
	const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
	const availableModelIds =
		pickerModelIds.length > 0 || !allowPolicyFallback
			? pickerModelIds
			: accountModels
					.filter((model) => !model.id.endsWith("-fast") && model.policyState === "enabled")
					.map((model) => model.id);
	// Fast siblings are not picker entries: a fast ID the account lists is entitled unless its policy is disabled.
	const fastModelIds = accountModels
		.filter((model) => model.id.endsWith("-fast") && model.policyState !== "disabled")
		.map((model) => model.id);
	const policyModelIds = accountModels
		.filter(
			(model) =>
				model.policyState === "unconfigured" &&
				Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) &&
				(model.pickerEnabled || usePolicyFallback),
		)
		.map((model) => model.id);
	return { availableModelIds, fastModelIds, policyModelIds };
}
