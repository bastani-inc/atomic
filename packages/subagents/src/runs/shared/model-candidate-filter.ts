import type { SkippedModel } from "@bastani/atomic";
import { splitKnownThinkingSuffix } from "../../shared/model-info.js";
import type { CandidateModelResolver } from "../../shared/model-resolution.js";
import type { ModelAttempt } from "../../shared/types.js";
import type { AvailableModelInfo } from "./model-fallback.js";
import { isModelCandidateAllowed, isModelCandidateInCatalog, modelOutsideScopeReason } from "./model-scope.js";

export interface FilteredModelCandidates {
	candidates: string[];
	skippedAttempts: ModelAttempt[];
	skippedModels: SkippedModel[];
}

function providerFromModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	const slash = baseModel.indexOf("/");
	return slash > 0 ? baseModel.slice(0, slash) : undefined;
}

export function skippedModelAttempt(model: string, reason: string): ModelAttempt {
	return {
		model,
		success: false,
		error: reason,
	};
}

export function filterSpawnableModelCandidates(params: {
	candidates: string[];
	availableModels?: AvailableModelInfo[];
	knownModelProviders?: string[];
	currentModel?: string;
	/**
	 * When defined, only candidates matching one of these `provider/id` entries are allowed
	 * (enforcing the session's `enabledModels` / `--models` scope). Leave `undefined` when no
	 * scope is configured.
	 */
	allowedModels?: readonly string[];
	resolveCandidateModel?: CandidateModelResolver;
}): FilteredModelCandidates {
	const providersWithAvailableAuth = new Set((params.availableModels ?? []).map((model) => model.provider));
	const knownProviders = new Set(params.knownModelProviders ?? []);
	const currentModel = params.currentModel;
	const allowedModels = params.allowedModels;
	const filtered: string[] = [];
	const skippedAttempts: ModelAttempt[] = [];
	const skippedModels: SkippedModel[] = [];
	for (const candidate of params.candidates) {
		if (allowedModels !== undefined && !isModelCandidateAllowed(candidate, allowedModels)) {
			const model = params.resolveCandidateModel?.(candidate)?.model;
			const catalog = model ? undefined : params.resolveCandidateModel?.getCatalog?.();
			const reason =
				catalog && !isModelCandidateInCatalog(candidate, catalog)
					? "no such model in the catalog."
					: modelOutsideScopeReason(model, (id) => isModelCandidateAllowed(id, allowedModels));
			skippedAttempts.push(skippedModelAttempt(candidate, `Skipped ${candidate}: ${reason}`));
			continue;
		}
		if (currentModel && candidate === currentModel) {
			filtered.push(candidate);
			continue;
		}
		const provider = providerFromModel(candidate);
		const shouldSkip =
			provider !== undefined && knownProviders.has(provider) && !providersWithAvailableAuth.has(provider);
		if (!shouldSkip) {
			filtered.push(candidate);
			continue;
		}
		skippedAttempts.push(
			skippedModelAttempt(
				candidate,
				`Skipped ${candidate}: provider '${provider}' has no configured API key/auth in the current session.`,
			),
		);
		skippedModels.push({ model: splitKnownThinkingSuffix(candidate).baseModel, provider, reason: "no-credentials" });
	}
	return { candidates: filtered, skippedAttempts, skippedModels };
}
