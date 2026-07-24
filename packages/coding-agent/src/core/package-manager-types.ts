import type { GitSource } from "../utils/git.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";

export type ResourceConfigurationOrigin = "atomic" | "inherited-pi" | "bundled";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	configurationOrigin?: ResourceConfigurationOrigin;
	/** True for project-local resources borrowed from an explicit temporary extension source. */
	borrowedProjectLocal?: true;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
	workflows: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";

export interface ProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: Exclude<SourceScope, "temporary">;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveExtensionSources(sources: PackageSource[], options?: ResolveExtensionSourcesOptions): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

export interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

export interface GitUpdateTargetInfo {
	ref: string;
	head: string;
	fetchArgs: string[];
}

export interface PackageManagerDriver {
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
	runCommandSync(command: string, args: string[]): string;
	installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void>;
	updateGit(source: GitSource, scope: SourceScope): Promise<void>;
	gitHasAvailableUpdate(installedPath: string): Promise<boolean>;
	refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void>;
	getLocalGitUpdateTarget(installedPath: string): Promise<GitUpdateTargetInfo>;
	getGlobalNpmRoot(): string;
	parseSource(source: string): ParsedSource;
	getPackageIdentity(source: string, scope?: SourceScope): string;
	getGitInstallPath(source: GitSource, scope: SourceScope): string;
	getLatestNpmVersion(packageSpec: string, range?: string): Promise<string>;
}

export interface PackageManagerContext {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	globalNpmRoot?: string;
	globalNpmRootCommandKey?: string;
	progressCallback?: ProgressCallback;
	driver?: PackageManagerDriver;
}

export type SourceScope = "user" | "project" | "temporary";

export type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	range?: string;
	pinned: boolean;
};

export type LocalSource = {
	type: "local";
	path: string;
};

export type ParsedSource = NpmSource | GitSource | LocalSource;

export type InstalledSourceScope = Exclude<SourceScope, "temporary">;

export interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

export interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

export interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

export interface PiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	workflows?: string[];
	workflow?: string[];
}

export type ResourceType = "extensions" | "skills" | "prompts" | "themes" | "workflows";

export const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes", "workflows"];

export const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
	workflows: /\.(ts|js|mjs|cjs)$/,
};

export type ResourceEntry = { metadata: PathMetadata; enabled: boolean };
export type ResourceMap = Map<string, ResourceEntry>;

export interface ResourceAccumulator {
	extensions: ResourceMap;
	skills: ResourceMap;
	prompts: ResourceMap;
	themes: ResourceMap;
	workflows: ResourceMap;
}

export interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	workflows?: string[];
}

export interface ResolveExtensionSourcesOptions {
	local?: boolean;
	temporary?: boolean;
	includeProjectLocalResources?: boolean;
}
