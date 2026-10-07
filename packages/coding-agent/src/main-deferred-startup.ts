import type { Args } from "./cli/args.ts";
import type { ScopedModel } from "./core/model-resolver-types.ts";
import type { ProjectTrustStore } from "./core/trust-manager.ts";
import { hasProjectTrustInputs } from "./core/trust-manager.ts";
import type { AppMode } from "./main-app-mode.ts";

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

export interface ComputeInteractiveEngineResourceDeferralInput {
	interactiveEngineChild: boolean;
	hasSessionStartEvent: boolean;
	shouldResolveProjectTrust: boolean;
	storedProjectTrust: boolean | null;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	hasSystemPromptInput: boolean;
	unknownFlagCount: number;
}

export interface ComputeStartupInputCaptureInput {
	appMode: AppMode;
	stdinIsTTY: boolean;
	parsed: Pick<
		Args,
		| "help"
		| "listModels"
		| "projectTrustOverride"
		| "systemPrompt"
		| "appendSystemPrompt"
		| "unknownFlags"
		| "provider"
		| "model"
		| "resume"
		| "session"
	>;
	sessionCwd: string;
	projectTrustStore: Pick<ProjectTrustStore, "get">;
	resolvedExtensionPathCount: number;
	resolvedResourcePathCount: number;
	deprecationWarningCount: number;
	sessionSelectionComplete?: boolean;
}

export function computeStartupInputCaptureEnabled(input: ComputeStartupInputCaptureInput): boolean {
	if (!input.sessionSelectionComplete && (input.parsed.resume || input.parsed.session !== undefined)) return false;
	const hasTrustInputs = hasProjectTrustInputs(input.sessionCwd);
	return (
		input.appMode === "interactive" &&
		input.stdinIsTTY &&
		!input.parsed.help &&
		input.parsed.listModels === undefined &&
		input.deprecationWarningCount === 0 &&
		(input.parsed.projectTrustOverride !== undefined ||
			!hasTrustInputs ||
			input.projectTrustStore.get(input.sessionCwd) !== null)
	);
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
		input.provider === undefined &&
		input.model === undefined &&
		input.unknownFlagCount === 0
	);
}

/**
 * The isolated engine may bind its minimal RPC session before loading optional
 * bundled resources. User-selected paths and trust-sensitive startup stay
 * synchronous because they can affect the first visible or interactive state.
 */
export function computeInteractiveEngineResourceDeferral(
	input: ComputeInteractiveEngineResourceDeferralInput,
): boolean {
	return (
		input.interactiveEngineChild &&
		!input.hasSessionStartEvent &&
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
