import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { APP_NAME, getProjectConfigDirs } from "../config.js";
import type { GitSource } from "../utils/git.ts";
import { isGitProvisionError } from "../utils/git-errors.ts";
import { stripBom } from "../utils/text.ts";
import { getToolEnv, getToolPath } from "../utils/tools-manager.ts";
import { runCommand, runCommandCapture } from "./package-manager-command.ts";
import { NETWORK_TIMEOUT_MS } from "./package-manager-constants.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import { ensureGitIgnore, getGitDependencyInstallArgs, runNpmCommand } from "./package-manager-npm.ts";
import { getBaseDirsForScope, getGitInstallPath, getGitInstallRoot } from "./package-manager-paths.ts";
import { emitProgress, withProgress } from "./package-manager-progress.ts";
import type {
	GitUpdateTargetInfo,
	PackageLocationContext,
	PackageManagerContext,
	SourceScope,
} from "./package-manager-types.ts";

/** A failure to provide git is never a best-effort miss: callers see it, with its code and install command. */
function rethrowGitProvisionError(error: unknown): void {
	if (isGitProvisionError(error)) throw error;
}

/** The resolved git and, for a provisioned copy, the portable variables it needs. */
async function resolveGitCommand(): Promise<{ readonly path: string; readonly env?: Record<string, string> }> {
	const [path, env] = await Promise.all([getToolPath("git"), getToolEnv("git")]);
	return Object.keys(env).length === 0 ? { path } : { path, env };
}

async function runGitProcess(
	context: PackageManagerContext,
	args: string[],
	options?: { cwd?: string },
): Promise<void> {
	const git = await resolveGitCommand();
	const gitOptions = git.env === undefined ? options : { ...options, env: git.env };
	return context.driver
		? context.driver.runCommand(git.path, args, gitOptions)
		: runCommand(git.path, args, gitOptions);
}

