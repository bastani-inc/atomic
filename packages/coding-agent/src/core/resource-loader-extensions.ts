import type { KeyId } from "@earendil-works/pi-tui";
import { resolvePath } from "../utils/paths.ts";
import { yieldToEventLoop } from "../utils/event-loop.ts";
import { startTimingSpan, endTimingSpan } from "./timings.ts";
import type { OverlappingResourceType } from "./diagnostics.ts";
import {
	loadExtensionFromFactory,
	loadExtensionsCached,
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
		const extensionsResult = await loadExtensionsCached(
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
	const remainingExtensions = await loadExtensionsCached(
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

	for (const [index, inlineExtension] of state.extensionFactories.entries()) {
		if (index > 0) {
			await yieldToEventLoop();
		}
		const descriptor = typeof inlineExtension === "function" ? undefined : inlineExtension;
		const factory = typeof inlineExtension === "function" ? inlineExtension : inlineExtension.factory;
		const extensionPath = `<inline:${descriptor?.name ?? index + 1}>`;
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
			extension.hidden = descriptor?.hidden;
			if (descriptor?.bundled) extension.sourceInfo.configurationOrigin = "bundled";
			extensions.push(extension);
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load extension";
			errors.push({ path: extensionPath, error: message });
		}
	}

	return { extensions, errors };
}

export function resolveInheritedExtensionOverlaps(extensionsResult: LoadExtensionsResult): void {
	extensionsResult.overlaps = [];
	removeInheritedRegistrations("tool", extensionsResult, (extension) => extension.tools);
	removeInheritedRegistrations("command", extensionsResult, (extension) => extension.commands);
	removeInheritedRegistrations("flag", extensionsResult, (extension) => extension.flags);
	removeInheritedRegistrations("shortcut", extensionsResult, (extension) => extension.shortcuts);
	installRegistrationPolicy(extensionsResult);
	rebuildFlagDefaults(extensionsResult);

	for (const conflict of detectExtensionConflicts(extensionsResult.extensions)) {
		extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
	}
}

function removeInheritedRegistrations<K extends string, V>(
	resourceType: OverlappingResourceType,
	extensionsResult: LoadExtensionsResult,
	getRegistrations: (extension: Extension) => Map<K, V>,
): void {
	const bundledOwners = new Map<K, Extension>();
	for (const extension of extensionsResult.extensions) {
		if (extension.sourceInfo.configurationOrigin !== "bundled") continue;
		for (const name of getRegistrations(extension).keys()) {
			if (!bundledOwners.has(name)) bundledOwners.set(name, extension);
		}
	}
	for (const extension of extensionsResult.extensions) {
		if (extension.sourceInfo.configurationOrigin !== "inherited-pi") continue;
		const registrations = getRegistrations(extension);
		for (const name of [...registrations.keys()]) {
			const bundledOwner = bundledOwners.get(name);
			if (!bundledOwner) continue;
			registrations.delete(name);
			recordOverlap(extensionsResult, resourceType, name, bundledOwner, extension);
		}
	}
}

function installRegistrationPolicy(extensionsResult: LoadExtensionsResult): void {
	const flagOwners = extensionsResult.runtime.flagOwners ??= new Map();
	const flagOwnerOrigins = extensionsResult.runtime.flagOwnerOrigins ??= new Map();
	extensionsResult.runtime.canRegisterResource = (extension, resourceType, name) => {
		if (resourceType === "prompt") return true;
		if (extension.sourceInfo.configurationOrigin === "inherited-pi") {
			const bundledOwner = extensionsResult.extensions.find((candidate) =>
				candidate.sourceInfo.configurationOrigin === "bundled"
				&& hasActiveOrPendingRegistration(extensionsResult.runtime, candidate, resourceType, name));
			if (!bundledOwner) return true;
			recordOverlap(extensionsResult, resourceType, name, bundledOwner, extension);
			return false;
		}
		const isBundled = extension.sourceInfo.configurationOrigin === "bundled";
		for (const inherited of extensionsResult.extensions) {
			if (inherited.sourceInfo.configurationOrigin !== "inherited-pi"
				|| !hasActiveOrPendingRegistration(extensionsResult.runtime, inherited, resourceType, name)) continue;
			if (resourceType === "flag" && flagOwners.get(name) === inherited.path) {
				flagOwners.delete(name);
				flagOwnerOrigins.delete(name);
				if (!extensionsResult.runtime.explicitFlagNames?.has(name)) extensionsResult.runtime.flagValues.delete(name);
			}
			deleteRegistration(extensionsResult.runtime, inherited, resourceType, name);
			if (isBundled) recordOverlap(extensionsResult, resourceType, name, extension, inherited);
		}
		return true;
	};
}

function hasActiveOrPendingRegistration(
	runtime: ExtensionRuntime,
	extension: Extension,
	resourceType: Exclude<OverlappingResourceType, "prompt">,
	name: string,
): boolean {
	return hasRegistration(extension, resourceType, name)
		|| runtime.hasPendingResourceRegistration?.(extension, resourceType, name) === true;
}

function hasRegistration(extension: Extension, resourceType: Exclude<OverlappingResourceType, "prompt">, name: string): boolean {
	switch (resourceType) {
		case "tool": return extension.tools.has(name);
		case "command": return extension.commands.has(name);
		case "flag": return extension.flags.has(name);
		case "shortcut": return extension.shortcuts.has(name as KeyId);
	}
}

function deleteRegistration(
	runtime: ExtensionRuntime,
	extension: Extension,
	resourceType: Exclude<OverlappingResourceType, "prompt">,
	name: string,
): void {
	runtime.deletePendingResourceRegistration?.(extension, resourceType, name);
	switch (resourceType) {
		case "tool": extension.tools.delete(name); break;
		case "command": extension.commands.delete(name); break;
		case "flag": extension.flags.delete(name); break;
		case "shortcut": extension.shortcuts.delete(name as KeyId); break;
	}
}

function recordOverlap(
	extensionsResult: LoadExtensionsResult,
	resourceType: OverlappingResourceType,
	name: string,
	bundled: Extension,
	inherited: Extension,
): void {
	const overlaps = extensionsResult.overlaps ??= [];
	if (overlaps.some((overlap) => overlap.resourceType === resourceType && overlap.name === name && overlap.inherited.path === inherited.sourceInfo.path)) return;
	overlaps.push({ resourceType, name, bundled: bundled.sourceInfo, inherited: inherited.sourceInfo });
}

function rebuildFlagDefaults(extensionsResult: LoadExtensionsResult): void {
	extensionsResult.runtime.flagValues.clear();
	const flagOwners = extensionsResult.runtime.flagOwners ??= new Map();
	const flagOwnerOrigins = extensionsResult.runtime.flagOwnerOrigins ??= new Map();
	flagOwners.clear();
	flagOwnerOrigins.clear();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			if (!flagOwners.has(name)) {
				flagOwners.set(name, extension.path);
				flagOwnerOrigins.set(name, extension.sourceInfo.configurationOrigin);
			}
			if (flagOwnerOrigins.get(name) === extension.sourceInfo.configurationOrigin
				&& flag.default !== undefined && !extensionsResult.runtime.flagValues.has(name)) {
				extensionsResult.runtime.flagValues.set(name, flag.default);
			}
		}
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
