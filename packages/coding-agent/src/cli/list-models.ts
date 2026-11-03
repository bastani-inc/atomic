/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@bastani/pi-ai/compat";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import { formatModelLabel, MODEL_LABEL_FIELD_SEPARATOR } from "../core/model-label.ts";
import type { ModelRuntime } from "../core/model-runtime.js";
import { type ModelSwitchThinkingSettings, thinkingLevelForModelSwitch } from "../core/model-switch-thinking-level.ts";
import { getModelSearchText } from "../modes/interactive/model-search.ts";

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * List available models, optionally filtered by search pattern.
 *
 * Each row starts with the model's `provider/id`, a tab, and the level `--model provider/id` starts it at (empty for
 * a model without reasoning), so a row's first two fields are exactly what `--model provider/id:level` takes
 * (#4269). Columns are tab-separated for scripts.
 */
export async function listModels(
	modelRuntime: ModelRuntime,
	searchPattern: string | undefined,
	settings: ModelSwitchThinkingSettings,
): Promise<void> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: errors loading models.json:\n${loadError}`));
	}
	const catalogWarning = modelRuntime.getWarning();
	if (catalogWarning) {
		console.error(chalk.yellow(`Warning: ${catalogWarning}`));
	}

	const models = modelRuntime.getAvailableSnapshot();

	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	// Apply fuzzy filter if search pattern provided; a display name still finds its model.
	let filteredModels: Model<Api>[] = [...models];
	if (searchPattern) {
		filteredModels = fuzzyFilter([...models], searchPattern, getModelSearchText);
	}

	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	// Sort by provider, then by model id
	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	const header = ["model", "level", "context", "max-out", "images"];
	console.log(header.join(MODEL_LABEL_FIELD_SEPARATOR));
	for (const model of filteredModels) {
		const row = [
			formatModelLabel(model),
			model.reasoning ? thinkingLevelForModelSwitch(model, { settings }) : "",
			formatTokenCount(model.contextWindow),
			formatTokenCount(model.maxTokens),
			model.input.includes("image") ? "yes" : "no",
		];
		console.log(row.join(MODEL_LABEL_FIELD_SEPARATOR));
	}
}
