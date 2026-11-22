import { getMandatoryBuiltinExtensionPaths } from "./builtin-packages.ts";
import { getExtensionRuntimeEventBus, instantiateExtensions, loadExtensions } from "./extensions/loader.ts";
import type { Extension, LoadExtensionsResult } from "./extensions/types.ts";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "./mandatory-runtime-tools.ts";
import { canCloneDefaultResourceDiscovery } from "./resource-loader.ts";
import type { DeferredStartupSettingsSnapshot } from "./resource-loader-internals.ts";
import type {
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
	ResourceLoaderReloadTransaction,
} from "./resource-loader-types.ts";
import type { AtomicBuiltin } from "./sdk-types.ts";
import { sessionLifecycleCreation, sessionLifecycleScopes } from "./session-lifecycle-scope.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { buildSkillCatalog } from "./skill-catalog.ts";

function hasTrustedIntercom(extension: Extension): boolean {
	const registration = extension.tools.get("intercom");
	return registration !== undefined && isTrustedMandatoryRuntimeTool(registration);
}

async function restoreMandatoryExtensions(
	target: LoadExtensionsResult,
	cwd: string,
	agentDir: string | undefined,
): Promise<LoadExtensionsResult> {
	if (target.extensions.some(hasTrustedIntercom)) return target;

	const loaded = await loadExtensions(
		getMandatoryBuiltinExtensionPaths(),
		cwd,
		getExtensionRuntimeEventBus(target.runtime),
		undefined,
		target.runtime,
		undefined,
		agentDir,
	);
	for (const extension of loaded.extensions) markTrustedMandatoryRuntimeExtension(extension);
	const restored: LoadExtensionsResult = {
		...target,
		extensions: [...target.extensions, ...loaded.extensions],
		errors: [...target.errors, ...loaded.errors],
	};
	if (!restored.extensions.some(hasTrustedIntercom)) {
		const detail = loaded.errors.map(({ error }) => error).join("; ") || "extension did not register intercom";
		throw new Error(`Mandatory bundled Intercom is unavailable: ${detail}`);
	}
	return restored;
}

class MandatoryResourceLoader implements ResourceLoader {
	private delegate: ResourceLoader;
	private readonly cwd: string;
	private readonly agentDir: string | undefined;
	private extensionsResult: LoadExtensionsResult;
	private toolOnly = false;

	constructor(
		delegate: ResourceLoader,
		cwd: string,
		extensionsResult: LoadExtensionsResult,
		agentDir: string | undefined,
	) {
		this.delegate = delegate;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.extensionsResult = extensionsResult;
	}

	limitToTool(): void {
		this.toolOnly = true;
		this.removeLocalInteractionSurfaces();
	}

	private removeLocalInteractionSurfaces(): void {
		const extension = this.extensionsResult.extensions.find(hasTrustedIntercom);
		extension?.commands.delete("intercom");
		extension?.shortcuts.delete("alt+m");
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getInheritanceSnapshot() {
		return this.delegate.getInheritanceSnapshot?.() ?? {};
	}

	getLegacyWorkflowFiles() {
		return this.delegate.getLegacyWorkflowFiles?.();
	}

	getPackageAgents() {
		return this.delegate.getPackageAgents?.() ?? [];
	}

	getMcpServerContributions() {
		return this.delegate.getMcpServerContributions?.() ?? [];
	}

	async createSessionLoader(): Promise<ResourceLoader> {
		const scope = sessionLifecycleCreation.getStore()!.scope;
		if (sessionLifecycleScopes.get(this.extensionsResult.runtime) === scope) return this;
		const delegate = canCloneDefaultResourceDiscovery(this.delegate)
			? await this.delegate.createSessionLoader(scope)
			: this.delegate;
		const discovery =
			delegate === this.delegate
				? this.extensionsResult
				: await restoreMandatoryExtensions(delegate.getExtensions(), this.cwd, this.agentDir);
		const extensions =
			sessionLifecycleScopes.get(discovery.runtime) === scope
				? discovery
				: await instantiateExtensions(discovery, this.cwd);
		const candidate = new MandatoryResourceLoader(delegate, this.cwd, extensions, this.agentDir);
		if (this.toolOnly) candidate.limitToTool();
		return candidate;
	}

	getSkills(): ReturnType<ResourceLoader["getSkills"]> {
		return this.delegate.getSkills();
	}

	getSkillCatalog(): ReturnType<NonNullable<ResourceLoader["getSkillCatalog"]>> {
		return this.delegate.getSkillCatalog?.() ?? buildSkillCatalog(this.delegate.getSkills().skills);
	}

	getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
		return this.delegate.getPrompts();
	}

