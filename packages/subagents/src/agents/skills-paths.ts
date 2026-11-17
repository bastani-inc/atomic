import { exec } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	createChildProcessEnvironment,
	getAgentConfigPaths,
	getAgentDirs,
	getBuiltinPackagePaths,
	getProjectConfigDirs,
	isPathInside,
} from "@bastani/atomic";
import { pathExists } from "../shared/path-exists.js";
import type { SkillSource } from "./skills.js";

export interface SkillSearchPath {
	path: string;
	source: SkillSource;
}

function isWithinPath(filePath: string, dir: string): boolean {
	return isPathInside(dir, filePath);
}

async function readOptionalJsonFile(filePath: string, label: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(filePath, "utf-8"));
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code === "ENOENT") return null;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${label} '${filePath}': ${message}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

async function readJsonFileBestEffort(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(filePath, "utf-8"));
	} catch {
		// Package scans over installed dependencies are opportunistic.
		return null;
	}
}

async function extractSkillPathsFromPackageRoot(
	packageRoot: string,
	source: SkillSource,
	bestEffort = false,
): Promise<SkillSearchPath[]> {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const pkg = bestEffort
		? await readJsonFileBestEffort(packageJsonPath)
		: await readOptionalJsonFile(packageJsonPath, "package manifest");
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return [];
	const pi = (pkg as { pi?: unknown }).pi;
	if (!pi || typeof pi !== "object" || Array.isArray(pi)) return [];
	const skills = (pi as { skills?: unknown }).skills;
	if (!Array.isArray(skills)) return [];
	return skills
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => ({ path: path.resolve(packageRoot, entry), source }));
}

export interface GlobalNpmRootExecOptions {
	readonly encoding: "utf-8";
	readonly timeout: number;
	readonly windowsHide: boolean;
	readonly env: NodeJS.ProcessEnv;
}

export type GlobalNpmRootExec = (command: string, options: GlobalNpmRootExecOptions) => Promise<{ stdout: string }>;

const execAsync: GlobalNpmRootExec = promisify(exec);
let execGlobalNpmRoot = execAsync;
/** The probe of the global npm root, shared by every caller until the cache is cleared; null when it failed. */
let globalNpmRoot: Promise<string | null> | undefined;
const GLOBAL_NPM_ROOT_TIMEOUT_MS = 2500;

async function probeGlobalNpmRoot(): Promise<string | null> {
	try {
		// Keep global package probing bounded during startup while still allowing
		// slower Windows/corporate npm wrappers enough time to launch.
		const { stdout } = await execGlobalNpmRoot("npm root -g", {
			encoding: "utf-8",
			timeout: GLOBAL_NPM_ROOT_TIMEOUT_MS,
			windowsHide: true,
			env: createChildProcessEnvironment(),
		});
		return stdout.trim();
	} catch {
		// Global npm root is optional in constrained environments.
		return null;
	}
}

function getGlobalNpmRoot(): Promise<string | null> {
	globalNpmRoot ??= probeGlobalNpmRoot();
	return globalNpmRoot;
}

async function collectInstalledPackageSkillPaths(cwd: string): Promise<SkillSearchPath[]> {
	const dirs: SkillSearchPath[] = [
		...getProjectConfigDirs(cwd).map((configDir) => ({
			path: path.join(configDir, "npm", "node_modules"),
			source: "project-package" as const,
		})),
		...getAgentConfigPaths("npm", "node_modules").map((dir) => ({ path: dir, source: "user-package" as const })),
	];

	const globalRoot = await getGlobalNpmRoot();
	if (globalRoot) {
		dirs.push({ path: globalRoot, source: "user-package" });
	}

	const results: SkillSearchPath[] = [];

	for (const dir of dirs) {
		if (!(await pathExists(dir.path))) continue;
		let entries: Dirent[];
		try {
			entries = await readdir(dir.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

			if (entry.name.startsWith("@")) {
				const scopeDir = path.join(dir.path, entry.name);
				let scopeEntries: Dirent[];
				try {
					scopeEntries = await readdir(scopeDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const scopeEntry of scopeEntries) {
					if (scopeEntry.name.startsWith(".")) continue;
					if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
					const pkgRoot = path.join(scopeDir, scopeEntry.name);
					results.push(...(await extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true)));
				}
				continue;
			}

			const pkgRoot = path.join(dir.path, entry.name);
			results.push(...(await extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true)));
		}
	}

	return results;
}

