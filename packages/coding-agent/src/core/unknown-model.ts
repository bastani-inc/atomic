import type { Api, Model } from "@bastani/atomic-ai/compat";

export function isUnknownModel(model: Model<Api> | undefined): boolean {
	return !!model && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}