	getThemes(): ReturnType<ResourceLoader["getThemes"]> {
		return this.delegate.getThemes();
	}

	getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
		return this.delegate.getAgentsFiles();
	}

	getSystemPrompt(): ReturnType<ResourceLoader["getSystemPrompt"]> {
		return this.delegate.getSystemPrompt();
	}

	getSystemPromptSource(): ReturnType<ResourceLoader["getSystemPromptSource"]> {
		return this.delegate.getSystemPromptSource();
	}

	getAppendSystemPrompt(): ReturnType<ResourceLoader["getAppendSystemPrompt"]> {
		return this.delegate.getAppendSystemPrompt();
	}

	getAppendSystemPromptSources(): ReturnType<ResourceLoader["getAppendSystemPromptSources"]> {
		return this.delegate.getAppendSystemPromptSources();
	}

	extendResources(paths: ResourceExtensionPaths): Promise<void> {
		return this.delegate.extendResources(paths);
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		await this.delegate.reload(options);
		this.extensionsResult = await restoreMandatoryExtensions(this.delegate.getExtensions(), this.cwd, this.agentDir);
		if (this.toolOnly) this.removeLocalInteractionSurfaces();
	}

	coversBuiltinSelection(builtins: Partial<Record<AtomicBuiltin, boolean>> | undefined): boolean {
		return canCloneDefaultResourceDiscovery(this.delegate) && this.delegate.coversBuiltinSelection(builtins);
	}

	canPrepareDeferredStartupCompletion(): boolean {
		return (
			!this.toolOnly && canCloneDefaultResourceDiscovery(this.delegate) && this.delegate.canCompleteDeferredStartup()
		);
	}

	getDeferredInitialSettingsSnapshot(): DeferredStartupSettingsSnapshot | undefined {
		return canCloneDefaultResourceDiscovery(this.delegate)
			? this.delegate.getDeferredInitialSettingsSnapshot()
			: undefined;
	}

	async prepareDeferredStartupCompletion(
		settingsManager: SettingsManager,
	): Promise<
		ResourceLoaderReloadTransaction & { rollback(): void; readonly unregisteredProviders: ReadonlySet<string> }
	> {
		if (!canCloneDefaultResourceDiscovery(this.delegate)) {
			throw new Error("Resource loader does not support deferred startup completion");
		}
		const delegateTransaction = await this.delegate.prepareDeferredStartupCompletion(
			settingsManager,
			this.extensionsResult,
		);
		const delegateExtensions = delegateTransaction.loader.getExtensions();
		let extensionsResult: LoadExtensionsResult;
		if (delegateExtensions.extensions.some(hasTrustedIntercom)) {
			extensionsResult = delegateExtensions;
		} else {
			const existingIntercom = this.extensionsResult.extensions.find(hasTrustedIntercom);
			if (existingIntercom) {
				extensionsResult = {
					...delegateExtensions,
					extensions: [...delegateExtensions.extensions, existingIntercom],
				};
			} else {
				try {
					extensionsResult = await restoreMandatoryExtensions(delegateExtensions, this.cwd, this.agentDir);
				} catch (error) {
					delegateTransaction.rollback();
					throw error;
				}
			}
		}
		const candidate = new MandatoryResourceLoader(
			delegateTransaction.loader,
			this.cwd,
			extensionsResult,
			this.agentDir,
		);
		const prepareCommit = delegateTransaction.prepareCommit
			? () => {
					const delegateCommit = delegateTransaction.prepareCommit!();
					let settled = false;
					return {
						commit: () => {
							if (settled) return;
							settled = true;
							delegateCommit.commit();
							this.extensionsResult = candidate.extensionsResult;
						},
						rollback: () => {
							if (settled) return;
							settled = true;
							delegateCommit.rollback();
						},
					};
				}
			: undefined;
		return {
			loader: candidate,
			activate: (liveSettingsManager) => delegateTransaction.activate(liveSettingsManager),
			...(prepareCommit ? { prepareCommit } : {}),
			commit: () => {
				delegateTransaction.commit();
				this.extensionsResult = candidate.extensionsResult;
			},
			rollback: () => delegateTransaction.rollback(),
			unregisteredProviders: delegateTransaction.unregisteredProviders,
		};
	}

	supportsTransactionalReload(): boolean {
		return this.delegate.prepareReload !== undefined && this.delegate.supportsTransactionalReload?.() !== false;
	}

	async prepareReload(
		settingsManager: SettingsManager,
		options?: ResourceLoaderReloadOptions,
	): Promise<ResourceLoaderReloadTransaction> {
		if (!this.delegate.prepareReload) {
			throw new Error("Resource loader does not support transactional reload");
		}
		const delegateTransaction = await this.delegate.prepareReload(settingsManager, options);
		const extensionsResult = await restoreMandatoryExtensions(
			delegateTransaction.loader.getExtensions(),
			this.cwd,
			this.agentDir,
		);
		const candidate = new MandatoryResourceLoader(
			delegateTransaction.loader,
			this.cwd,
			extensionsResult,
			this.agentDir,
		);
		if (this.toolOnly) candidate.limitToTool();
		const prepareCommit = delegateTransaction.prepareCommit
			? () => {
					const delegateCommit = delegateTransaction.prepareCommit!();
					let settled = false;
					return {
						commit: () => {
							if (settled) return;
							settled = true;
							delegateCommit.commit();
							this.extensionsResult = candidate.extensionsResult;
						},
						rollback: () => {
							if (settled) return;
							settled = true;
							delegateCommit.rollback();
						},
					};
				}
			: undefined;
		return {
			loader: candidate,
			activate: (liveSettingsManager) => delegateTransaction.activate(liveSettingsManager),
			...(prepareCommit ? { prepareCommit } : {}),
			commit: () => {
				delegateTransaction.commit();
				this.extensionsResult = candidate.extensionsResult;
			},
		};
	}
}