async function collectSettingsSkillPaths(cwd: string): Promise<SkillSearchPath[]> {
	const results: SkillSearchPath[] = [];
	const settingsFiles = [
		...getProjectConfigDirs(cwd).map((configDir) => ({
			file: path.join(configDir, "settings.json"),
			base: configDir,
			source: "project-settings" as const,
		})),
		...getAgentConfigPaths("settings.json").map((file) => ({
			file,
			base: path.dirname(file),
			source: "user-settings" as const,
		})),
	];

	for (const { file, base, source } of settingsFiles) {
		const settings = await readOptionalJsonFile(file, "skills settings file");
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
		const skills = (settings as { skills?: unknown }).skills;
		if (!Array.isArray(skills)) continue;
		for (const entry of skills) {
			if (typeof entry !== "string") continue;
			let resolved = entry;
			if (resolved.startsWith("~/")) {
				resolved = path.join(os.homedir(), resolved.slice(2));
			} else if (!path.isAbsolute(resolved)) {
				resolved = path.resolve(base, resolved);
			}
			results.push({ path: resolved, source });
		}
	}

	return results;
}

function isSafePackagePath(value: string): boolean {
	return (
		value.length > 0 &&
		!path.isAbsolute(value) &&
		value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const match = spec.match(/^(@?[^@]+)(?:@(.+))?$/);
	const packageName = match?.[1] ?? spec;
	return isSafePackagePath(packageName) ? packageName : undefined;
}

function stripGitRef(repoPath: string): string {
	const atIndex = repoPath.indexOf("@");
	const hashIndex = repoPath.indexOf("#");
	const refIndex = [atIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
	return refIndex === undefined ? repoPath : repoPath.slice(0, refIndex);
}

function parseGitPackagePath(source: string): { host: string; repoPath: string } | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;

	let host = "";
	let repoPath = "";
	const scpLike = spec.match(/^git@([^:]+):(.+)$/);
	if (scpLike) {
		host = scpLike[1] ?? "";
		repoPath = scpLike[2] ?? "";
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
		try {
			const url = new URL(spec);
			host = url.hostname;
			repoPath = url.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else {
		const slashIndex = spec.indexOf("/");
		if (slashIndex < 0) return undefined;
		host = spec.slice(0, slashIndex);
		repoPath = spec.slice(slashIndex + 1);
	}

	const normalizedPath = stripGitRef(repoPath)
		.replace(/\.git$/, "")
		.replace(/^\/+/, "");
	if (
		!host ||
		!isSafePackagePath(host) ||
		!isSafePackagePath(normalizedPath) ||
		normalizedPath.split(/[\\/]/).length < 2
	) {
		return undefined;
	}
	return { host, repoPath: normalizedPath };
}

function resolveSettingsPackageRoot(source: string, baseDir: string): string | undefined {
	const trimmed = source.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("git:")) {
		const parsed = parseGitPackagePath(trimmed);
		return parsed ? path.join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
	}
	if (trimmed.startsWith("npm:")) {
		const packageName = parseNpmPackageName(trimmed);
		return packageName ? path.join(baseDir, "npm", "node_modules", packageName) : undefined;
	}
	const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
	if (path.isAbsolute(normalized)) return normalized;
	if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) {
		return path.resolve(baseDir, normalized);
	}
	return undefined;
}

async function collectSettingsPackageSkillPaths(cwd: string): Promise<SkillSearchPath[]> {
	const settingsFiles = [
		...getProjectConfigDirs(cwd).map((configDir) => ({
			file: path.join(configDir, "settings.json"),
			base: configDir,
			source: "project-package" as const,
		})),
		...getAgentConfigPaths("settings.json").map((file) => ({
			file,
			base: path.dirname(file),
			source: "user-package" as const,
		})),
	];
	const results: SkillSearchPath[] = [];

	for (const { file, base, source } of settingsFiles) {
		const settings = await readOptionalJsonFile(file, "skills settings file");
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
		const packages = (settings as { packages?: unknown }).packages;
		if (!Array.isArray(packages)) continue;

		for (const entry of packages) {
			const packageSource =
				typeof entry === "string"
					? entry
					: typeof entry === "object" &&
							entry !== null &&
							typeof (entry as { source?: unknown }).source === "string"
						? (entry as { source: string }).source
						: undefined;
			if (!packageSource) continue;

			const packageRoot = resolveSettingsPackageRoot(packageSource, base);
			if (!packageRoot) continue;
			results.push(...(await extractSkillPathsFromPackageRoot(packageRoot, source)));
		}
	}

	return results;
}

async function collectBuiltinPackageSkillPaths(): Promise<SkillSearchPath[]> {
	try {
		const results: SkillSearchPath[] = [];
		for (const packageRoot of getBuiltinPackagePaths())
			results.push(...(await extractSkillPathsFromPackageRoot(packageRoot, "builtin", true)));
		return results;
	} catch {
		// Builtin package discovery is additive; keep project/user/settings skill resolution working if unavailable.
		return [];
	}
}

export async function buildSkillPaths(cwd: string): Promise<SkillSearchPath[]> {
	const skillPaths: SkillSearchPath[] = [
		...getProjectConfigDirs(cwd).map((configDir) => ({
			path: path.join(configDir, "skills"),
			source: "project" as const,
		})),
		{ path: path.join(cwd, ".agents", "skills"), source: "project" },
		...getAgentConfigPaths("skills").map((dir) => ({ path: dir, source: "user" as const })),
		{ path: path.join(os.homedir(), ".agents", "skills"), source: "user" },
		...(await collectInstalledPackageSkillPaths(cwd)),
		...(await collectSettingsPackageSkillPaths(cwd)),
		...(await extractSkillPathsFromPackageRoot(cwd, "project-package")),
		...(await collectSettingsSkillPaths(cwd)),
		...(await collectBuiltinPackageSkillPaths()),
	];

	const deduped = new Map<string, SkillSearchPath>();
	for (const entry of skillPaths) {
		const resolvedPath = path.resolve(entry.path);
		if (!deduped.has(resolvedPath)) {
			deduped.set(resolvedPath, { path: resolvedPath, source: entry.source });
		}
	}
	return [...deduped.values()];
}

export async function inferSkillSource(filePath: string, cwd: string, sourceHint?: SkillSource): Promise<SkillSource> {
	if (sourceHint) return sourceHint;

	const projectConfigRoots = getProjectConfigDirs(cwd).map((dir) => path.resolve(dir));
	const projectSkillsRoots = projectConfigRoots.map((dir) => path.join(dir, "skills"));
	const projectPackagesRoots = projectConfigRoots.map((dir) => path.join(dir, "npm", "node_modules"));
	const projectAgentsRoot = path.resolve(cwd, ".agents");
	const userAgentRoots = getAgentDirs().map((dir) => path.resolve(dir));
	const userSkillsRoots = userAgentRoots.map((dir) => path.join(dir, "skills"));
	const userPackagesRoots = userAgentRoots.map((dir) => path.join(dir, "npm", "node_modules"));
	const userAgentsRoot = path.resolve(os.homedir(), ".agents");

	if (projectPackagesRoots.some((root) => isWithinPath(filePath, root))) return "project-package";
	if (projectSkillsRoots.some((root) => isWithinPath(filePath, root)) || isWithinPath(filePath, projectAgentsRoot))
		return "project";
	if (projectConfigRoots.some((root) => isWithinPath(filePath, root))) return "project-settings";

	if (userPackagesRoots.some((root) => isWithinPath(filePath, root))) return "user-package";
	if (userSkillsRoots.some((root) => isWithinPath(filePath, root)) || isWithinPath(filePath, userAgentsRoot))
		return "user";
	if (userAgentRoots.some((root) => isWithinPath(filePath, root))) return "user-settings";

	const globalRoot = await getGlobalNpmRoot();
	if (globalRoot && isWithinPath(filePath, globalRoot)) return "user-package";

	return "unknown";
}

export function clearSkillPathDiscoveryCache(): void {
	globalNpmRoot = undefined;
}

/**
 * @internal Test seam for unit tests that need to mock `npm root -g`.
 */
export function __setGlobalNpmRootExecForTest(execImpl?: GlobalNpmRootExec): void {
	execGlobalNpmRoot = execImpl ?? execAsync;
	globalNpmRoot = undefined;
}
