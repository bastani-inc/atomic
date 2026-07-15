import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { Args } from "./cli/args.ts";
import type { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import { isLegacyBareCursorModelId } from "./core/legacy-cursor-model-ids.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveCliModel } from "./core/model-resolver.ts";
import type { AppMode } from "./main-app-mode.ts";
import { bindExtensionsForModelDiscovery } from "./main-stdio.ts";

interface CursorModelRecoverySession {
	setModel(model: Model<Api>): Promise<void>;
	setContextWindow(contextWindow: number, options?: { persistDefault?: boolean }): void;
}

export interface CursorStartupRecoveryRuntime {
	readonly modelFallbackMessage?: string;
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	readonly services: { readonly modelRegistry: Pick<ModelRegistry, "getAll"> };
	readonly session: CursorModelRecoverySession & Pick<AgentSessionRuntime["session"], "discoverExtensionModels">;
}


export interface CursorModelRecoveryOptions {
	readonly cliProvider?: string;
	readonly cliModel?: string;
	readonly cliContextWindow?: number;
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	readonly modelRegistry: Pick<ModelRegistry, "getAll">;
	readonly session: CursorModelRecoverySession;
	readonly discoverModels: () => Promise<void>;
}

/** Resolve a Cursor CLI reference only after authenticated discovery, without fuzzy substitution. */
export function recoverCursorCliModelAfterExtensionStartup(
	parsed: Pick<Args, "provider" | "model" | "contextWindow">,
	runtime: CursorStartupRecoveryRuntime,
	appMode: AppMode,
): Promise<readonly AgentSessionRuntimeDiagnostic[]> {
	if (!isCursorSelection(parsed.provider, parsed.model) && isCursorReselectionFailure(runtime.modelFallbackMessage)) {
		return Promise.resolve(appendDiagnostic(runtime.diagnostics, runtime.modelFallbackMessage!));
	}
	return recoverUnresolvedCursorCliModel({
		cliProvider: parsed.provider,
		cliModel: parsed.model,
		cliContextWindow: parsed.contextWindow,
		diagnostics: runtime.diagnostics,
		modelRegistry: runtime.services.modelRegistry,
		session: runtime.session,
		discoverModels: () => bindExtensionsForModelDiscovery(runtime, extensionModeForAppMode(appMode)),
	});
}

export async function recoverUnresolvedCursorCliModel(
	options: CursorModelRecoveryOptions,
): Promise<readonly AgentSessionRuntimeDiagnostic[]> {
	if (!isCursorSelection(options.cliProvider, options.cliModel)) return options.diagnostics;

	const initial = resolveCliModel({
		cliProvider: options.cliProvider,
		cliModel: options.cliModel!,
		modelRegistry: options.modelRegistry,
	});
	await options.discoverModels();
	const reference = normalizeCursorReference(options.cliProvider, options.cliModel!);
	const resolved = findExactCursorModel(reference, options.modelRegistry.getAll());
	const diagnosticsWithoutInitialError = removePreDiscoveryCursorResolutionErrors(
		options.diagnostics,
		initial.error,
		options.cliProvider,
		reference,
	);
	if (!resolved) {
		const error = `Model "${reference}" not found. Cursor model IDs changed; reselect an exact model with --list-models.`;
		return diagnosticsWithoutInitialError.some((diagnostic) => diagnostic.type === "error" && diagnostic.message === error)
			? diagnosticsWithoutInitialError
			: [...diagnosticsWithoutInitialError, { type: "error", message: error }];
	}

	await options.session.setModel(resolved.model);
	if (options.cliContextWindow !== undefined) {
		try {
			options.session.setContextWindow(options.cliContextWindow, { persistDefault: true });
		} catch (error) {
			return [...diagnosticsWithoutInitialError, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			}];
		}
	}
	return diagnosticsWithoutInitialError;
}

function removePreDiscoveryCursorResolutionErrors(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
	initialError: string | undefined,
	cliProvider: string | undefined,
	reference: string,
): readonly AgentSessionRuntimeDiagnostic[] {
	const staleErrors = new Set<string>();
	if (initialError) staleErrors.add(initialError);
	if (cliProvider) {
		staleErrors.add(`Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`);
	}
	staleErrors.add(`Model "${reference}" not found. Use --list-models to see available models.`);
	staleErrors.add(`Model "${reference}" not found. Cursor model IDs changed; reselect an exact model with --list-models.`);
	return diagnostics.filter((diagnostic) => diagnostic.type !== "error" || !staleErrors.has(diagnostic.message));
}

function isCursorSelection(provider: string | undefined, model: string | undefined): boolean {
	if (!model) return false;
	const normalizedProvider = provider?.trim().toLowerCase();
	if (normalizedProvider && normalizedProvider !== "cursor") return false;
	if (normalizedProvider === "cursor") return true;
	const slashIndex = model.indexOf("/");
	return (slashIndex > 0 && model.slice(0, slashIndex).trim().toLowerCase() === "cursor")
		|| isLegacyBareCursorModelId(model);
}

function normalizeCursorReference(provider: string | undefined, model: string): string {
	const slashIndex = model.indexOf("/");
	if (slashIndex > 0 && model.slice(0, slashIndex).trim().toLowerCase() === "cursor") {
		return `cursor/${model.slice(slashIndex + 1)}`;
	}
	return provider?.trim().toLowerCase() === "cursor" || isLegacyBareCursorModelId(model) ? `cursor/${model}` : model;
}

function findExactCursorModel(
	reference: string,
	availableModels: Model<Api>[],
): { readonly model: Model<Api> } | undefined {
	const slashIndex = reference.indexOf("/");
	if (slashIndex <= 0 || reference.slice(0, slashIndex).toLowerCase() !== "cursor") return undefined;
	const modelId = reference.slice(slashIndex + 1);
	const direct = availableModels.find((model) => model.provider.toLowerCase() === "cursor" && model.id === modelId);
	return direct ? { model: direct } : undefined;
}

function isCursorReselectionFailure(message: string | undefined): boolean {
	return message?.includes("Cursor model") === true && message.includes("reselect an exact model");
}

function appendDiagnostic(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
	message: string,
): readonly AgentSessionRuntimeDiagnostic[] {
	return diagnostics.some((diagnostic) => diagnostic.type === "error" && diagnostic.message === message)
		? diagnostics
		: [...diagnostics, { type: "error", message }];
}

function extensionModeForAppMode(appMode: AppMode): "tui" | "print" | "json" | "rpc" {
	return appMode === "interactive" ? "tui" : appMode;
}
