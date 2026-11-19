/**
 * Extension loader - loads TypeScript extension modules using jiti.
 */

export {
	getExtensionRuntimeEventBus,
	instantiateExtensions,
	loadExtensionFromFactory,
	loadExtensions,
	loadExtensionsCached,
} from "./loader-core.js";
export { discoverAndLoadExtensions } from "./loader-discovery.ts";
export type {
	PackageMcpServerSource,
	ResourceLoaderInheritanceSnapshotProvider,
} from "./loader-resources.ts";
export { createExtensionRuntime } from "./loader-runtime.ts";
export { clearExtensionCache } from "./loader-virtual-modules.js";
