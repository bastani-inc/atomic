import { join } from "node:path";
import type { LoadExtensionsResult } from "../../src/core/extensions/types.js";
import { ModelRuntime } from "../../src/core/model-runtime.js";
import type { ResourceLoader } from "../../src/core/resource-loader.js";
import { type CreateAgentSessionResult, createAgentSession } from "../../src/core/sdk.js";
import type { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

export interface WidgetReloadLoaderOptions {
	loaded: LoadExtensionsResult;
	load: () => Promise<LoadExtensionsResult>;
	beforePrepareCommit?: () => void;
	onCommit?: () => void;
}

/**
 * Transactional test loader for widget-reload suites.
 * Callers keep hosts, factories, timers, and assertions; this only owns
 * candidate load and prepareCommit.
 */
export function createWidgetReloadResourceLoader(options: WidgetReloadLoaderOptions): ResourceLoader {
	let loaded = options.loaded;
	return {
		...createTestResourceLoader({ extensionsResult: loaded }),
		getExtensions: () => loaded,
		prepareReload: async () => {
			const candidate = await options.load();
			return {
				loader: createTestResourceLoader({ extensionsResult: candidate }),
				activate() {},
				prepareCommit() {
					options.beforePrepareCommit?.();
					return {
						commit() {
							loaded = candidate;
							options.onCommit?.();
						},
						rollback() {},
					};
				},
				commit() {}, // unreachable: prepareCommit is always present
			};
		},
	};
}

export interface WidgetReloadSessionOptions {
	dir: string;
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	modelRuntime?: ModelRuntime;
}

export async function createWidgetReloadSession(
	options: WidgetReloadSessionOptions,
): Promise<CreateAgentSessionResult> {
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({ modelsPath: null, authPath: join(options.dir, "auth.json") }));
	return createAgentSession({
		cwd: options.dir,
		agentDir: options.dir,
		resourceLoader: options.resourceLoader,
		modelRuntime,
		sessionManager: options.sessionManager,
		settingsManager: SettingsManager.inMemory(),
		noTools: "all",
	});
}
