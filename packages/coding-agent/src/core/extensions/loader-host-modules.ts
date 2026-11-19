import { join } from "node:path";
import { getPackageDir, isBunBinary, isBundledBuild } from "../../config.js";
import { createModuleRequire } from "../../utils/module-require.js";
import { withLegacyPackageNames } from "./forked-package-names.ts";

let virtualModules: Record<string, object> | null = null;
let virtualModulesPromise: Promise<Record<string, object>> | null = null;

type HostModuleRequire = (specifier: string) => object;

function loadOptionalAtomicNatives(requireFromHost: HostModuleRequire, specifier: string): object | undefined {
	try {
		return requireFromHost(specifier);
	} catch {
		// Keep a missing or unloadable platform binding proportional: only an
		// extension that imports atomic-natives should fail, not every extension
		// waiting for the shared host-module map.
		return undefined;
	}
}

export async function loadVirtualModules(): Promise<Record<string, object>> {
	// Keep the native binding external to both the app sidecar and extension
	// bundles while sharing its process-global control plane through the bridge.
	// If the platform package is unavailable, omit only this registration so
	// unrelated builtins can still load.
	const requireFromHost = createModuleRequire(import.meta.url);
	const atomicNatives = loadOptionalAtomicNatives(
		requireFromHost,
		isBunBinary
			? join(getPackageDir(), "node_modules", "@bastani", "atomic-natives", "native", "index.js")
			: "@bastani/atomic-natives",
	);
	const [
		typebox,
		typeboxCompile,
		typeboxValue,
		agentCore,
		tui,
		tuiLayout,
		tuiLayoutNode,
		ai,
		aiOauth,
		aiModels,
		aiProviders,
		aiCloudflareGatewayBinding,
		aiProviderEnv,
		aiOauthPage,
		codemode,
		codemodeDeclarations,
		codemodeSource,
		codemodePortable,
		schema,
		schemaFormats,
		telemetry,
		telemetryRender,
		properLockfile,
		codingAgent,
		storage,
	] = await Promise.all([
		import("typebox"),
		import("typebox/compile"),
		import("typebox/value"),
		import("@bastani/atomic-agent-core"),
		import("@bastani/atomic-tui"),
		import("@bastani/atomic-tui/dist/layout.js"),
		import("@bastani/atomic-tui/dist/layout-node.js"),
		// pi 0.80.2: the old global pi-ai API moved off the root entrypoint onto
		// `/compat` (a strict superset). Extensions still use the root specifier.
		import("@bastani/atomic-ai/compat"),
		import("@bastani/atomic-ai/oauth"),
		import("@bastani/atomic-ai/models"),
		import("@bastani/atomic-ai/providers/all"),
		import("@bastani/atomic-ai/api/cloudflare-gateway-binding"),
		import("@bastani/atomic-ai/utils/provider-env"),
		import("@bastani/atomic-ai/utils/oauth-page"),
		import("@bastani/atomic-codemode"),
		import("@bastani/atomic-codemode/declarations"),
		import("@bastani/atomic-codemode/source"),
		import("@bastani/atomic-codemode/portable"),
		import("@bastani/atomic-schema"),
		import("@bastani/atomic-schema/formats"),
		import("@bastani/atomic-telemetry"),
		import("@bastani/atomic-telemetry/render"),
		// Keep proper-lockfile in the compiled host so extensions share its live
		// CommonJS module state instead of evaluating it through jiti.
		import("proper-lockfile"),
		// loader.ts exports are not re-exported from index.ts, avoiding a cycle.
		import("../../index.ts"),
		import("../storage/index.js"),
	]);

	// Each forked package also answers to its legacy pi names (@earendil-works/pi-*, @mariozechner/pi-*).
	return withLegacyPackageNames({
		typebox,
		"typebox/compile": typeboxCompile,
		"typebox/value": typeboxValue,
		"@sinclair/typebox": typebox,
		"@sinclair/typebox/compile": typeboxCompile,
		"@sinclair/typebox/value": typeboxValue,
		"@bastani/atomic-agent-core": agentCore,
		"@bastani/atomic-tui": tui,
		"@bastani/atomic-tui/dist/layout.js": tuiLayout,
		"@bastani/atomic-tui/dist/layout-node.js": tuiLayoutNode,
		"@bastani/atomic-ai": ai,
		"@bastani/atomic-ai/compat": ai,
		"@bastani/atomic-ai/oauth": aiOauth,
		"@bastani/atomic-ai/models": aiModels,
		"@bastani/atomic-ai/providers/all": aiProviders,
		"@bastani/atomic-ai/api/cloudflare-gateway-binding": aiCloudflareGatewayBinding,
		"@bastani/atomic-ai/utils/provider-env": aiProviderEnv,
		"@bastani/atomic-ai/utils/oauth-page": aiOauthPage,
		"@bastani/atomic-codemode": codemode,
		"@bastani/atomic-codemode/declarations": codemodeDeclarations,
		"@bastani/atomic-codemode/source": codemodeSource,
		"@bastani/atomic-codemode/portable": codemodePortable,
		"@bastani/atomic-schema": schema,
		"@bastani/atomic-schema/formats": schemaFormats,
		"@bastani/atomic-telemetry": telemetry,
		"@bastani/atomic-telemetry/render": telemetryRender,
		"proper-lockfile": properLockfile,
		...(atomicNatives ? { "@bastani/atomic-natives": atomicNatives } : {}),
		"@bastani/atomic": codingAgent,
		"@bastani/atomic/storage": storage,
		"@earendil-works/pi-coding-agent": codingAgent,
		"@mariozechner/pi-coding-agent": codingAgent,
	});
}

export const loaderHostModulesTestHooks = { loadOptionalAtomicNatives };

/** Live host modules shared with single-file builds and transformed extension reloads. */
export async function getVirtualModules(): Promise<Record<string, object>> {
	if (virtualModules) return virtualModules;
	virtualModulesPromise ??= loadVirtualModules().then(
		(modules) => {
			virtualModules = modules;
			return modules;
		},
		(error: Error) => {
			virtualModulesPromise = null;
			throw error;
		},
	);
	return virtualModulesPromise;
}

/**
 * Live host modules for storage adapter modules. Outside single-file builds `@bastani/atomic` resolves lazily through
 * the extension aliases instead, so a process that needs only storage, such as the Intercom broker, never evaluates
 * the whole host package.
 */
export async function getStorageAdapterHostModules(): Promise<Record<string, object>> {
	const storage = await import("../storage/index.js");
	if (!(isBunBinary || isBundledBuild)) return { "@bastani/atomic/storage": storage };
	return { "@bastani/atomic": await import("../../index.ts"), "@bastani/atomic/storage": storage };
}
