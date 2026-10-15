import type { Api, Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	error: string | undefined;
}

export type ModelFallbackReason = "session-restore" | "configured-provider-unsupported" | "no-models-available";

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
	fallbackReason?: ModelFallbackReason;
}
