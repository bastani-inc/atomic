import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { createArtifactRouter, registerArtifactDir } from "../tools/artifact-protocol.ts";
import type {
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ReloadHandler,
	SwitchSessionHandler,
} from "./runner-handlers.ts";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionMode,
	ExtensionUIContext,
	OrchestrationContext,
	SubagentChildPolicy,
} from "./types.ts";
export interface ExtensionContextSource {
	assertActive(): void;
	getUIContext(): ExtensionUIContext;
	getMode(): ExtensionMode;
	hasUI(): boolean;
	getCwd(): string;
	getSessionManager(): SessionManager;
	getModelRegistry(): ModelRegistry;
	getModel(): Model<Api> | undefined;
	getScopedModels(): readonly ScopedModel[];
	getThinkingLevel(): ThinkingLevel | undefined;
	getOrchestrationContext(): OrchestrationContext | undefined;
	getSubagentPolicy(): SubagentChildPolicy | undefined;
	isIdle(): boolean;
	isProjectTrusted(): boolean;
	getSignal(): AbortSignal | undefined;
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
 * A copy of `value` that shares no mutable structure with it, frozen through.
 *
 * Arrays and plain objects are rebuilt; everything else — primitives, and any
 * value carrying a prototype this does not own, such as a function or a class
 * instance — is passed through untouched rather than mangled into a plain
 * object. A `Model` is plain data (`input`, `cost.tiers`, `headers`,
 * `thinkingLevelMap`, `compat`), so the whole of one is rebuilt.
 */
function deepFrozenCopy<T>(value: T): T {
	if (Array.isArray(value)) return Object.freeze(value.map(deepFrozenCopy)) as T;
	if (typeof value !== "object" || value === null) return value;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copied: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) copied[key] = deepFrozenCopy(nested);
	return Object.freeze(copied) as T;
}

/**
 * A defensive copy of the model scope, entries included.
 *
 * `readonly ScopedModel[]` is a compile-time claim only, so the array is
 * copied: a JavaScript extension, or one asserting the `readonly` away, could
 * otherwise push onto the session's own array and have `cycleModel()` treat the
 * entry as in scope.
 *
 * Copying the array alone is not enough. The entries are the session's objects,
 * so mutating `entry.model` or `entry.thinkingLevel` in place reaches the very
 * array `cycleModel()` reads, and swaps the model it selects without ever
 * touching the array.
 *
 * Nor is copying the entry and its model one level deep. `Object.freeze` and a
 * spread both stop at the first level, so `model.headers`, `model.input`,
 * `model.cost.tiers`, `model.thinkingLevelMap` and `model.compat` stayed the
 * session's own objects: writing through any of them changed the model used for
 * selection and request composition, and the freeze reported nothing. The copy
 * goes all the way down, and freezes all the way down with it, so an attempt
 * fails loudly under strict mode instead of silently succeeding.
 *
 * The accessor reports the scope; it must not be a way to change it.
 */
export function copyScopedModels(scoped: readonly ScopedModel[]): readonly ScopedModel[] {
	return Object.freeze(scoped.map((entry) => deepFrozenCopy(entry)));
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
		get scopedModels() {
			source.assertActive();
			return copyScopedModels(source.getScopedModels());
		},
		get thinkingLevel() {
			source.assertActive();
			return source.getThinkingLevel();
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
		get subagentPolicy() {
			source.assertActive();
			return source.getSubagentPolicy();
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
