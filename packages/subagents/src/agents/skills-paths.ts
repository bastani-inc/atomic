import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentConfigPaths, getAgentDirs, getBuiltinPackagePaths, getProjectConfigDirs } from "@bastani/atomic";
import type { SkillSource } from "./skills.ts";

export interface SkillSearchPath {
	path: string;
	source: SkillSource;
}

function isWithinPath(filePath: string, dir: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readOptionalJsonFile(filePath: string, label: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error
			? (error as { code?: unknown }).code
			: undefined;
		if (code === "ENOENT") return null;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${label} '${filePath}': ${message}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function readJsonFileBestEffort(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// Package scans over installed dependencies are opportunistic.
		return null;
	}
}

function extractSkillPathsFromPackageRoot(packageRoot: string, source: SkillSource, bestEffort = false): SkillSearchPath[] {
	const packageJsonPath = path.join(packageRoot, "package.json");
	const pkg = bestEffort
		? readJsonFileBestEffort(packageJsonPath)
		: readOptionalJsonFile(packageJsonPath, "package manifest");
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return [];
	const pi = (pkg as { pi?: unknown }).pi;
	if (!pi || typeof pi !== "object" || Array.isArray(pi)) return [];
	const skills = (pi as { skills?: unknown }).skills;
	if (!Array.isArray(skills)) return [];
	return skills
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => ({ path: path.resolve(packageRoot, entry), source }));
}

let cachedGlobalNpmRoot: string | null = null;
let execSyncGlobalNpmRoot = execSync;
const GLOBAL_NPM_ROOT_TIMEOUT_MS = 2500;

function getGlobalNpmRoot(): string | null {
	if (cachedGlobalNpmRoot !== null) return cachedGlobalNpmRoot;
	try {
		// Keep global package probing bounded during startup while still allowing
		// slower Windows/corporate npm wrappers enough time to launch.
		cachedGlobalNpmRoot = execSyncGlobalNpmRoot("npm root -g", {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GLOBAL_NPM_ROOT_TIMEOUT_MS,
			windowsHide: true,
		}).trim();
		return cachedGlobalNpmRoot;
	} catch {
		// Global npm root is optional in constrained environments.
		cachedGlobalNpmRoot = ""; // Empty string means "tried but failed"
		return null;
	}
}

function collectInstalledPackageSkillPaths(cwd: string): SkillSearchPath[] {
	const dirs: SkillSearchPath[] = [
		...getProjectConfigDirs(cwd).map((configDir) => ({ path: path.join(configDir, "npm", "node_modules"), source: "project-package" as const })),
		...getAgentConfigPaths("npm", "node_modules").map((dir) => ({ path: dir, source: "user-package" as const })),
	];

	const globalRoot = getGlobalNpmRoot();
	if (globalRoot) {
		dirs.push({ path: globalRoot, source: "user-package" });
	}

	const results: SkillSearchPath[] = [];

	for (const dir of dirs) {
		if (!fs.existsSync(dir.path)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

			if (entry.name.startsWith("@")) {
				const scopeDir = path.join(dir.path, entry.name);
				let scopeEntries: fs.Dirent[];
				try {
					scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const scopeEntry of scopeEntries) {
					if (scopeEntry.name.startsWith(".")) continue;
					if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
					const pkgRoot = path.join(scopeDir, scopeEntry.name);
					results.push(...extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true));
				}
				continue;
			}

			const pkgRoot = path.join(dir.path, entry.name);
			results.push(...extractSkillPathsFromPackageRoot(pkgRoot, dir.source, true));
		}
	}

	return results;
}

