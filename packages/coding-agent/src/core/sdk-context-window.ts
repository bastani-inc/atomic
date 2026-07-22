import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getModelDefaultContextWindow, getSupportedContextWindows } from "./context-window.ts";

export const COPILOT_CONTEXT_WINDOW_SELECTION_OPTIONS = { allowCopilotLongContextFallback: true } as const;

export function getAlreadyAppliedContextWindow(model: Model<Api>): number | undefined {
	const defaultContextWindow = getModelDefaultContextWindow(model);
	if (model.contextWindow === defaultContextWindow) return undefined;
	return getSupportedContextWindows(model).includes(model.contextWindow) ? model.contextWindow : undefined;
}
