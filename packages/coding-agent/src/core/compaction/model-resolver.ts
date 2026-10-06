import { type AnyModel, isModelType } from "@bastani/pi-ai";
import type { Api, Model } from "@bastani/pi-ai/compat";

export type CompactionModelSelection =
	| { kind: "chat"; fullId: string; model: Model<Api> }
	| { kind: "classifier" | "morph"; fullId: string };

export function resolveCompactionModel(
	configured: string,
	currentModel: Model<Api>,
	models: readonly AnyModel[],
): CompactionModelSelection {
	if (typeof configured !== "string" || configured.trim() !== configured) {
		throw new Error("Invalid compactionModel: use an exact provider/model ID, auto, or an empty string.");
	}
	if (configured === "" || configured === "auto") {
		return { kind: "chat", fullId: `${currentModel.provider}/${currentModel.id}`, model: currentModel };
	}
	const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === configured);
	if (model && isModelType(model, "chat")) return { kind: "chat", fullId: configured, model };
	if (model && isModelType(model, "classifier")) return { kind: "classifier", fullId: configured };
	if (configured === "morph/morph-compactor") return { kind: "morph", fullId: configured };
	throw new Error(
		"Invalid compactionModel: the exact model is not in the current chat, classifier, or compactor catalog.",
	);
}
