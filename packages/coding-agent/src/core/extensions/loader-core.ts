import * as path from "node:path";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.js";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "../mandatory-runtime-tools.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { endTimingSpan, startTimingSpan } from "../timings.ts";
import { createExtensionAPI } from "./loader-api.ts";
import {
	bindRegistrationCallbacks,
	copyRegistrations,
	createInvocationBindings,
	prepareRegistrationCallbacks,
	reconcileRegistration,
	registrationFields,
} from "./loader-bindings.ts";
import {
	emptyWorkflowResourceProvider,
	type ResourceLoaderInheritanceSnapshotProvider,
	type WorkflowResourceProviderInput,
} from "./loader-resources.ts";
import { factoryAcquisitions, factoryRollbackError, rollbackExtensionFactories } from "./loader-rollback.ts";
import { createExtensionRuntime } from "./loader-runtime.ts";
import { type ExtensionCacheToken, loadExtensionModule, useExtensionCacheCwd } from "./loader-virtual-modules.js";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./types.ts";

/** Associate extension runtimes with the event bus used to construct their APIs. */
const runtimeEventBuses = new WeakMap<ExtensionRuntime, EventBus>();

interface ExtensionSource {
	factory: ExtensionFactory;
	workflowResourceProvider: WorkflowResourceProviderInput;
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider;
}
// Discovery records construction inputs, never a session ownership identity.
// The symbol survives the supported built/source extension-loader boundary.
const extensionSource = Symbol.for("atomic.extension-source.v1");
type DiscoveredExtension = Extension & { [extensionSource]?: ExtensionSource };
const runtimeSources = Symbol.for("atomic.extension-construction.v1");
interface Construction {
	extension: Extension;
	snapshot: Extension;
	recipe: ExtensionSource;
}
type DiscoveryRuntime = ExtensionRuntime & { [runtimeSources]?: Construction[] };

function rememberConstruction(extension: Extension, runtime: ExtensionRuntime, recipe: ExtensionSource): void {
	prepareRegistrationCallbacks(extension);
	Object.defineProperty(extension, extensionSource, { value: recipe });
	(runtime as DiscoveryRuntime)[runtimeSources] ??= [];
	const records = (runtime as DiscoveryRuntime)[runtimeSources]!;
	records.push({ extension, snapshot: copyRegistrations(extension), recipe });
}

