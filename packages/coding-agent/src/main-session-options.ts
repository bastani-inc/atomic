import { modelsAreEqual } from "@bastani/atomic-ai/compat";
import type { Args } from "./cli/args.ts";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import { resolveFallbackModel } from "./core/fallback-models.ts";
import { resolveCliModel, type ScopedModel } from "./core/model-resolver.ts";
import type { ModelRuntime } from "./core/model-runtime.js";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import type { SettingsManager } from "./core/settings-manager.ts";

/**
 * The fallback chain the CLI arguments give a session: `[]` for none, the `--fallback-models` list, or `undefined` to
 * follow the `fallbackModels` setting. A model named with --model runs as named: it falls back only to the models
 * --fallback-models names, never to the settings fallbackModels, user or project, as a subagent launched on a named
 * model does (#4223). --no-fallback turns fallback off for any session. Child sessions inherit this chain.
 */
export function cliFallbackChain(parsed: Args): string[] | undefined {
	if (parsed.noFallback) return [];
	if (parsed.fallbackModels !== undefined) return [...parsed.fallbackModels];
	if (parsed.model !== undefined) return [];
	return undefined;
}

/**
 * One warning per distinct entry of the session's fallback chain that names no model with configured credentials;
 * the chain skips it. Run it only once extensions have registered their providers, or an extension's model is
 * reported as missing.
 */
export function unresolvedFallbackModelDiagnostics(
	parsed: Args,
	settingsManager: SettingsManager,
	modelRuntime: ModelRuntime,
	preferredProvider: string | undefined,
): AgentSessionRuntimeDiagnostic[] {
	const entries = cliFallbackChain(parsed) ?? settingsManager.getFallbackModels();
	const source = parsed.fallbackModels !== undefined ? "--fallback-models" : "fallbackModels setting";
	return [...new Set(entries)]
		.filter((entry) => !resolveFallbackModel(entry, modelRuntime, preferredProvider))
		.map((entry) => ({
			type: "warning",
			message: `${source} entry "${entry}" does not match a model with configured credentials, so model fallback skips it. Use --list-models to see available models.`,
		}));
}

export function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.provider && !parsed.model) {
		diagnostics.push({
			type: "error",
			message: `--provider requires --model (for example: --provider ${parsed.provider} --model <pattern>)`,
		});
	}
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			inlineApiKey: Boolean(parsed.apiKey),
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	const fallbackChain = cliFallbackChain(parsed);
	if (fallbackChain !== undefined) {
		options.fallbackModels = fallbackChain;
	}

	// Scoped models for CTRL+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludedTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}
