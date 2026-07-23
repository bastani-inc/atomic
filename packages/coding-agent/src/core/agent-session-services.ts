import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getAgentConfigPaths, getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { endTimingSpan, startTimingSpan } from "./timings.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	modelRuntime?: ModelRuntime;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	fallbackModels?: CreateAgentSessionOptions["fallbackModels"];
	contextWindow?: number;
	contextWindowStrict?: boolean;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	tools?: CreateAgentSessionOptions["tools"];
	excludedTools?: CreateAgentSessionOptions["excludedTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			extensionsResult.runtime.explicitFlagNames.add(name);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			extensionsResult.runtime.explicitFlagNames.add(name);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const authStorageSpan = startTimingSpan("createAgentSessionServices.authStorage");
	const authStorage = options.modelRuntime?.authStorage ?? options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	endTimingSpan(authStorageSpan);
	const settingsSpan = startTimingSpan("createAgentSessionServices.settingsManager");
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	endTimingSpan(settingsSpan);
	const modelRegistrySpan = startTimingSpan("createAgentSessionServices.modelRegistry");
	const modelsJsonPaths = agentDir === getAgentDir() ? getAgentConfigPaths("models.json") : join(agentDir, "models.json");
	const modelRegistry = options.modelRuntime?.modelRegistry ?? options.modelRegistry ?? ModelRegistry.create(authStorage, modelsJsonPaths);
	endTimingSpan(modelRegistrySpan);
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	const reloadSpan = startTimingSpan("createAgentSessionServices.resourceLoader.reload");
	await resourceLoader.reload(options.resourceLoaderReloadOptions);
	endTimingSpan(reloadSpan);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const providerSpan = startTimingSpan("createAgentSessionServices.providerRegistrations");
	const extensionsResult = resourceLoader.getExtensions();
	for (const registration of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			if ("provider" in registration) modelRegistry.registerProvider(registration.provider);
			else modelRegistry.registerProvider(registration.name, registration.config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${registration.extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	endTimingSpan(providerSpan);
	const catalogRestoreSpan = startTimingSpan("createAgentSessionServices.restoreModelCatalogs");
	await modelRegistry.refresh({ allowNetwork: false });
	endTimingSpan(catalogRestoreSpan);
	const flagSpan = startTimingSpan("createAgentSessionServices.extensionFlagValidation");
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));
	endTimingSpan(flagSpan);

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		fallbackModels: options.fallbackModels,
		contextWindow: options.contextWindow,
		contextWindowStrict: options.contextWindowStrict,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludedTools: options.excludedTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
