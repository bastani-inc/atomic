import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import type { GitSource } from "../utils/git.ts";
import { resolvePath as resolveAbsolutePath } from "../utils/paths.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import { getCommandEnv } from "./package-manager-env.ts";
import { getLocalGitUpdateTarget as getLocalGitUpdateTargetFromContext } from "./package-manager-git.ts";
import {
	getGitInstallPath as getGitInstallPathFromContext,
} from "./package-manager-paths.ts";
import {
	getGlobalNpmRoot as getGlobalNpmRootFromContext,
	getLatestNpmVersion as getLatestNpmVersionFromContext,
} from "./package-manager-npm.ts";
import {
	checkForAvailableUpdates as checkForAvailableUpdatesFromContext,
	install as installFromContext,
	installParsedSource as installParsedSourceFromContext,
	remove as removeFromContext,
	update as updateFromContext,
} from "./package-manager-operations.ts";
import {
	resolveExtensionSources as resolveExtensionSourcesFromContext,
	resolvePackages,
} from "./package-manager-resolver.ts";
import {
	addSourceToSettings as addSourceToSettingsInContext,
	getInstalledPath as getInstalledPathFromContext,
	listConfiguredPackages as listConfiguredPackagesFromContext,
	removeSourceFromSettings as removeSourceFromSettingsInContext,
} from "./package-manager-settings.ts";
import {
	getPackageIdentity as getPackageIdentityFromContext,
	parseSource as parsePackageSource,
} from "./package-manager-source.ts";
import {
	gitHasAvailableUpdate as gitHasAvailableUpdateFromContext,
	refreshTemporaryGitSource as refreshTemporaryGitSourceFromContext,
	updateGit as updateGitFromContext,
} from "./package-manager-git.ts";
import type {
	ConfiguredPackage,
	GitUpdateTargetInfo,
	MissingSourceAction,
	PackageManager,
	PackageManagerContext,
	PackageManagerOptions,
	PackageUpdate,
	ParsedSource,
	ProgressCallback,
	ResolvedPaths,
	ResolveExtensionSourcesOptions,
	SourceScope,
} from "./package-manager-types.ts";
import type { PackageSource } from "./settings-manager.ts";

export type {
	ConfiguredPackage,
	MissingSourceAction,
	PackageManager,
	PackageManagerOptions,
	PackageUpdate,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
	ResolveExtensionSourcesOptions,
} from "./package-manager-types.ts";

export class DefaultPackageManager implements PackageManager {
	private readonly context: PackageManagerContext;

	constructor(options: PackageManagerOptions) {
		this.context = {
			cwd: resolveAbsolutePath(options.cwd),
			agentDir: resolveAbsolutePath(options.agentDir),
			settingsManager: options.settingsManager,
		};
		this.context.driver = {
			runCommand: (command, args, runOptions) => this.runCommand(command, args, runOptions),
			runCommandCapture: (command, args, runOptions) => this.runCommandCapture(command, args, runOptions),
			runCommandSync: (command, args) => this.runCommandSync(command, args),
			installParsedSource: (parsed, scope) => this.installParsedSource(parsed, scope),
			updateGit: (source, scope) => this.updateGit(source, scope),
			gitHasAvailableUpdate: (installedPath) => this.gitHasAvailableUpdate(installedPath),
			refreshTemporaryGitSource: (source, sourceStr) => this.refreshTemporaryGitSource(source, sourceStr),
			getLocalGitUpdateTarget: (installedPath) => this.getLocalGitUpdateTarget(installedPath),
			getGlobalNpmRoot: () => this.getGlobalNpmRoot(),
			parseSource: (source) => this.parseSource(source),
			getPackageIdentity: (source, scope) => this.getPackageIdentity(source, scope),
			getGitInstallPath: (source, scope) => this.getGitInstallPath(source, scope),
			getLatestNpmVersion: (packageSpec, range) => this.getLatestNpmVersion(packageSpec, range),
		};
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.context.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		return addSourceToSettingsInContext(this.context, source, options);
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		return removeSourceFromSettingsInContext(this.context, source, options);
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		return getInstalledPathFromContext(this.context, source, scope);
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		return resolvePackages(this.context, onMissing);
	}

	async resolveExtensionSources(
		sources: PackageSource[],
		options?: ResolveExtensionSourcesOptions,
	): Promise<ResolvedPaths> {
		return resolveExtensionSourcesFromContext(this.context, sources, options);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		return listConfiguredPackagesFromContext(this.context);
	}

	async install(source: string, options?: { local?: boolean }): Promise<void> {
		await installFromContext(this.context, source, options);
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		await removeFromContext(this.context, source, options);
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	async update(source?: string): Promise<void> {
		await updateFromContext(this.context, source);
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		return checkForAvailableUpdatesFromContext(this.context);
	}

	private parseSource(source: string): ParsedSource {
		return parsePackageSource(source);
	}

	private getPackageIdentity(source: string, scope?: SourceScope): string {
		return getPackageIdentityFromContext(this.context, source, scope);
	}

	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		return getGitInstallPathFromContext(this.context, source, scope);
	}

	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		await installParsedSourceFromContext(this.context, parsed, scope);
	}

	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		await updateGitFromContext(this.context, source, scope);
	}

	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		return gitHasAvailableUpdateFromContext(this.context, installedPath);
	}

	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void> {
		await refreshTemporaryGitSourceFromContext(this.context, source, sourceStr);
	}

	private async getLocalGitUpdateTarget(installedPath: string): Promise<GitUpdateTargetInfo> {
		return getLocalGitUpdateTargetFromContext(this.context, installedPath);
	}

	private getGlobalNpmRoot(): string {
		return getGlobalNpmRootFromContext(this.context);
	}

	private async getLatestNpmVersion(packageSpec: string, range?: string): Promise<string> {
		return getLatestNpmVersionFromContext(this.context, packageSpec, range);
	}

	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env: getCommandEnv(command),
		});
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: getCommandEnv(command, options?.env),
		});
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	private runCommandSync(command: string, args: string[]): string {
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env: getCommandEnv(command),
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
