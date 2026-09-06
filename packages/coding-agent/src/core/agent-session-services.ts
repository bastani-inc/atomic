import { join } from "node:path";
import type { Api, Model } from "@bastani/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../config.js";
import { resolvePath } from "../utils/paths.ts";
import type { ProjectTrustContext, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { withMandatoryResourceLoader } from "./mandatory-resource-loader.ts";
import { ModelRuntime } from "./model-runtime.js";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { prepareDefaultResourceLoaderReload } from "./resource-loader-reload.ts";
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
	settingsManager?: SettingsManager;
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
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
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
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	/** Complete interactive trust after the safe session has a live UI binding. */
	completeStartup?: (context: ProjectTrustContext) => Promise<void>;
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
	allowUnknownFlags = false,
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
			extensionsResult.runtime.explicitFlagNames ??= new Set();
			extensionsResult.runtime.explicitFlagNames.add(name);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			extensionsResult.runtime.explicitFlagNames ??= new Set();
			extensionsResult.runtime.explicitFlagNames.add(name);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0 && !allowUnknownFlags) {
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
	return (await prepareAgentSessionServices(options))();
}

/** Prepare trust now; construct approved resources and register providers on continuation. */
export async function prepareAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<() => Promise<AgentSessionServices>> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const modelRuntimeSpan = startTimingSpan("createAgentSessionServices.modelRuntime");
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		}));
	endTimingSpan(modelRuntimeSpan);
	const settingsSpan = startTimingSpan("createAgentSessionServices.settingsManager");
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	endTimingSpan(settingsSpan);
	const resourceLoaderOptions = options.resourceLoaderOptions ?? {};
	const defaultResourceLoader = new DefaultResourceLoader({
		...resourceLoaderOptions,
		cwd,
		agentDir,
		settingsManager,
	});
	const reloadSpan = startTimingSpan("createAgentSessionServices.resourceLoader.reload");
	const completeReload = await prepareDefaultResourceLoaderReload(
		defaultResourceLoader,
		options.resourceLoaderReloadOptions,
	);
	let initialServices = true;
	return async () => {
		await completeReload();
		const resourceLoader = await withMandatoryResourceLoader(defaultResourceLoader, cwd);
		endTimingSpan(reloadSpan);

		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const providerSpan = startTimingSpan("createAgentSessionServices.providerRegistrations");
		const extensionsResult = resourceLoader.getExtensions();
		for (const registration of extensionsResult.runtime.pendingProviderRegistrations) {
			try {
				const providerId = "provider" in registration ? registration.provider.id : registration.name;
				if ("provider" in registration) modelRuntime.registerNativeProvider(registration.provider);
				else modelRuntime.registerProvider(registration.name, registration.config);
				extensionsResult.runtime.extensionProviderIds.add(providerId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				diagnostics.push({ type: "error", message: `Extension "${registration.extensionPath}" error: ${message}` });
			}
		}
		extensionsResult.runtime.pendingProviderRegistrations = [];
		endTimingSpan(providerSpan);
		const catalogRestoreSpan = startTimingSpan("createAgentSessionServices.restoreModelCatalogs");
		await modelRuntime.refresh({ allowNetwork: false });
		endTimingSpan(catalogRestoreSpan);
		diagnostics.push(
			...applyExtensionFlagValues(
				resourceLoader,
				options.extensionFlagValues,
				Boolean(options.resourceLoaderReloadOptions?.deferProjectTrust && initialServices),
			),
		);
		initialServices = false;

		return {
			cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoader,
			diagnostics,
		};
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
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		fallbackModels: options.fallbackModels,
		excludedTools: options.excludedTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
