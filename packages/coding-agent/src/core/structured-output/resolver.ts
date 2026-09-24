import { isModelType } from "@bastani/pi-ai";
import type { RouterModelSelectionOptions, StructuredOutputModel } from "./types.js";

export function resolveRouterModel(options: RouterModelSelectionOptions): StructuredOutputModel {
	const configured = options.settings.getRouterModel();
	if (typeof configured !== "string" || configured.trim() !== configured) {
		throw new Error("Invalid routerModel: use an exact provider/model ID, auto, or an empty string.");
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
		throw new Error(
			explicit
				? "Invalid routerModel: the exact model is not in the current chat or classifier catalog. Check settings.json."
				: "Router inference needs a selected chat model or an explicit routerModel.",
		);
	}
	return { kind: "chat", fullId: `${model.provider}/${model.id}`, model };
}