function collectSettingsSkillPaths(cwd: string): SkillSearchPath[] {
	const results: SkillSearchPath[] = [];
	const settingsFiles = [
		...getProjectConfigDirs(cwd).map((configDir) => ({ file: path.join(configDir, "settings.json"), base: configDir, source: "project-settings" as const })),
		...getAgentConfigPaths("settings.json").map((file) => ({ file, base: path.dirname(file), source: "user-settings" as const })),
	];

	for (const { file, base, source } of settingsFiles) {
		const settings = readOptionalJsonFile(file, "skills settings file");
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
	return value.length > 0
		&& !path.isAbsolute(value)
		&& value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseNpmPackageName(source: string): string | undefined {
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
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

	const normalizedPath = stripGitRef(repoPath).replace(/\.git$/, "").replace(/^\/+/, "");
	if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalizedPath) || normalizedPath.split(/[\\/]/).length < 2) {
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

function collectSettingsPackageSkillPaths(cwd: string): SkillSearchPath[] {
	const settingsFiles = [
		...getProjectConfigDirs(cwd).map((configDir) => ({ file: path.join(configDir, "settings.json"), base: configDir, source: "project-package" as const })),
		...getAgentConfigPaths("settings.json").map((file) => ({ file, base: path.dirname(file), source: "user-package" as const })),
	];
	const results: SkillSearchPath[] = [];

	for (const { file, base, source } of settingsFiles) {
		const settings = readOptionalJsonFile(file, "skills settings file");
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
		const packages = (settings as { packages?: unknown }).packages;
		if (!Array.isArray(packages)) continue;

		for (const entry of packages) {
			const packageSource = typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string"
					? (entry as { source: string }).source
					: undefined;
			if (!packageSource) continue;

			const packageRoot = resolveSettingsPackageRoot(packageSource, base);
			if (!packageRoot) continue;
			results.push(...extractSkillPathsFromPackageRoot(packageRoot, source));
		}
	}

	return results;
}

function collectBuiltinPackageSkillPaths(): SkillSearchPath[] {
	try {
		return getBuiltinPackagePaths().flatMap((packageRoot) =>
			extractSkillPathsFromPackageRoot(packageRoot, "builtin", true)
		);
	} catch {
		// Builtin package discovery is additive; keep project/user/settings skill resolution working if unavailable.
		return [];
	}
}

export function buildSkillPaths(cwd: string): SkillSearchPath[] {
	const skillPaths: SkillSearchPath[] = [
		...getProjectConfigDirs(cwd).map((configDir) => ({ path: path.join(configDir, "skills"), source: "project" as const })),
		{ path: path.join(cwd, ".agents", "skills"), source: "project" },
		...getAgentConfigPaths("skills").map((dir) => ({ path: dir, source: "user" as const })),
		{ path: path.join(os.homedir(), ".agents", "skills"), source: "user" },
		...collectInstalledPackageSkillPaths(cwd),
		...collectSettingsPackageSkillPaths(cwd),
		...extractSkillPathsFromPackageRoot(cwd, "project-package"),
		...collectSettingsSkillPaths(cwd),
		...collectBuiltinPackageSkillPaths(),
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

export function inferSkillSource(filePath: string, cwd: string, sourceHint?: SkillSource): SkillSource {
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
	if (projectSkillsRoots.some((root) => isWithinPath(filePath, root)) || isWithinPath(filePath, projectAgentsRoot)) return "project";
	if (projectConfigRoots.some((root) => isWithinPath(filePath, root))) return "project-settings";

	if (userPackagesRoots.some((root) => isWithinPath(filePath, root))) return "user-package";
	if (userSkillsRoots.some((root) => isWithinPath(filePath, root)) || isWithinPath(filePath, userAgentsRoot)) return "user";
	if (userAgentRoots.some((root) => isWithinPath(filePath, root))) return "user-settings";

	const globalRoot = getGlobalNpmRoot();
	if (globalRoot && isWithinPath(filePath, globalRoot)) return "user-package";

	return "unknown";
}


export function clearSkillPathDiscoveryCache(): void {
	cachedGlobalNpmRoot = null;
}

/**
 * @internal Test seam for unit tests that need to mock `npm root -g`.
 */
export function __setGlobalNpmRootExecSyncForTest(execSyncImpl?: typeof execSync): void {
	execSyncGlobalNpmRoot = execSyncImpl ?? execSync;
	cachedGlobalNpmRoot = null;
}
