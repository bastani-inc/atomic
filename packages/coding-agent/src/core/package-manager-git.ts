import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getProjectConfigDirs } from "../config.ts";
import type { GitSource } from "../utils/git.ts";
import { NETWORK_TIMEOUT_MS } from "./package-manager-constants.ts";
import { runCommand, runCommandCapture } from "./package-manager-command.ts";
import { isOfflineModeEnabled } from "./package-manager-env.ts";
import { getBaseDirsForScope, getGitInstallPath, getGitInstallRoot } from "./package-manager-paths.ts";
import { withProgress } from "./package-manager-progress.ts";
import { ensureGitIgnore, getGitDependencyInstallArgs, runNpmCommand } from "./package-manager-npm.ts";
import type { GitUpdateTargetInfo, PackageManagerContext, SourceScope } from "./package-manager-types.ts";

function runGitProcess(
	context: PackageManagerContext,
	command: string,
	args: string[],
	options?: { cwd?: string },
): Promise<void> {
	return context.driver ? context.driver.runCommand(command, args, options) : runCommand(command, args, options);
}

function captureGitProcess(
	context: PackageManagerContext,
	command: string,
	args: string[],
	options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<string> {
	return context.driver
		? context.driver.runCommandCapture(command, args, options)
		: runCommandCapture(command, args, options);
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
	if (/[\x00-\x1f\x7f\s~^:?*\[\]\\]/u.test(ref)) {
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
	context: PackageManagerContext,
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

export async function installGit(
	context: PackageManagerContext,
	source: GitSource,
	scope: SourceScope,
): Promise<void> {
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

	await runGitProcess(context, "git", ["clone", "--", source.repo, targetDir]);
	if (safeRef) {
		await runGitProcess(context, "git", ["checkout", safeRef], { cwd: targetDir });
	}
	const packageJsonPath = join(targetDir, "package.json");
	if (existsSync(packageJsonPath)) {
		await runNpmCommand(context, getGitDependencyInstallArgs(context), { cwd: targetDir });
	}
}

export async function updateGit(
	context: PackageManagerContext,
	source: GitSource,
	scope: SourceScope,
): Promise<void> {
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
	await runGitProcess(context, "git", fetchArgs, { cwd: targetDir });

	const localHead = await captureGitProcess(context, "git", ["rev-parse", "HEAD"], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	const commitRef = `${ref}^{commit}`;
	const targetHead = await captureGitProcess(context, "git", ["rev-parse", commitRef], {
		cwd: targetDir,
		timeoutMs: NETWORK_TIMEOUT_MS,
	});
	if (localHead.trim() === targetHead.trim()) {
		return;
	}

	await runGitProcess(context, "git", ["reset", "--hard", commitRef], { cwd: targetDir });
	await runGitProcess(context, "git", ["clean", "-fdx"], { cwd: targetDir });

	const packageJsonPath = join(targetDir, "package.json");
	if (existsSync(packageJsonPath)) {
		await runNpmCommand(context, getGitDependencyInstallArgs(context), { cwd: targetDir });
	}
}

export async function refreshTemporaryGitSource(
	context: PackageManagerContext,
	source: GitSource,
	sourceStr: string,
): Promise<void> {
	if (isOfflineModeEnabled()) {
		return;
	}
	try {
		await withProgress(context, "pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
			await updateGit(context, source, "temporary");
		});
	} catch {}
}

export async function removeGit(
	context: PackageManagerContext,
	source: GitSource,
	scope: SourceScope,
): Promise<void> {
	const targetDir = getGitInstallPath(context, source, scope);
	if (!existsSync(targetDir)) return;
	rmSync(targetDir, { recursive: true, force: true });
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
		const localHead = await captureGitProcess(context, "git", ["rev-parse", "HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const remoteHead = await getRemoteGitHead(context, installedPath);
		return localHead.trim() !== remoteHead.trim();
	} catch {
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
		const upstream = await captureGitProcess(context, "git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const trimmedUpstream = upstream.trim();
		if (!trimmedUpstream.startsWith("origin/")) throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
		const branch = trimmedUpstream.slice("origin/".length);
		if (!branch) throw new Error("Missing upstream branch name");
		const head = await captureGitProcess(context, "git", ["rev-parse", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		return {
			ref: "@{upstream}",
			head,
			fetchArgs: ["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
		};
	} catch {
		await runGitProcess(context, "git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
		const head = await captureGitProcess(context, "git", ["rev-parse", "origin/HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const originHeadRef = await captureGitProcess(context, "git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		}).catch(() => "");
		const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
		if (branch) {
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
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
		const upstream = await captureGitProcess(context, "git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const trimmed = upstream.trim();
		if (!trimmed.startsWith("origin/")) return undefined;
		const branch = trimmed.slice("origin/".length);
		return branch ? `refs/heads/${branch}` : undefined;
	} catch {
		return undefined;
	}
}

function runGitRemoteCommand(context: PackageManagerContext, installedPath: string, args: string[]): Promise<string> {
	return captureGitProcess(context, "git", args, {
		cwd: installedPath,
		timeoutMs: NETWORK_TIMEOUT_MS,
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
}

