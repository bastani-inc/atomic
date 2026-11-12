import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { getExistingGitInstallPath } from "./package-manager-git.ts";
import { getManifestFromPackageJson } from "./package-manager-manifest.ts";
import { getManagedNpmInstallPath } from "./package-manager-npm.ts";
import { getBaseDirsForScope, resolvePathFromBase } from "./package-manager-paths.ts";
import { parseSource } from "./package-manager-source.ts";
import type { PackageLocationContext } from "./package-manager-types.ts";
import { SettingsManager } from "./settings-manager.ts";
import { addHostStorageAdapter, hostStorageAdapter } from "./storage/host-adapters.ts";

/** Splits a bare module specifier into its package name and the adapter name after it, if any. */
function parsePackageSpecifier(specifier: string): { name: string; adapter?: string } | undefined {
	if (isAbsolute(specifier) || /^[.~]|[:\\]/.test(specifier)) return undefined;
	const segments = specifier.split("/");
	const nameLength = specifier.startsWith("@") ? 2 : 1;
	if (segments.length < nameLength || segments.some((segment) => segment.length === 0)) return undefined;
	const adapter = segments.slice(nameLength).join("/");
	return { name: segments.slice(0, nameLength).join("/"), ...(adapter ? { adapter } : {}) };
}

async function readJson(path: string): Promise<object | undefined> {
	try {
		const value: object | null = JSON.parse(stripBom(await readFile(path, "utf8")));
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Where a user-scope package source is installed, without consulting the global npm root. */
function installedPackageRoot(context: PackageLocationContext, source: string, name: string): string | undefined {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		if (parsed.name !== name) return undefined;
		const path = getManagedNpmInstallPath(context, parsed, "user");
		return existsSync(path) ? path : undefined;
	}
	if (parsed.type === "git") return getExistingGitInstallPath(context, parsed, "user");
	return getBaseDirsForScope(context, "user")
		.map((baseDir) => resolvePathFromBase(parsed.path, baseDir))
		.find((path) => existsSync(path));
}

/**
 * The module a bare `storage.adapter` value selects from the Atomic packages this process's host loaded, else from
 * the packages in the agent directory's settings, or undefined when no such package lists a matching adapter.
 * `<package>` selects the package's first listed `storageAdapters` entry, and `<package>/<name>` the entry whose file
 * name without its extension is `<name>`.
 */
export async function resolvePackageStorageAdapter(specifier: string, agentDir: string): Promise<string | undefined> {
	const requested = parsePackageSpecifier(specifier);
	if (!requested) return undefined;
	const hosted = hostStorageAdapter(specifier);
	if (hosted !== undefined) return hosted;
	const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getGlobalSettings();
	if (!Array.isArray(settings?.packages)) return undefined;
	const context: PackageLocationContext = { cwd: agentDir, agentDir };
	for (const entry of settings.packages) {
		const source = typeof entry === "string" ? entry : entry?.source;
		const root = typeof source === "string" ? installedPackageRoot(context, source, requested.name) : undefined;
		if (root === undefined) continue;
		const pkg = (await readJson(join(root, "package.json"))) as { name?: string } | undefined;
		if (pkg?.name !== requested.name) continue;
		const adapters = getManifestFromPackageJson(pkg)?.storageAdapters ?? [];
		const selected =
			requested.adapter === undefined
				? adapters[0]
				: adapters.find((path) => basename(path, extname(path)) === requested.adapter);
		if (selected !== undefined) return resolve(root, selected);
	}
	return undefined;
}

function readPackageJsonSync(root: string): { name?: string } | undefined {
	try {
		const value: object | null = JSON.parse(stripBom(readFileSync(join(root, "package.json"), "utf8")));
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Makes the storage adapters of the package directories among `sources`, the extension paths a host passes to load as
 * code, selectable by name in this process and the processes it starts. Other sources are ignored, and relative paths
 * resolve against `cwd`. `<package>` selects the package's first listed `storageAdapters` entry and `<package>/<name>`
 * the first entry whose file name without its extension is `<name>`; a name registered first keeps its module.
 */
export function registerHostStoragePackages(sources: readonly string[] | undefined, cwd: string): void {
	for (const source of sources ?? []) {
		if (!isLocalPath(source)) continue;
		let root: string;
		try {
			root = resolvePath(source, cwd);
		} catch {
			continue;
		}
		const pkg = readPackageJsonSync(root);
		const adapters = getManifestFromPackageJson(pkg)?.storageAdapters ?? [];
		if (typeof pkg?.name !== "string" || adapters.length === 0) continue;
		addHostStorageAdapter(pkg.name, resolve(root, adapters[0]!));
		for (const module of adapters)
			addHostStorageAdapter(`${pkg.name}/${basename(module, extname(module))}`, resolve(root, module));
	}
}
