/**
 * How Atomic shows a model (#4269): its raw ID, exactly as `--model`, settings, workflow `model:` fields and extension
 * configs take it, followed by the reasoning level it runs at. A display name never replaces the ID; it is secondary
 * metadata at most, such as a dim picker column or a search target.
 *
 * Split on whitespace, `anthropic/claude-sonnet-4-5  high` gives the `anthropic/claude-sonnet-4-5` and `high` that
 * `--model anthropic/claude-sonnet-4-5:high` takes.
 */

import type { Api, Model } from "@bastani/pi-ai/compat";
import { splitFallbackModel } from "./fallback-models.ts";

/** Between a model's ID and its level in the TUI and in notices. */
export const MODEL_LABEL_SEPARATOR = "  ";

/** Between a model's ID and its level in machine-readable output such as `--list-models`. */
export const MODEL_LABEL_FIELD_SEPARATOR = "\t";

export type ModelLabelSubject = Pick<Model<Api>, "provider" | "id"> & { readonly reasoning?: boolean };

export interface ModelLabelOptions {
	/** The reasoning level the model runs at. A model without reasoning shows none. */
	readonly thinkingLevel?: string;
	/** Show the bare ID where the provider is already clear from context. */
	readonly omitProvider?: boolean;
	/** Defaults to {@link MODEL_LABEL_SEPARATOR}. */
	readonly separator?: string;
}

/**
 * A model's label: `provider/id` (or `id` with `omitProvider`), followed by its level when it has reasoning.
 *
 * A string is a model reference as configured or recorded (`provider/id[:level]`). Its own level suffix wins over
 * `thinkingLevel`, and since a reference cannot say whether the model reasons, any level it carries is shown.
 */
export function formatModelLabel(model: ModelLabelSubject | string, options: ModelLabelOptions = {}): string {
	let reference: string;
	let level: string | undefined;
	if (typeof model === "string") {
		const parsed = splitFallbackModel(model);
		const slash = parsed.modelId.indexOf("/");
		reference = options.omitProvider && slash >= 0 ? parsed.modelId.slice(slash + 1) : parsed.modelId;
		level = parsed.thinkingLevel ?? options.thinkingLevel;
	} else {
		reference = options.omitProvider ? model.id : `${model.provider}/${model.id}`;
		level = model.reasoning ? options.thinkingLevel : undefined;
	}
	return level ? `${reference}${options.separator ?? MODEL_LABEL_SEPARATOR}${level}` : reference;
}