async function captureGitProcess(
	context: PackageManagerContext,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<string> {
	const git = await resolveGitCommand();
	const gitOptions = git.env === undefined ? options : { ...options, env: { ...git.env, ...options.env } };
	return context.driver
		? context.driver.runCommandCapture(git.path, args, gitOptions)
		: runCommandCapture(git.path, args, gitOptions);
}

function getSafeGitRef(ref: string): string {
	if (!isSafeGitRef(ref)) {
		throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`);
	}
	return ref;
}

function isSafeGitRef(ref: string): boolean {
	if (!ref || ref === "@" || ref.startsWith("-") || ref.endsWith(".") || ref.endsWith("/")) {
		return false;
	}
	if (/[\x00-\x1f\x7f\s~^:?*[\]\\]/u.test(ref)) {
		return false;
	}
	if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) {
		return false;
	}
	return ref
		.split("/")
		.every((part) => part && part !== "." && part !== ".." && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function getExistingGitInstallPath(
	context: PackageLocationContext,
	source: GitSource,
	scope: SourceScope,
): string | undefined {
	const candidates = [getGitInstallPath(context, source, scope)];
	if (scope === "project") {
		for (const configDir of getProjectConfigDirs(context.cwd)) {
			candidates.push(join(configDir, "git", source.host, source.path));
		}
	} else if (scope === "user") {
		for (const agentDir of getBaseDirsForScope(context, "user")) {
			candidates.push(join(agentDir, "git", source.host, source.path));
		}
	}
	for (const candidate of Array.from(new Set(candidates))) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function getGitUpdateMarkerPath(targetDir: string): string {
	return join(dirname(targetDir), `.${basename(targetDir)}.${APP_NAME}-update-incomplete`);
}

function hasMissingGitDependencies(targetDir: string): boolean {
	const packageJsonPath = join(targetDir, "package.json");
	if (!existsSync(packageJsonPath)) return false;
	try {
		const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
		if (!manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies)) {
			return false;
		}
		const nodeModulesDir = resolve(targetDir, "node_modules");
		return Object.keys(manifest.dependencies).some((name) => {
			const dependencyPath = resolve(nodeModulesDir, name);
			if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
			return !existsSync(dependencyPath);
		});
	} catch {
		return false;
	}
}

async function repairMissingGitDependencies(context: PackageManagerContext, targetDir: string): Promise<void> {
	if (!hasMissingGitDependencies(targetDir)) return;
	await runNpmCommand(context, getGitDependencyInstallArgs(context), { cwd: targetDir });
}

async function cleanAndInstallGitDependencies(
	context: PackageManagerContext,
	targetDir: string,
	markerPath: string,
): Promise<void> {
	// Clean untracked files (extensions should be pristine). On Windows, files loaded by
	// another process (e.g. a native module of this extension in another session) cannot
	// be deleted, so git clean fails. Still install dependencies for the new commit, but keep
	// the marker so the next update retries the clean.
	let cleaned = true;
	try {
		await runGitProcess(context, ["clean", "-fdx"], { cwd: targetDir });
	} catch (error) {
		rethrowGitProvisionError(error);
		cleaned = false;
		const reason = error instanceof Error ? error.message : String(error);
		emitProgress(context, {
			type: "progress",
			action: "update",
			source: targetDir,
			message: `Could not remove all untracked files in ${targetDir} (${reason}). Files may be in use by another ${APP_NAME} session; close it and run the update again.`,
		});
	}
	if (existsSync(join(targetDir, "package.json"))) {
		await runNpmCommand(context, getGitDependencyInstallArgs(context), { cwd: targetDir });
	}
	if (cleaned) rmSync(markerPath, { force: true });
}

export async function installGit(context: PackageManagerContext, source: GitSource, scope: SourceScope): Promise<void> {
	const safeRef = source.ref ? getSafeGitRef(source.ref) : undefined;
	const targetDir = getGitInstallPath(context, source, scope);
	if (existsSync(targetDir)) {
		if (safeRef) {
			await ensureGitRef(context, targetDir, ["fetch", "origin", "--", safeRef], "FETCH_HEAD");
			return;
		}
		const target = context.driver
			? await context.driver.getLocalGitUpdateTarget(targetDir)
			: await getLocalGitUpdateTarget(context, targetDir);
		await ensureGitRef(context, targetDir, target.fetchArgs, target.ref);
		return;
	}
	const gitRoot = getGitInstallRoot(context, scope);
	if (gitRoot) {
		ensureGitIgnore(gitRoot);
	}
	mkdirSync(dirname(targetDir), { recursive: true });
	rmSync(getGitUpdateMarkerPath(targetDir), { force: true });

	// Defense-in-depth: the clone URL is already parsed/validated upstream, but
	// assert it contains only shell-safe characters immediately before it reaches
	// `git clone`, so no metacharacter can ever reach a shell even on platforms
	// that wrap process spawns. Capture the validated value in a local so the
	// guard sanitizes exactly the binding handed to the spawn.
	const cloneUrl = source.repo;
	if (!/^[A-Za-z0-9._~:@/%+-]+$/.test(cloneUrl)) {
		throw new Error(`Refusing to clone repository with unsafe URL: ${cloneUrl}`);
	}
	try {
		await runGitProcess(context, ["clone", "--", cloneUrl, targetDir]);
		if (safeRef) {
			await runGitProcess(context, ["checkout", safeRef], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await runNpmCommand(context, getGitDependencyInstallArgs(context), { cwd: targetDir });
		}
	} catch (error) {
		// A half-written clone would otherwise be treated as installed by the
		// `existsSync(targetDir)` check above, so the next install silently skips
		// the repair. Remove it, then drop the now-empty host/owner directories.
		rmSync(targetDir, { recursive: true, force: true });
		pruneEmptyGitParents(targetDir, gitRoot);
		throw error;
	}
}

/** The checked-out commit of an installed git package, or undefined when it is not installed or unreadable. */
export async function getInstalledGitHead(
	context: PackageManagerContext,
	source: GitSource,
	scope: SourceScope,
): Promise<string | undefined> {
	const targetDir = getExistingGitInstallPath(context, source, scope) ?? getGitInstallPath(context, source, scope);
	if (!existsSync(targetDir)) return undefined;
	try {
		const head = await captureGitProcess(context, ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return head.trim() || undefined;
	} catch (error) {
		rethrowGitProvisionError(error);
		return undefined;
	}
}

export async function updateGit(context: PackageManagerContext, source: GitSource, scope: SourceScope): Promise<void> {
	const safeRef = source.ref ? getSafeGitRef(source.ref) : undefined;
	const targetDir = getExistingGitInstallPath(context, source, scope) ?? getGitInstallPath(context, source, scope);
	if (!existsSync(targetDir)) {
		await installGit(context, source, scope);
		return;
	}
	if (safeRef) {
		await ensureGitRef(context, targetDir, ["fetch", "origin", "--", safeRef], "FETCH_HEAD");
		return;
	}
	const target = context.driver
		? await context.driver.getLocalGitUpdateTarget(targetDir)
		: await getLocalGitUpdateTarget(context, targetDir);
	await ensureGitRef(context, targetDir, target.fetchArgs, target.ref);
}

async function ensureGitRef(
	context: PackageManagerContext,
	targetDir: string,
	fetchArgs: string[],
	ref: string,
): Promise<void> {
	await runGitProcess(context, fetchArgs, { cwd: targetDir });

	const localHead = await captureGitProcess(context, ["rev-parse", "HEAD"], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const commitRef = `${ref}^{commit}`;
	const targetHead = await captureGitProcess(context, ["rev-parse", commitRef], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const markerPath = getGitUpdateMarkerPath(targetDir);
	if (localHead.trim() === targetHead.trim()) {
		if (existsSync(markerPath)) {
			await cleanAndInstallGitDependencies(context, targetDir, markerPath);
		} else {
			await repairMissingGitDependencies(context, targetDir);
		}
		return;
	}

	writeFileSync(markerPath, "", "utf-8");
	await runGitProcess(context, ["reset", "--hard", commitRef], { cwd: targetDir });
	await cleanAndInstallGitDependencies(context, targetDir, markerPath);
}

export async function refreshTemporaryGitSource(
	context: PackageManagerContext,
	source: GitSource,
	sourceStr: string,
	installedPath: string,
): Promise<void> {
	if (isOfflineModeEnabled()) {
		return;
	}
	try {
		// A ref can name a moving branch, so refresh refs too. Skip the network call only when the
		// ref is a commit hash that is already checked out.
		if (source.ref && /^[0-9a-f]{7,64}$/i.test(source.ref)) {
			const head = await captureGitProcess(context, ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			if (head.trim().toLowerCase().startsWith(source.ref.toLowerCase())) {
				return;
			}
		}
		await withProgress(context, "pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
			await updateGit(context, source, "temporary");
		});
	} catch (error) {
		rethrowGitProvisionError(error);
	}
}

export async function removeGit(context: PackageManagerContext, source: GitSource, scope: SourceScope): Promise<void> {
	const targetDir = getGitInstallPath(context, source, scope);
	rmSync(targetDir, { recursive: true, force: true });
	rmSync(getGitUpdateMarkerPath(targetDir), { force: true });
	pruneEmptyGitParents(targetDir, getGitInstallRoot(context, scope));
}

function pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
	if (!installRoot) return;
	const resolvedRoot = resolve(installRoot);
	let current = dirname(targetDir);
	while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
		if (!existsSync(current)) {
			current = dirname(current);
			continue;
		}
		const entries = readdirSync(current);
		if (entries.length > 0) break;
		try {
			rmSync(current, { recursive: true, force: true });
		} catch {
			break;
		}
		current = dirname(current);
	}
}

export async function gitHasAvailableUpdate(context: PackageManagerContext, installedPath: string): Promise<boolean> {
	if (isOfflineModeEnabled()) {
		return false;
	}
	try {
		const localHead = await captureGitProcess(context, ["rev-parse", "HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const remoteHead = await getRemoteGitHead(context, installedPath);
		return localHead.trim() !== remoteHead.trim();
	} catch (error) {
		rethrowGitProvisionError(error);
		return false;
	}
}

async function getRemoteGitHead(context: PackageManagerContext, installedPath: string): Promise<string> {
	const upstreamRef = await getGitUpstreamRef(context, installedPath);
	if (upstreamRef) {
		const remoteHead = await runGitRemoteCommand(context, installedPath, ["ls-remote", "origin", upstreamRef]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
		if (match?.[1]) return match[1];
	}

	const remoteHead = await runGitRemoteCommand(context, installedPath, ["ls-remote", "origin", "HEAD"]);
	const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
	if (!match?.[1]) {
		throw new Error("Failed to determine remote HEAD");
	}
	return match[1];
}

export async function getLocalGitUpdateTarget(
	context: PackageManagerContext,
	installedPath: string,
): Promise<GitUpdateTargetInfo> {
	try {
		const upstream = await captureGitProcess(context, ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const trimmedUpstream = upstream.trim();
		if (!trimmedUpstream.startsWith("origin/")) throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
		const branch = trimmedUpstream.slice("origin/".length);
		if (!branch) throw new Error("Missing upstream branch name");
		const head = await captureGitProcess(context, ["rev-parse", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return {
			ref: "@{upstream}",
			head,
			fetchArgs: ["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
		};
	} catch (upstreamError) {
		rethrowGitProvisionError(upstreamError);
		await runGitProcess(context, ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch((error) => {
			rethrowGitProvisionError(error);
			emitProgress(context, {
				type: "progress",
				action: "update",
				source: installedPath,
				message: `Could not refresh the default branch of ${installedPath} (${error instanceof Error ? error.message : String(error)}); using the last known one.`,
			});
		});
		const head = await captureGitProcess(context, ["rev-parse", "origin/HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const originHeadRef = await captureGitProcess(context, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		}).catch((error) => {
			rethrowGitProvisionError(error);
			return "";
		});
		const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
		if (branch) {
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		}
		return {
			ref: "origin/HEAD",
			head,
			fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
		};
	}
}

async function getGitUpstreamRef(context: PackageManagerContext, installedPath: string): Promise<string | undefined> {
	try {
		const upstream = await captureGitProcess(context, ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const trimmed = upstream.trim();
		if (!trimmed.startsWith("origin/")) return undefined;
		const branch = trimmed.slice("origin/".length);
		return branch ? `refs/heads/${branch}` : undefined;
	} catch (error) {
		rethrowGitProvisionError(error);
		return undefined;
	}
}

function runGitRemoteCommand(context: PackageManagerContext, installedPath: string, args: string[]): Promise<string> {
	return captureGitProcess(context, args, {
		cwd: installedPath,
		timeoutMs: NETWORK_TIMEOUT_MS,
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
}
