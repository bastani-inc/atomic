import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import chalk from "chalk";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { resolveCliModel } from "./model-resolver-cli.ts";
import { findPreferredAvailableModel } from "./model-resolver-defaults.ts";
import { buildFallbackModel } from "./model-resolver-patterns.ts";
import type { InitialModelResult, ScopedModel } from "./model-resolver-types.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const CONFIGURED_DEFAULT_MODEL_UNAVAILABLE_MESSAGE =
	"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";

async function buildConfiguredProviderFallbackModel(
	provider: string,
	modelId: string,
	modelRuntime: ModelRuntime,
): Promise<Model<Api> | undefined> {
	return buildFallbackModel(provider, modelId, await [...modelRuntime.getAvailableSnapshot()]);
}

/**
 * Resolve a model reference persisted in a session. Exact unauthenticated
 * models are authoritative failures; only an absent id may be reconstructed
 * from an authenticated model for the same dynamic/custom provider.
 */
export async function resolveRestoredModelReference(
	provider: string,
	modelId: string,
	modelRuntime: ModelRuntime,
): Promise<Model<Api> | undefined> {
	const found = modelRuntime.getModel(provider, modelId);
	if (found) return modelRuntime.hasConfiguredAuth(found.provider) ? found : undefined;
	if (!modelRuntime.canRestoreUnknownModel(provider)) return undefined;
	return buildConfiguredProviderFallbackModel(provider, modelId, modelRuntime);
}

/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelRuntime,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRuntime,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return {
				model: resolved.model,
				thinkingLevel: DEFAULT_THINKING_LEVEL,
				fallbackMessage: undefined,
			};
		}
	}

	if (scopedModels.length > 0 && !isContinuing) {
		return {
			model: scopedModels[0].model,
			thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
		if (!modelRuntime.getProvider(defaultProvider)) {
			return {
				model: undefined,
				thinkingLevel: DEFAULT_THINKING_LEVEL,
				fallbackMessage: CONFIGURED_DEFAULT_MODEL_UNAVAILABLE_MESSAGE,
				fallbackReason: "configured-provider-unsupported",
			};
		}
	}

	const availableModels = await [...modelRuntime.getAvailableSnapshot()];
	if (availableModels.length > 0) {
		return {
			model: findPreferredAvailableModel(availableModels),
			thinkingLevel: DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	return {
		model: undefined,
		thinkingLevel: DEFAULT_THINKING_LEVEL,
		fallbackMessage: undefined,
	};
}

/**
 * Restore model from session, with fallback to available models
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{
	model: Model<Api> | undefined;
	fallbackMessage: string | undefined;
}> {
	const exactRestoredModel = modelRuntime.getModel(savedProvider, savedModelId);
	const restoredModel = await resolveRestoredModelReference(savedProvider, savedModelId, modelRuntime);

	if (restoredModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	const reason = !exactRestoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	const availableModels = await [...modelRuntime.getAvailableSnapshot()];
	const fallbackModel = findPreferredAvailableModel(availableModels);
	if (fallbackModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	return { model: undefined, fallbackMessage: undefined };
}