/**
 * Preserve caller-owned resources while restoring Atomic's mandatory bundled extension. `agentDir` is the session's
 * agent directory, whose transpile cache the restored extension uses; it defaults to the one in effect at load time.
 */
export async function withMandatoryResourceLoader(
	loader: ResourceLoader,
	cwd: string,
	agentDir?: string,
): Promise<ResourceLoader> {
	if (loader instanceof MandatoryResourceLoader) return loader;
	const extensionsResult = await restoreMandatoryExtensions(loader.getExtensions(), cwd, agentDir);
	return new MandatoryResourceLoader(loader, cwd, extensionsResult, agentDir);
}

/** Keep a non-model interactive host from shadowing the engine's command and shortcut proxies. */
export function limitMandatoryIntercomToTool(loader: ResourceLoader): void {
	if (loader instanceof MandatoryResourceLoader) loader.limitToTool();
}

/** Services have already selected their resources, including deferred CLI startup. */
export function isMandatoryResourceLoader(loader: ResourceLoader): boolean {
	return loader instanceof MandatoryResourceLoader;
}

/** Whether a mandatory resource loader wraps a default loader whose builtin selection already satisfies `builtins`. */
export function mandatoryLoaderCoversBuiltins(
	loader: ResourceLoader,
	builtins: Partial<Record<AtomicBuiltin, boolean>> | undefined,
): boolean {
	return loader instanceof MandatoryResourceLoader && loader.coversBuiltinSelection(builtins);
}

/** Whether `loader` can complete an initial deferred startup load in place without reloading preloaded mandatory extensions. */
export function canPrepareDeferredStartupCompletion(loader: ResourceLoader): boolean {
	return loader instanceof MandatoryResourceLoader && loader.canPrepareDeferredStartupCompletion();
}

/** Settings and trust snapshot captured at the initial deferred load, if `loader` supports in-place completion. */
export function getDeferredInitialSettingsSnapshot(
	loader: ResourceLoader,
): DeferredStartupSettingsSnapshot | undefined {
	return loader instanceof MandatoryResourceLoader ? loader.getDeferredInitialSettingsSnapshot() : undefined;
}

/** Prepare an in-place deferred startup completion for a mandatory loader wrapping a deferred default loader. */
export function prepareDeferredStartupCompletion(
	loader: ResourceLoader,
	settingsManager: SettingsManager,
): Promise<
	ResourceLoaderReloadTransaction & { rollback(): void; readonly unregisteredProviders: ReadonlySet<string> }
> {
	if (!(loader instanceof MandatoryResourceLoader)) {
		throw new Error("Resource loader does not support deferred startup completion");
	}
	return loader.prepareDeferredStartupCompletion(settingsManager);
}

/** Service discovery is borrowed too, including deferred CLI generations. */
export function isolateMandatoryResourceLoader(loader: ResourceLoader): Promise<ResourceLoader> {
	return loader instanceof MandatoryResourceLoader ? loader.createSessionLoader() : Promise.resolve(loader);
}
