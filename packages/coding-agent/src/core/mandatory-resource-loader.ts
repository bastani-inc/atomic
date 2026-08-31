import { getMandatoryBuiltinExtensionPaths } from "./builtin-packages.ts";
import { getExtensionRuntimeEventBus, loadExtensions } from "./extensions/loader.ts";
import type { Extension, LoadExtensionsResult } from "./extensions/types.ts";
import { isTrustedMandatoryRuntimeTool, markTrustedMandatoryRuntimeExtension } from "./mandatory-runtime-tools.ts";
import type {
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
	ResourceLoaderReloadTransaction,
} from "./resource-loader-types.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { buildSkillCatalog } from "./skill-catalog.ts";

function hasTrustedIntercom(extension: Extension): boolean {
	const registration = extension.tools.get("intercom");
	return registration !== undefined && isTrustedMandatoryRuntimeTool(registration);
}

async function restoreMandatoryExtensions(target: LoadExtensionsResult, cwd: string): Promise<LoadExtensionsResult> {
	if (target.extensions.some(hasTrustedIntercom)) return target;

	const loaded = await loadExtensions(
		getMandatoryBuiltinExtensionPaths(),
		cwd,
		getExtensionRuntimeEventBus(target.runtime),
		undefined,
		target.runtime,
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
	private extensionsResult: LoadExtensionsResult;
	private toolOnly = false;

	constructor(delegate: ResourceLoader, cwd: string, extensionsResult: LoadExtensionsResult) {
		this.delegate = delegate;
		this.cwd = cwd;
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
		this.extensionsResult = await restoreMandatoryExtensions(this.delegate.getExtensions(), this.cwd);
		if (this.toolOnly) this.removeLocalInteractionSurfaces();
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
		const extensionsResult = await restoreMandatoryExtensions(delegateTransaction.loader.getExtensions(), this.cwd);
		const candidate = new MandatoryResourceLoader(delegateTransaction.loader, this.cwd, extensionsResult);
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

/** Preserve caller-owned resources while restoring Atomic's mandatory bundled extension. */
export async function withMandatoryResourceLoader(loader: ResourceLoader, cwd: string): Promise<ResourceLoader> {
	if (loader instanceof MandatoryResourceLoader) return loader;
	const extensionsResult = await restoreMandatoryExtensions(loader.getExtensions(), cwd);
	return new MandatoryResourceLoader(loader, cwd, extensionsResult);
}

/** Keep a non-model interactive host from shadowing the engine's command and shortcut proxies. */
export function limitMandatoryIntercomToTool(loader: ResourceLoader): void {
	if (loader instanceof MandatoryResourceLoader) loader.limitToTool();
}
