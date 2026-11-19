import * as path from "node:path";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.js";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "../mandatory-runtime-tools.ts";
import {
	createSyntheticSourceInfo,
	getResourcePathKeyAsync,
	getSyntheticPathSource,
	isSyntheticPath,
} from "../source-info.ts";
import { endTimingSpan, startTimingSpan } from "../timings.ts";
import { getBuiltinExtensionEntryLabel } from "./builtin-extension-entry-labels.ts";
import { installBuiltinChildRecordWriter } from "./builtin-subagent-record-writer.js";
import { createExtensionAPI } from "./loader-api.ts";
import {
	bindRegistrationCallbacks,
	copyRegistrations,
	createInvocationBindings,
	extensionSource,
	prepareRegistrationCallbacks,
	reconcileRegistration,
	registrationFields,
	resolveInvocationRuntime,
} from "./loader-bindings.ts";
import type { PackageMcpServerSource, ResourceLoaderInheritanceSnapshotProvider } from "./loader-resources.ts";
import { factoryAcquisitions, factoryRollbackError, rollbackExtensionFactories } from "./loader-rollback.ts";
import { createExtensionRuntime } from "./loader-runtime.ts";
import { type ExtensionCacheToken, loadExtensionModule, useExtensionCacheCwd } from "./loader-virtual-modules.js";
import type { Extension, ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from "./types.ts";

/** Associate extension runtimes with the event bus used to construct their APIs. */
const runtimeEventBuses = new WeakMap<ExtensionRuntime, EventBus>();
// Only loading the actual shipped file grants this identity; a custom loader's claimed source path does not.
const subagentFactories = new WeakSet<ExtensionFactory>();

interface ExtensionSource {
	identity: symbol;
	factory: ExtensionFactory;
	registrationSource: object | string;
	packageSource: PackageMcpServerSource | undefined;
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider;
}
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
	// A spread must keep the recipe, but a fresh replay's private receipt is not a change to the descriptor's data.
	Object.defineProperty(recipe, "identity", { enumerable: false });
	Object.defineProperty(extension, extensionSource, { value: recipe, enumerable: true });
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
			const sourceRecipe = (source as DiscoveredExtension)[extensionSource];
			let index = records.findIndex(
				(record) =>
					record.extension === source ||
					record.recipe === sourceRecipe ||
					(sourceRecipe?.identity !== undefined && record.recipe.identity === sourceRecipe.identity),
			);
			if (index < 0 && !sourceRecipe) {
				// A loader may project just the public fields. Reuse an unambiguous discovery object, never its label.
				const candidates = records.filter(
					({ extension }) =>
						extension.sourceInfo === source.sourceInfo ||
						registrationFields.some((field) => source[field] !== undefined && source[field] === extension[field]),
				);
				if (candidates.length === 1) index = records.indexOf(candidates[0]);
			}
			const construction = index < 0 ? undefined : records.splice(index, 1)[0];
			const recipe = construction?.recipe ?? sourceRecipe;
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
				recipe.packageSource,
				recipe.resourceLoaderInheritanceSnapshotProvider,
				source,
				recipe.registrationSource,
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
			if (source.replaceable !== undefined) extension.replaceable = source.replaceable;
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
	const source = getSyntheticPathSource(extensionPath) ?? "local";
	const baseDir = isSyntheticPath(extensionPath) ? undefined : path.dirname(resolvedPath);

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
	packageSource?: PackageMcpServerSource,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	cacheToken?: ExtensionCacheToken,
	agentDir?: string,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const moduleSpan = startTimingSpan(`loadExtensions.${extensionPath}.module`, "extensions");
		const factory = await loadExtensionModule(resolvedPath, cacheToken, agentDir);
		endTimingSpan(moduleSpan);
		if (!factory) {
			return {
				extension: null,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		if (getBuiltinExtensionEntryLabel(resolvedPath) === "subagents") subagentFactories.add(factory);
		const factorySpan = startTimingSpan(`loadExtensions.${extensionPath}.factory`, "extensions");
		const extension = await loadOwnedExtensionFromFactory(
			[],
			factory,
			cwd,
			eventBus,
			runtime,
			extensionPath,
			packageSource,
			resourceLoaderInheritanceSnapshotProvider,
			createExtension(extensionPath, resolvedPath),
			await getResourcePathKeyAsync(resolvedPath),
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
	packageSource?: PackageMcpServerSource,
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
		packageSource,
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
	packageSource: PackageMcpServerSource | undefined,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	source?: Pick<Extension, "resolvedPath" | "sourceInfo">,
	registrationSource: object | string = factory,
): Promise<Extension> {
	const extension = createExtension(extensionPath, source?.resolvedPath ?? extensionPath);
	if (source) extension.sourceInfo = source.sourceInfo;
	const resolvedCwd = resolvePath(cwd);
	const transaction = createExtensionAPI(
		extension,
		runtime,
		resolvedCwd,
		eventBus,
		packageSource,
		resourceLoaderInheritanceSnapshotProvider,
		registrationSource,
	);
	try {
		if (subagentFactories.has(factory))
			installBuiltinChildRecordWriter(transaction.api, () => resolveInvocationRuntime(runtime));
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
		identity: Symbol(),
		factory,
		registrationSource,
		packageSource,
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
	packageSource?: PackageMcpServerSource,
	runtime?: ExtensionRuntime,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	useCache = false,
	agentDir?: string,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const cacheToken = useCache ? useExtensionCacheCwd(cwd, agentDir) : undefined;
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
			packageSource,
			resourceLoaderInheritanceSnapshotProvider,
			cacheToken,
			agentDir,
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

/**
 * Load extensions from paths. `agentDir` is the agent directory whose transpile
 * cache the loads use; it defaults to the agent directory in effect now.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	packageSource?: PackageMcpServerSource,
	runtime?: ExtensionRuntime,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	agentDir?: string,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(
		paths,
		cwd,
		eventBus,
		packageSource,
		runtime,
		resourceLoaderInheritanceSnapshotProvider,
		false,
		agentDir,
	);
}

export async function loadExtensionsCached(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	packageSource?: PackageMcpServerSource,
	runtime?: ExtensionRuntime,
	resourceLoaderInheritanceSnapshotProvider?: ResourceLoaderInheritanceSnapshotProvider,
	agentDir?: string,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(
		paths,
		cwd,
		eventBus,
		packageSource,
		runtime,
		resourceLoaderInheritanceSnapshotProvider,
		true,
		agentDir,
	);
}
