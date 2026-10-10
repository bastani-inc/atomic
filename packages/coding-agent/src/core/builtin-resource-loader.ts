import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { getAllBuiltinPackageLocations, getBuiltinPackageLocations } from "./builtin-packages.ts";
import { getExtensionRuntimeEventBus, instantiateExtensions, loadExtensions } from "./extensions/loader.ts";
import type { LoadExtensionsResult } from "./extensions/types.ts";
import { markTrustedMandatoryRuntimeExtension } from "./mandatory-runtime-tools.ts";
import { DefaultPackageManager, type ResolvedResource } from "./package-manager.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import type {
	ResourceExtensionPaths,
	ResourceLoader,
	ResourceLoaderReloadOptions,
	ResourceLoaderReloadTransaction,
} from "./resource-loader-types.ts";
import type { AtomicBuiltin } from "./sdk-types.ts";
import { lifecycleScopeForOwner, sessionLifecycleCreation, sessionLifecycleScopes } from "./session-lifecycle-scope.ts";
import { SettingsManager } from "./settings-manager.ts";
import { buildSkillCatalog } from "./skill-catalog.ts";
import { BUILTIN_PATH_PREFIX } from "./source-info.ts";

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Adds shipped resources without changing the caller's loader or its discovery options. */
class BuiltinResourceLoader implements ResourceLoader {
	private extensions!: LoadExtensionsResult;
	private assets: DefaultResourceLoader;
	private readonly delegate: ResourceLoader;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly builtins: Partial<Record<AtomicBuiltin, boolean>>;
	private readonly disabledRoots: string[];
	private readonly disableWorkflowExtension: boolean;
	private readonly ownsDiscovery: boolean;
	private isDisabledPath(path: string): boolean {
		return this.disabledRoots.some((root) => {
			const child = relative(root, canonical(path));
			return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
		});
	}
	constructor(
		delegate: ResourceLoader,
		cwd: string,
		agentDir: string,
		builtins?: Partial<Record<AtomicBuiltin, boolean>>,
		disableWorkflowExtension = false,
		ownsDiscovery?: boolean,
	) {
		const scope = sessionLifecycleCreation.getStore()?.scope;
		this.ownsDiscovery =
			ownsDiscovery ??
			(scope !== undefined && sessionLifecycleScopes.get(delegate.getExtensions().runtime) === scope);
		this.disableWorkflowExtension = disableWorkflowExtension;
		this.delegate = delegate;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.builtins = {};
		for (const name of ["workflows", "subagents", "mcp", "web-access", "intercom"] as const) {
			if (builtins && name in builtins) this.builtins[name] = builtins[name];
		}
		this.disabledRoots = getAllBuiltinPackageLocations()
			.filter((location) => this.builtins[location.distDirName] === false)
			.map((location) => canonical(location.packageDir));
		this.assets = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
	}
	async initialize(): Promise<void> {
		const locations = getBuiltinPackageLocations(true, this.builtins);
		const discovered = this.delegate.getExtensions();
		const scope = lifecycleScopeForOwner(this);
		const identities = new Set<string>();
		const inlineBuiltinPaths = new Set<string>();
		const selected = discovered.extensions.filter((extension) => {
			if (extension.path.startsWith(BUILTIN_PATH_PREFIX)) {
				if (inlineBuiltinPaths.has(extension.path)) return false;
				inlineBuiltinPaths.add(extension.path);
				return true;
			}
			if (this.isDisabledPath(extension.resolvedPath)) return false;
			const path = canonical(extension.resolvedPath);
			const builtin = locations.find((location) => {
				const child = relative(canonical(location.packageDir), path);
				return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
			});
			if (!builtin) return true;
			if (this.disableWorkflowExtension && builtin.distDirName === "workflows") return false;
			if (identities.has(builtin.packageName)) return false;
			identities.add(builtin.packageName);
			return true;
		});
		const discovery = { ...discovered, extensions: selected };
		const target =
			sessionLifecycleScopes.get(discovered.runtime) === scope
				? discovery
				: await sessionLifecycleCreation.run({ scope, claimed: true }, () =>
						instantiateExtensions(discovery, this.cwd),
					);
		const manager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		const resources = await manager.resolveExtensionSources(
			locations.map((location) => location.packageDir),
			{ temporary: true },
		);
		const paths = resources.extensions.filter(
			(resource) =>
				resource.enabled &&
				!locations.some(
					(location) =>
						(identities.has(location.packageName) ||
							(this.disableWorkflowExtension && location.distDirName === "workflows")) &&
						canonical(resource.path).startsWith(`${canonical(location.packageDir)}${sep}`),
				),
		);
		const mergeWorkflows = (caller: ResolvedResource[]) => {
			const workflows = new Map<string, ResolvedResource>();
			for (const resource of [...resources.workflows, ...caller]) {
				if (!this.isDisabledPath(resource.path)) workflows.set(canonical(resource.path), resource);
			}
			return [...workflows.values()];
		};
		const loaded = await loadExtensions(
			paths.map((resource) => resource.path),
			this.cwd,
			getExtensionRuntimeEventBus(target.runtime),
			{
				get: () => mergeWorkflows(this.delegate.getWorkflowResources?.() ?? []),
				refresh: async () =>
					mergeWorkflows(
						(await this.delegate.refreshWorkflowResources?.()) ?? this.delegate.getWorkflowResources?.() ?? [],
					),
				getMcpServers: () => this.delegate.getMcpServerContributions?.() ?? [],
			},
			target.runtime,
			() => this.delegate.getInheritanceSnapshot?.() ?? {},
		);
		for (const extension of loaded.extensions) markTrustedMandatoryRuntimeExtension(extension);
		this.extensions = {
			...target,
			extensions: [...target.extensions, ...loaded.extensions],
			errors: [...target.errors, ...loaded.errors],
		};
		const entries = (items: ResolvedResource[]) =>
			items
				.filter((item) => item.enabled)
				.map((item) => ({
					path: item.path,
					metadata: { ...item.metadata, configurationOrigin: "bundled" as const },
				}));
		await this.assets.extendResources({
			skillPaths: entries(resources.skills),
			promptPaths: entries(resources.prompts),
			themePaths: entries(resources.themes),
		});
	}
	getExtensions() {
		return this.extensions;
	}
	getSkills(): ReturnType<ResourceLoader["getSkills"]> {
		const caller = this.delegate.getSkills();
		const builtin = this.assets.getSkills();
		const skills = caller.skills.filter((skill) => !this.isDisabledPath(skill.filePath));
		const paths = new Set(skills.map((skill) => canonical(skill.filePath)));
		return {
			skills: [...skills, ...builtin.skills.filter((skill) => !paths.has(canonical(skill.filePath)))],
			diagnostics: [...caller.diagnostics, ...builtin.diagnostics],
		};
	}
	getSkillCatalog() {
		return buildSkillCatalog(this.getSkills().skills);
	}
	getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
		const caller = this.delegate.getPrompts();
		const builtin = this.assets.getPrompts();
		const prompts = caller.prompts.filter((prompt) => !this.isDisabledPath(prompt.filePath));
		const paths = new Set(prompts.map((prompt) => canonical(prompt.filePath)));
		return {
			prompts: [...prompts, ...builtin.prompts.filter((prompt) => !paths.has(canonical(prompt.filePath)))],
			diagnostics: [...caller.diagnostics, ...builtin.diagnostics],
		};
	}
	getThemes(): ReturnType<ResourceLoader["getThemes"]> {
		const caller = this.delegate.getThemes();
		const builtin = this.assets.getThemes();
		return {
			themes: [
				...caller.themes.filter((theme) => !theme.sourcePath || !this.isDisabledPath(theme.sourcePath)),
				...builtin.themes,
			],
			diagnostics: [...caller.diagnostics, ...builtin.diagnostics],
		};
	}
	getAgentsFiles() {
		return this.delegate.getAgentsFiles();
	}
	getSystemPrompt() {
		return this.delegate.getSystemPrompt();
	}
	getSystemPromptSource() {
		return this.delegate.getSystemPromptSource();
	}
	getAppendSystemPrompt() {
		return this.delegate.getAppendSystemPrompt();
	}
	getAppendSystemPromptSources() {
		return this.delegate.getAppendSystemPromptSources();
	}
	async extendResources(paths: ResourceExtensionPaths): Promise<void> {
		const bundled: ResourceExtensionPaths = {};
		const caller: ResourceExtensionPaths = {};
		for (const kind of ["skillPaths", "promptPaths", "themePaths"] as const) {
			bundled[kind] = paths[kind]?.filter(
				(entry) => !this.isDisabledPath(entry.path) && entry.metadata.configurationOrigin === "bundled",
			);
			caller[kind] = paths[kind]?.filter(
				(entry) => !this.isDisabledPath(entry.path) && entry.metadata.configurationOrigin !== "bundled",
			);
		}
		if (this.ownsDiscovery) {
			await this.delegate.extendResources(caller);
		} else {
			// Extension-discovered assets belong to this session, not borrowed discovery.
			for (const kind of ["skillPaths", "promptPaths", "themePaths"] as const) {
				bundled[kind] = [...(bundled[kind] ?? []), ...(caller[kind] ?? [])];
			}
		}
		await this.assets.extendResources(bundled);
	}
	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		await this.delegate.reload(options);
		this.assets = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: SettingsManager.inMemory(),
			noContextFiles: true,
		});
		await this.initialize();
	}
	supportsTransactionalReload(): boolean {
		return this.delegate.prepareReload !== undefined && this.delegate.supportsTransactionalReload?.() !== false;
	}
	async prepareReload(
		settings: SettingsManager,
		options?: ResourceLoaderReloadOptions,
	): Promise<ResourceLoaderReloadTransaction> {
		if (!this.delegate.prepareReload) throw new Error("Resource loader does not support transactional reload");
		const transaction = await this.delegate.prepareReload(settings, options);
		const candidate = new BuiltinResourceLoader(
			transaction.loader,
			this.cwd,
			this.agentDir,
			this.builtins,
			this.disableWorkflowExtension,
			true,
		);
		sessionLifecycleScopes.set(candidate, lifecycleScopeForOwner(this));
		await candidate.initialize();
		const publish = () => {
			this.extensions = candidate.extensions;
			this.assets = candidate.assets;
		};
		return {
			...transaction,
			loader: candidate,
			...(transaction.prepareCommit
				? {
						prepareCommit: () => {
							const prepared = transaction.prepareCommit!();
							return {
								commit: () => {
									prepared.commit();
									publish();
								},
								rollback: () => prepared.rollback(),
							};
						},
					}
				: {}),
			commit: () => {
				transaction.commit();
				publish();
			},
		};
	}
}

export async function withBuiltinResourceLoader(
	loader: ResourceLoader,
	cwd: string,
	agentDir: string,
	builtins?: Partial<Record<AtomicBuiltin, boolean>>,
	disableWorkflowExtension = false,
): Promise<ResourceLoader> {
	if (
		loader instanceof BuiltinResourceLoader &&
		builtins === undefined &&
		!disableWorkflowExtension &&
		sessionLifecycleScopes.get(loader) === sessionLifecycleCreation.getStore()?.scope
	)
		return loader;
	const composed = new BuiltinResourceLoader(loader, cwd, agentDir, builtins, disableWorkflowExtension);
	await composed.initialize();
	return composed;
}
