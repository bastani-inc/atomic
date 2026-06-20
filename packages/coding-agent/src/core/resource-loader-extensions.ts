import { resolvePath } from "../utils/paths.ts";
import { startTimingSpan, endTimingSpan } from "./timings.ts";
import {
	loadExtensionFromFactory,
	loadExtensions,
	type WorkflowResourceProvider,
} from "./extensions/loader.ts";
import type { Extension, ExtensionRuntime, LoadExtensionsResult } from "./extensions/types.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import type { DefaultResourceLoaderInheritanceSnapshot } from "./resource-loader-types.ts";

function resolveExtensionLoadPath(loader: DefaultResourceLoader, path: string): string {
	return resolvePath(path, resourceInternals(loader).cwd, { normalizeUnicodeSpaces: true });
}

export async function loadFinalExtensionSet(
	loader: DefaultResourceLoader,
	extensionPaths: string[],
	preTrustExtensions: LoadExtensionsResult | undefined,
	workflowResourceProvider: WorkflowResourceProvider,
	inheritanceSnapshotProvider: () => DefaultResourceLoaderInheritanceSnapshot,
): Promise<LoadExtensionsResult> {
	const state = resourceInternals(loader);
	if (!preTrustExtensions) {
		const loadExtensionsSpan = startTimingSpan("DefaultResourceLoader.reload.loadExtensions");
		const extensionsResult = await loadExtensions(
			extensionPaths,
			state.cwd,
			state.eventBus,
			workflowResourceProvider,
			undefined,
			inheritanceSnapshotProvider,
		);
		endTimingSpan(loadExtensionsSpan);
		const inlineExtensionsSpan = startTimingSpan("DefaultResourceLoader.reload.loadInlineExtensionFactories");
		const inlineExtensions = await loadExtensionFactories(
			loader,
			extensionsResult.runtime,
			workflowResourceProvider,
			inheritanceSnapshotProvider,
		);
		endTimingSpan(inlineExtensionsSpan);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		addExtensionConflictDiagnostics(extensionsResult);
		return extensionsResult;
	}

	const preloadedByPath = new Map(
		preTrustExtensions.extensions
			.filter((extension) => !extension.path.startsWith("<inline:"))
			.map((extension) => [extension.resolvedPath, extension]),
	);
	const failedPreloadPaths = new Set(
		preTrustExtensions.errors.map((error) => resolveExtensionLoadPath(loader, error.path)),
	);
	const remainingPaths = extensionPaths.filter((path) => {
		const resolvedPath = resolveExtensionLoadPath(loader, path);
		return !preloadedByPath.has(resolvedPath) && !failedPreloadPaths.has(resolvedPath);
	});
	const loadExtensionsSpan = startTimingSpan("DefaultResourceLoader.reload.loadExtensions");
	const remainingExtensions = await loadExtensions(
		remainingPaths,
		state.cwd,
		state.eventBus,
		workflowResourceProvider,
		preTrustExtensions.runtime,
		inheritanceSnapshotProvider,
	);
	endTimingSpan(loadExtensionsSpan);
	const loadedByPath = new Map(preloadedByPath);
	for (const extension of remainingExtensions.extensions) {
		loadedByPath.set(extension.resolvedPath, extension);
	}

	const inlineExtensions = preTrustExtensions.extensions.filter((extension) => extension.path.startsWith("<inline:"));
	const orderedExtensions = extensionPaths
		.map((path) => loadedByPath.get(resolveExtensionLoadPath(loader, path)))
		.filter((extension): extension is Extension => extension !== undefined);
	orderedExtensions.push(...inlineExtensions);

	const extensionsResult: LoadExtensionsResult = {
		extensions: orderedExtensions,
		errors: [...preTrustExtensions.errors, ...remainingExtensions.errors],
		runtime: preTrustExtensions.runtime,
	};
	addExtensionConflictDiagnostics(extensionsResult);
	return extensionsResult;
}

export async function loadExtensionFactories(
	loader: DefaultResourceLoader,
	runtime: ExtensionRuntime,
	workflowResourceProvider: WorkflowResourceProvider,
	inheritanceSnapshotProvider: () => DefaultResourceLoaderInheritanceSnapshot,
): Promise<{
	extensions: Extension[];
	errors: Array<{ path: string; error: string }>;
}> {
	const state = resourceInternals(loader);
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];

	for (const [index, factory] of state.extensionFactories.entries()) {
		const extensionPath = `<inline:${index + 1}>`;
		try {
			const extension = await loadExtensionFromFactory(
				factory,
				state.cwd,
				state.eventBus,
				runtime,
				extensionPath,
				workflowResourceProvider,
				inheritanceSnapshotProvider,
			);
			extensions.push(extension);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load extension";
			errors.push({ path: extensionPath, error: message });
		}
	}

	return { extensions, errors };
}

function addExtensionConflictDiagnostics(extensionsResult: LoadExtensionsResult): void {
	// Detect extension conflicts (tools, commands, flags with same names from different extensions)
	// Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
	const conflicts = detectExtensionConflicts(extensionsResult.extensions);
	for (const conflict of conflicts) {
		extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
	}
}

function detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
	const conflicts: Array<{ path: string; message: string }> = [];

	// Track which extension registered each tool and flag
	const toolOwners = new Map<string, string>();
	const flagOwners = new Map<string, string>();

	for (const ext of extensions) {
		// Check tools
		for (const toolName of ext.tools.keys()) {
			const existingOwner = toolOwners.get(toolName);
			if (existingOwner && existingOwner !== ext.path) {
				conflicts.push({
					path: ext.path,
					message: `Tool "${toolName}" conflicts with ${existingOwner}`,
				});
			} else {
				toolOwners.set(toolName, ext.path);
			}
		}

		// Check flags
		for (const flagName of ext.flags.keys()) {
			const existingOwner = flagOwners.get(flagName);
			if (existingOwner && existingOwner !== ext.path) {
				conflicts.push({
					path: ext.path,
					message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
				});
			} else {
				flagOwners.set(flagName, ext.path);
			}
		}
	}

	return conflicts;
}
