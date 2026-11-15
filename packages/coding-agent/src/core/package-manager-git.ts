import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { APP_NAME, getProjectConfigDirs } from "../config.js";
import type { GitSource } from "../utils/git.ts";
import { isGitProvisionError } from "../utils/git-errors.ts";
import { stripBom } from "../utils/text.ts";
import { getToolEnv, getToolPath } from "../utils/tools-manager.ts";
import { runCommand, runCommandCapture } from "./package-manager-command.ts";
import { NETWORK_TIMEOUT_MS } from "./package-manager-constants.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import { withInstallLock } from "./package-manager-lock.ts";
import { ensureGitIgnore, getGitDependencyInstallArgs, runNpmCommand } from "./package-manager-npm.ts";
import { getBaseDirsForScope, getGitInstallPath, getGitInstallRoot } from "./package-manager-paths.ts";
import { emitProgress, withProgress } from "./package-manager-progress.ts";
import type {
	GitUpdateTargetInfo,
	PackageLocationContext,
	PackageManagerContext,
	SourceScope,
} from "./package-manager-types.ts";
import { renameReplacing } from "./settings-storage.ts";

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

/** A staging directory older than this belongs to an install that was killed, not one still running. */
const STALE_GIT_STAGING_MS = 24 * 60 * 60 * 1000;

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
	const installedBefore = existsSync(targetDir);
	await withGitInstallLock(context, scope, targetDir, async () => {
		if (!existsSync(targetDir)) {
			await cloneGit(context, source, scope, targetDir, safeRef);
			return;
		}
		// Another process finished installing it while this one waited for the lock.
		if (!installedBefore && (await isCompleteGitCheckout(context, targetDir))) return;
		await updateGitCheckout(context, source, scope, targetDir, safeRef, "install");
	});
}

/** Holds the install lock of `targetDir`, then drops host/owner directories a failed install left empty. */
async function withGitInstallLock(
	context: PackageManagerContext,
	scope: SourceScope,
	targetDir: string,
	operation: () => Promise<void>,
): Promise<void> {
	try {
		await withInstallLock(targetDir, operation);
	} finally {
		pruneEmptyGitParents(targetDir, getGitInstallRoot(context, scope));
	}
}

/**
 * Brings an existing checkout to its target commit. A directory that is not its own repository, or whose update fails
 * because it is not a complete checkout (a clone killed partway), is cloned again.
 */
async function updateGitCheckout(
	context: PackageManagerContext,
	source: GitSource,
	scope: SourceScope,
	targetDir: string,
	safeRef: string | undefined,
	action: "install" | "update",
): Promise<void> {
	if (existsSync(join(targetDir, ".git"))) {
		try {
			await updateCompleteGitCheckout(context, targetDir, safeRef);
			return;
		} catch (error) {
			if (isGitProvisionError(error) || (await isCompleteGitCheckout(context, targetDir))) throw error;
		}
	}
	emitProgress(context, {
		type: "progress",
		action,
		source: targetDir,
		message: `${targetDir} is not a complete git checkout (an earlier install may have been interrupted); cloning it again.`,
	});
	assertOwnGitInstallDir(source, targetDir);
	rmSync(targetDir, { recursive: true, force: true });
	await cloneGit(context, source, scope, targetDir, safeRef);
}

async function updateCompleteGitCheckout(
	context: PackageManagerContext,
	targetDir: string,
	safeRef: string | undefined,
): Promise<void> {
	if (safeRef) {
		await ensureGitRef(context, targetDir, ["fetch", "origin", "--", safeRef], "FETCH_HEAD");
		return;
	}
	const target = context.driver
		? await context.driver.getLocalGitUpdateTarget(targetDir)
		: await getLocalGitUpdateTarget(context, targetDir);
	await ensureGitRef(context, targetDir, target.fetchArgs, target.ref);
}

/**
 * Whether `dir` is a git checkout an update can work with: its own repository with a HEAD commit and either an
 * upstream branch or a remote default branch. A clone killed before it fetched leaves none of these.
 */
async function isCompleteGitCheckout(context: PackageManagerContext, dir: string): Promise<boolean> {
	if (!existsSync(join(dir, ".git"))) return false;
	const resolves = (revision: string) =>
		captureGitProcess(context, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
			cwd: dir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		}).then(
			() => true,
			(error) => {
				rethrowGitProvisionError(error);
				return false;
			},
		);
	if (!(await resolves("HEAD"))) return false;
	return (await resolves("@{upstream}")) || (await resolves("refs/remotes/origin/HEAD"));
}

