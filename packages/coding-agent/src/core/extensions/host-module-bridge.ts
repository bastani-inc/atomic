import { isBunBinary, isBundledBuild } from "../../config.js";
import { getVirtualModules } from "./loader-host-modules.js";

export interface HostModuleBridgeInstallResult {
	installed: boolean;
	specifiers: string[];
}

export interface HostModuleBridgeBuilder {
	module(specifier: string, callback: () => { exports: object; loader: "object" }): HostModuleBridgeBuilder;
}

export interface HostModuleBridgePlugin {
	name: string;
	setup(build: HostModuleBridgeBuilder): void;
}

interface BunHostModuleBridgeRuntime {
	plugin(plugin: HostModuleBridgePlugin): void;
}

function getBunRuntime(): BunHostModuleBridgeRuntime | undefined {
	return (globalThis as typeof globalThis & { Bun?: BunHostModuleBridgeRuntime }).Bun;
}

/**
 * Create the runtime plugin that exposes the host's existing module namespace
 * objects to external ESM bundles without evaluating a second package graph.
 */
export function createHostModuleBridgePlugin(modules: Record<string, object>): HostModuleBridgePlugin {
	return {
		name: "atomic-host-module-bridge",
		setup(build) {
			for (const [specifier, hostModule] of Object.entries(modules)) {
				build.module(specifier, () => ({ exports: hostModule, loader: "object" }));
			}
		},
	};
}

let installPromise: Promise<HostModuleBridgeInstallResult> | null = null;

/** Register live host module objects before native builtin imports. */
export function installHostModuleBridge(): Promise<HostModuleBridgeInstallResult> {
	const bun = getBunRuntime();
	if (!(isBunBinary || isBundledBuild) || !bun || typeof bun.plugin !== "function") {
		return Promise.resolve({ installed: false, specifiers: [] });
	}

	installPromise ??= getVirtualModules()
		.then((modules) => {
			const specifiers = Object.keys(modules);
			bun.plugin(createHostModuleBridgePlugin(modules));
			return { installed: true, specifiers };
		})
		.catch((error: Error) => {
			installPromise = null;
			throw error;
		});
	return installPromise;
}