export async function instantiateExtensions(target: LoadExtensionsResult, cwd: string): Promise<LoadExtensionsResult> {
	const runtime = createExtensionRuntime();
	const eventBus = getExtensionRuntimeEventBus(target.runtime);
	runtimeEventBuses.set(runtime, eventBus);
	const extensions: Extension[] = [];
	const bindings = createInvocationBindings(target.runtime, runtime);
	const records = [...((target.runtime as DiscoveryRuntime)[runtimeSources] ?? [])];
	try {
		for (const source of target.extensions) {
			const index = records.findIndex(
				(record) => record.extension.path === source.path && record.extension.resolvedPath === source.resolvedPath,
			);
			const construction = index < 0 ? undefined : records.splice(index, 1)[0];
			const recipe = construction?.recipe ?? (source as DiscoveredExtension)[extensionSource];
			if (!recipe) {
				// Hand-authored ResourceLoader registrations have no factory recipe.
				// Their callbacks remain caller code, but registration containers and
				// the runtime bindings still belong to this session generation.
				const extension = copyRegistrations(source);
				bindRegistrationCallbacks(extension, bindings);
				extensions.push(extension);
				continue;
			}
			const extension = await loadOwnedExtensionFromFactory(
				extensions,
				recipe.factory,
				cwd,
				eventBus,
				runtime,
				source.path,
				recipe.workflowResourceProvider,
				recipe.resourceLoaderInheritanceSnapshotProvider,
				source,
			);
			extensions.push(extension);
			if (construction) {
				bindings.extensions.set(construction.extension, extension);
				for (const key of registrationFields)
					Reflect.set(
						extension,
						key,
						reconcileRegistration(source[key], construction.snapshot[key], extension[key], bindings),
					);
			}
			bindRegistrationCallbacks(extension, bindings);
			if ([...source.tools.values()].some(isTrustedMandatoryRuntimeTool))
				markTrustedMandatoryRuntimeExtension(extension);
			extension.hidden = source.hidden;
		}
	} catch (error) {
		const failures = await rollbackExtensionFactories(extensions, cwd);
		try {
			runtime.invalidate();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		throw factoryRollbackError(error, failures);
	}
	for (const name of target.runtime.explicitFlagNames ?? []) {
		runtime.explicitFlagNames?.add(name);
		if (target.runtime.flagValues.has(name)) runtime.flagValues.set(name, target.runtime.flagValues.get(name)!);
	}
	return { extensions, runtime, errors: [...target.errors] };
}

export function getExtensionRuntimeEventBus(runtime: ExtensionRuntime): EventBus {
	let eventBus = runtimeEventBuses.get(runtime);
	if (!eventBus) {
		eventBus = createEventBus();
		runtimeEventBuses.set(runtime, eventBus);
	}
	return eventBus;
}

const INTER_EXTENSION_YIELD_THRESHOLD_MS = 16;

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const moduleSpan = startTimingSpan(`loadExtensions.${extensionPath}.module`, "extensions");
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		endTimingSpan(moduleSpan);
		if (!factory) {
			return {
				extension: null,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		const factorySpan = startTimingSpan(`loadExtensions.${extensionPath}.factory`, "extensions");
		const extension = await loadExtensionFromFactory(
			factory,
			cwd,
			eventBus,
			runtime,
			extensionPath,
			workflowResourceProvider,
			resourceLoaderInheritanceSnapshotProvider,
			createExtension(extensionPath, resolvedPath),
		);
		endTimingSpan(factorySpan);
		return { extension, error: null };
	} catch (err) {
		// Ordinary discovery failures remain diagnostics; failed cleanup must reject creation.
		if (err instanceof Error && "code" in err && err.code === "ShutdownFailed") throw err;
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
	workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	source?: Pick<Extension, "resolvedPath" | "sourceInfo">,
): Promise<Extension> {
	return loadOwnedExtensionFromFactory(
		[],
		factory,
		cwd,
		eventBus,
		runtime,
		extensionPath,
		workflowResourceProvider,
		resourceLoaderInheritanceSnapshotProvider,
		source,
	);
}

/** Replay failure closes the whole fresh batch; ordinary discovery failure closes only itself. */
async function loadOwnedExtensionFromFactory(
	rollbackPeers: Extension[],
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath: string,
	workflowResourceProvider: WorkflowResourceProviderInput,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	source?: Pick<Extension, "resolvedPath" | "sourceInfo">,
): Promise<Extension> {
	const extension = createExtension(extensionPath, source?.resolvedPath ?? extensionPath);
	if (source) extension.sourceInfo = source.sourceInfo;
	const resolvedCwd = resolvePath(cwd);
	const transaction = createExtensionAPI(
		extension,
		runtime,
		resolvedCwd,
		eventBus,
		workflowResourceProvider,
		resourceLoaderInheritanceSnapshotProvider,
	);
	try {
		await factory(transaction.api);
		transaction.commit();
	} catch (error) {
		const failures = await rollbackExtensionFactories([...rollbackPeers.splice(0), extension], resolvedCwd);
		try {
			transaction.discard();
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		throw factoryRollbackError(error, failures);
	}
	rememberConstruction(extension, runtime, {
		factory,
		workflowResourceProvider,
		resourceLoaderInheritanceSnapshotProvider,
	});
	factoryAcquisitions.getStore()?.pending?.set(extension, { cwd: resolvedCwd, runtime });
	return extension;
}

/**
 * Load extensions from paths.
 */
async function loadExtensionsInternal(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
	runtime?: ExtensionRuntime,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	useCache = false,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();
	runtimeEventBuses.set(resolvedRuntime, resolvedEventBus);

	let processedExtensionCount = 0;
	let lastYieldAt = Date.now();
	for (const extPath of paths) {
		// Unconditional yields cost a full macrotask turn per extension (~100 ms
		// each while the TUI is live). Only yield when this turn has actually
		// held the event loop long enough to delay input/render work.
		if (processedExtensionCount > 0 && Date.now() - lastYieldAt >= INTER_EXTENSION_YIELD_THRESHOLD_MS) {
			await yieldToEventLoop();
			lastYieldAt = Date.now();
		}
		const extensionSpan = startTimingSpan(`loadExtensions.${extPath}.total`, "extensions");
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			workflowResourceProvider,
			resourceLoaderInheritanceSnapshotProvider,
			cacheToken,
		);
		endTimingSpan(extensionSpan);
		processedExtensionCount += 1;
		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		warnings: [],
		runtime: resolvedRuntime,
	};
}

export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
	runtime?: ExtensionRuntime,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(
		paths,
		cwd,
		eventBus,
		workflowResourceProvider,
		runtime,
		resourceLoaderInheritanceSnapshotProvider,
	);
}

export async function loadExtensionsCached(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	workflowResourceProvider: WorkflowResourceProviderInput = emptyWorkflowResourceProvider,
	runtime?: ExtensionRuntime,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(
		paths,
		cwd,
		eventBus,
		workflowResourceProvider,
		runtime,
		resourceLoaderInheritanceSnapshotProvider,
		true,
	);
}
