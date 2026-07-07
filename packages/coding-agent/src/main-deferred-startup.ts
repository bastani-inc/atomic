import type { Args } from "./cli/args.ts";
import type { AppMode } from "./main-app-mode.ts";
import type { ScopedModel } from "./core/model-resolver-types.ts";

export interface ComputeDeferExtensionsInput {
	appMode: AppMode;
	stdinIsTTY: boolean;
	hasSessionStartEvent: boolean;
	help?: boolean;
	listModels?: Args["listModels"];
	shouldResolveProjectTrust: boolean;
	storedProjectTrust: boolean | null;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	hasSystemPromptInput: boolean;
	unknownFlagCount: number;
	provider?: string;
	model?: string;
}

export function computeDeferExtensions(input: ComputeDeferExtensionsInput): boolean {
	return (
		input.appMode === "interactive" &&
		input.stdinIsTTY &&
		!input.hasSessionStartEvent &&
		!input.help &&
		input.listModels === undefined &&
		(!input.shouldResolveProjectTrust || input.storedProjectTrust !== null) &&
		input.resolvedExtensionPathCount === 0 &&
		input.resolvedResourcePathCount === 0 &&
		!input.hasSystemPromptInput &&
		input.unknownFlagCount === 0 &&
		input.provider === undefined &&
		input.model === undefined
	);
}

export function formatScopedModelList(scopedModels: ScopedModel[]): string {
	return scopedModels
		.map((scoped) => {
			const thinkingSuffix = scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : "";
			return `${scoped.model.id}${thinkingSuffix}`;
		})
		.join(", ");
}