/**
 * Throws unless removing `targetDir` removes only `source`'s own package: the source must name a full
 * host/owner/repo directory, and that directory, unless it is a checkout itself, must hold no other package's
 * checkout (#5055).
 */
function assertOwnGitInstallDir(source: GitSource, targetDir: string): void {
	const pathSegments = source.path.split("/");
	const namesOwnDir =
		pathSegments.length >= 2 &&
		[source.host, ...pathSegments].every((segment) => segment !== "" && segment !== "." && segment !== "..");
	if (!namesOwnDir) {
		throw new Error(`Refusing to remove ${targetDir}: it is not the install directory of ${source.repo}`);
	}
	if (!existsSync(targetDir) || existsSync(join(targetDir, ".git"))) return;
	const nestedCheckout = readdirSync(targetDir, { recursive: true }).some(
		(entry) => basename(String(entry)) === ".git",
	);
	if (nestedCheckout) {
		throw new Error(`Refusing to remove ${targetDir}: it holds another package's checkout`);
	}
}

/** Staging directories are named after their target so a later install of the same package can sweep them. */
function getGitStagingPrefix(targetDir: string): string {
	return `.${basename(targetDir)}.${APP_NAME}-clone-`;
}

/** Removes staging directories that interrupted installs of `targetDir` left behind. */
function sweepStaleGitStagingDirs(targetDir: string): void {
	const parent = dirname(targetDir);
	const prefix = getGitStagingPrefix(targetDir);
	for (const entry of readdirSync(parent)) {
		if (!entry.startsWith(prefix)) continue;
		const path = join(parent, entry);
		try {
			if (Date.now() - statSync(path).mtimeMs > STALE_GIT_STAGING_MS) rmSync(path, { recursive: true, force: true });
		} catch {
			// Another process removed it first, or it is still in use; the next install tries again.
		}
	}
}

/**
 * Clones into a staging directory next to `targetDir` and renames it into place once the clone, checkout, and
 * dependency install succeed, so a killed install never leaves a partial checkout at `targetDir`.
 */
async function cloneGit(
	context: PackageManagerContext,
	source: GitSource,
	scope: SourceScope,
	targetDir: string,
	safeRef: string | undefined,
): Promise<void> {
	const gitRoot = getGitInstallRoot(context, scope);
	if (gitRoot) {
		ensureGitIgnore(gitRoot);
	}
	const parent = dirname(targetDir);
	mkdirSync(parent, { recursive: true });
	rmSync(getGitUpdateMarkerPath(targetDir), { force: true });
	sweepStaleGitStagingDirs(targetDir);

	// Defense-in-depth: the clone URL is already parsed/validated upstream, but
	// assert it contains only shell-safe characters immediately before it reaches
	// `git clone`, so no metacharacter can ever reach a shell even on platforms
	// that wrap process spawns. Capture the validated value in a local so the
	// guard sanitizes exactly the binding handed to the spawn.
	const cloneUrl = source.repo;
	if (!/^[A-Za-z0-9._~:@/%+-]+$/.test(cloneUrl)) {
		throw new Error(`Refusing to clone repository with unsafe URL: ${cloneUrl}`);
	}
	const stagingDir = join(parent, `${getGitStagingPrefix(targetDir)}${process.pid}-${randomUUID().slice(0, 8)}`);
	try {
		await runGitProcess(context, ["clone", "--", cloneUrl, stagingDir]);
		if (safeRef) {
			await runGitProcess(context, ["checkout", safeRef], { cwd: stagingDir });
		}
		if (existsSync(join(stagingDir, "package.json"))) {
			await runNpmCommand(context, getGitDependencyInstallArgs(context), { cwd: stagingDir });
		}
		try {
			renameReplacing(stagingDir, targetDir);
		} catch (error) {
			// An install that does not take the lock (an older version) can finish first; use its checkout.
			if (!existsSync(targetDir) || !(await isCompleteGitCheckout(context, targetDir))) throw error;
		}
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
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
	await withGitInstallLock(context, scope, targetDir, async () => {
		if (!existsSync(targetDir)) {
			await cloneGit(context, source, scope, targetDir, safeRef);
			return;
		}
		await updateGitCheckout(context, source, scope, targetDir, safeRef, "update");
	});
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
	if (!existsSync(dirname(targetDir))) return;
	await withGitInstallLock(context, scope, targetDir, async () => {
		assertOwnGitInstallDir(source, targetDir);
		rmSync(targetDir, { recursive: true, force: true });
		rmSync(getGitUpdateMarkerPath(targetDir), { force: true });
	});
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
