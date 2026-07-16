import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { createArtifactRouter, registerArtifactDir } from "../tools/artifact-protocol.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionMode,
	ExtensionUIContext,
	OrchestrationContext,
} from "./types.ts";
import type {
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	SwitchSessionHandler,
} from "./runner-handlers.ts";

export interface ExtensionContextSource {
	assertActive(): void;
	getUIContext(): ExtensionUIContext;
	getMode(): ExtensionMode;
	hasUI(): boolean;
	getCwd(): string;
	getSessionManager(): SessionManager;
	getModelRegistry(): ModelRegistry;
	getModel(): Model<Api> | undefined;
	getOrchestrationContext(): OrchestrationContext | undefined;
	isIdle(): boolean;
	isProjectTrusted(): boolean;
	getSignal(): AbortSignal | undefined;
	discoverModelCatalog?(options?: { readonly signal?: AbortSignal }): Promise<void>;
	abort(): void;
	hasPendingMessages(): boolean;
	shutdown(): void;
	getContextUsage(): ContextUsage | undefined;
	compact(options?: CompactOptions): void;
	getSystemPrompt(): string;
}

export interface ExtensionCommandContextSource extends ExtensionContextSource {
	getSystemPromptOptions(): BuildSystemPromptOptions;
	waitForIdle(): Promise<void>;
	newSession: NewSessionHandler;
	fork: ForkHandler;
	navigateTree: NavigateTreeHandler;
	switchSession: SwitchSessionHandler;
	reload: ReloadHandler;
}

/**
 * Create an ExtensionContext for use in event handlers and tool execution.
 * Context values are resolved at call time, so host changes are reflected.
 */
export function createExtensionContext(source: ExtensionContextSource): ExtensionContext {
	return {
		get ui() {
			source.assertActive();
			return source.getUIContext();
		},
		get mode() {
			source.assertActive();
			return source.getMode();
		},
		get hasUI() {
			source.assertActive();
			return source.hasUI();
		},
		get cwd() {
			source.assertActive();
			return source.getCwd();
		},
		get sessionManager() {
			source.assertActive();
			return source.getSessionManager();
		},
		get modelRegistry() {
			source.assertActive();
			return source.getModelRegistry();
		},
		get model() {
			source.assertActive();
			return source.getModel();
		},
		get internalResourceRouter() {
			source.assertActive();
			const sessionDir = source.getSessionManager().getSessionDir();
			if (!sessionDir) return undefined;
			const artifactsDir = join(sessionDir, "artifacts");
			registerArtifactDir(artifactsDir);
			return createArtifactRouter(() => [artifactsDir]);
		},
		get orchestrationContext() {
			source.assertActive();
			return source.getOrchestrationContext();
		},
		isIdle: () => {
			source.assertActive();
			return source.isIdle();
		},
		isProjectTrusted: () => {
			source.assertActive();
			return source.isProjectTrusted();
		},
		get signal() {
			source.assertActive();
			return source.getSignal();
		},
		...(source.discoverModelCatalog === undefined ? {} : {
			discoverModelCatalog: (options?: { readonly signal?: AbortSignal }) => {
				source.assertActive();
				return source.discoverModelCatalog?.(options) ?? Promise.resolve();
			},
		}),
		abort: () => {
			source.assertActive();
			source.abort();
		},
		hasPendingMessages: () => {
			source.assertActive();
			return source.hasPendingMessages();
		},
		shutdown: () => {
			source.assertActive();
			source.shutdown();
		},
		getContextUsage: () => {
			source.assertActive();
			return source.getContextUsage();
		},
		compact: (options) => {
			source.assertActive();
			source.compact(options);
		},
		getSystemPrompt: () => {
			source.assertActive();
			return source.getSystemPrompt();
		},
	};
}

export function createExtensionCommandContext(source: ExtensionCommandContextSource): ExtensionCommandContext {
	// Use property descriptors instead of object spread so the guarded getters from
	// createExtensionContext() stay lazy. A spread would eagerly read them once and
	// freeze old values into the returned object, bypassing stale-instance checks.
	const context = Object.defineProperties(
		{},
		Object.getOwnPropertyDescriptors(createExtensionContext(source)),
	) as ExtensionCommandContext;
	context.getSystemPromptOptions = () => {
		source.assertActive();
		return source.getSystemPromptOptions();
	};
	context.waitForIdle = () => {
		source.assertActive();
		return source.waitForIdle();
	};
	context.newSession = (options) => {
		source.assertActive();
		return source.newSession(options);
	};
	context.fork = (entryId, options) => {
		source.assertActive();
		return source.fork(entryId, options);
	};
	context.navigateTree = (targetId, options) => {
		source.assertActive();
		return source.navigateTree(targetId, options);
	};
	context.switchSession = (sessionPath, options) => {
		source.assertActive();
		return source.switchSession(sessionPath, options);
	};
	context.reload = () => {
		source.assertActive();
		return source.reload();
	};
	return context;
}
