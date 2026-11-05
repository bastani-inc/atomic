import { isModelType } from "@bastani/pi-ai";
import { DecisionConfigError, DecisionModelUnavailableError } from "../decision/errors.js";
import type { DecisionModelSelectionOptions, StructuredOutputModel } from "./types.js";

/**
 * Resolve the configured `decisionModel` once: an exact registered classifier, else an exact registered chat model.
 * An empty or `auto` setting means the current chat model.
 */
export function resolveDecisionModel(options: DecisionModelSelectionOptions): StructuredOutputModel {
	const configured = options.settings.getDecisionModel();
	if (typeof configured !== "string" || configured.trim() !== configured) {
		throw new DecisionConfigError({ code: "invalid-setting", source: "settings", field: "decisionModel" });
	}
	const explicit = configured === "auto" ? "" : configured;
	if (explicit) {
		const separator = explicit.indexOf("/");
		const classifier =
			separator > 0
				? options.modelRegistry.getClassifierModel?.(explicit.slice(0, separator), explicit.slice(separator + 1))
				: undefined;
		if (classifier) return { kind: "classifier", fullId: explicit, model: classifier };
	}
	const model = explicit
		? options.modelRegistry.getAll().find((candidate) => `${candidate.provider}/${candidate.id}` === explicit)
		: options.currentModel;
	if (!model || model.id === "auto" || !isModelType(model, "chat")) {
		throw explicit
			? new DecisionModelUnavailableError({ reason: "not-in-catalog", model: explicit })
			: new DecisionModelUnavailableError({ reason: "no-chat-model" });
	}
	return { kind: "chat", fullId: `${model.provider}/${model.id}`, model };
}
