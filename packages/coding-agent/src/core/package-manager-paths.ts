import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir, getAgentDirs, getProjectConfigDirs } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { PackageManagerContext, SourceScope } from "./package-manager-types.ts";

export function getHomeDir(): string {
	return process.env.HOME || homedir();
}

export function getTemporaryDir(prefix: string, suffix?: string): string {
	const hash = createHash("sha256")
		.update(`${prefix}-${suffix ?? ""}`)
		.digest("hex")
		.slice(0, 8);
	return join(tmpdir(), `${APP_NAME}-extensions`, prefix, hash, suffix ?? "");
}

export function getBaseDirsForScope(context: PackageManagerContext, scope: SourceScope): string[] {
	if (scope === "project") {
		return getProjectConfigDirs(context.cwd);
	}
	if (scope === "user") {
		return context.agentDir === getAgentDir() ? getAgentDirs() : [context.agentDir];
	}
	return [context.cwd];
}

export function getBaseDirForScope(context: PackageManagerContext, scope: SourceScope): string {
	return getBaseDirsForScope(context, scope)[0]!;
}

export function resolveManagerPath(context: PackageManagerContext, input: string): string {
	return resolvePath(input, context.cwd, { homeDir: getHomeDir(), trim: true });
}

export function resolvePathFromBase(input: string, baseDir: string): string {
	return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
}

export function getNpmInstallRoot(
	context: PackageManagerContext,
	scope: SourceScope,
	temporary: boolean,
): string {
	if (temporary) {
		return getTemporaryDir("npm");
	}
	if (scope === "project") {
		return join(context.cwd, CONFIG_DIR_NAME, "npm");
	}
	return join(context.agentDir, "npm");
}

export function getGitInstallPath(context: PackageManagerContext, source: { host: string; path: string }, scope: SourceScope): string {
	if (scope === "temporary") {
		return getTemporaryDir(`git-${source.host}`, source.path);
	}
	if (scope === "project") {
		return join(context.cwd, CONFIG_DIR_NAME, "git", source.host, source.path);
	}
	return join(context.agentDir, "git", source.host, source.path);
}

export function getGitInstallRoot(context: PackageManagerContext, scope: SourceScope): string | undefined {
	if (scope === "temporary") {
		return undefined;
	}
	if (scope === "project") {
		return join(context.cwd, CONFIG_DIR_NAME, "git");
	}
	return join(context.agentDir, "git");
}
