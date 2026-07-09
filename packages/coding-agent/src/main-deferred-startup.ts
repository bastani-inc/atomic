import type { Args } from "./cli/args.ts";
import type { AppMode } from "./main-app-mode.ts";
import type { ScopedModel } from "./core/model-resolver-types.ts";
import type { ProjectTrustStore } from "./core/trust-manager.ts";
import { hasProjectTrustInputs } from "./core/trust-manager.ts";


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

export interface ComputeStartupInputCaptureInput {
	appMode: AppMode;
	stdinIsTTY: boolean;
	parsed: Pick<Args, "help" | "listModels" | "projectTrustOverride" | "systemPrompt" | "appendSystemPrompt" | "unknownFlags" | "provider" | "model" | "resume" | "session">;
	sessionCwd: string;
	projectTrustStore: Pick<ProjectTrustStore, "get">;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	deprecationWarningCount: number;
}

export function computeStartupInputCaptureEnabled(input: ComputeStartupInputCaptureInput): boolean {
	if (input.parsed.resume || input.parsed.session !== undefined) return false;
	const hasTrustInputs = hasProjectTrustInputs(input.sessionCwd);
	return input.deprecationWarningCount === 0 && computeDeferExtensions({
		appMode: input.appMode,
		stdinIsTTY: input.stdinIsTTY,
		hasSessionStartEvent: false,
		help: input.parsed.help,
		listModels: input.parsed.listModels,
		shouldResolveProjectTrust: input.parsed.projectTrustOverride === undefined && hasTrustInputs,
		storedProjectTrust: hasTrustInputs ? input.projectTrustStore.get(input.sessionCwd) : null,
		resolvedExtensionPathCount: input.resolvedExtensionPathCount,
		resolvedResourcePathCount: input.resolvedResourcePathCount,
		hasSystemPromptInput: input.parsed.systemPrompt !== undefined || (input.parsed.appendSystemPrompt?.length ?? 0) > 0,
		unknownFlagCount: input.parsed.unknownFlags.size,
		provider: input.parsed.provider,
		model: input.parsed.model,
	});
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
		input.unknownFlagCount === 0
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
