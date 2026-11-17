import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { getExistingGitInstallPathAsync } from "./package-manager-git.ts";
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

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

/** Where a user-scope package source is installed, without consulting the global npm root. */
async function installedPackageRoot(
	context: PackageLocationContext,
	source: string,
	name: string,
): Promise<string | undefined> {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		if (parsed.name !== name) return undefined;
		const path = getManagedNpmInstallPath(context, parsed, "user");
		return (await exists(path)) ? path : undefined;
	}
	if (parsed.type === "git") return getExistingGitInstallPathAsync(context, parsed, "user");
	for (const baseDir of getBaseDirsForScope(context, "user")) {
		const path = resolvePathFromBase(parsed.path, baseDir);
		if (await exists(path)) return path;
	}
	return undefined;
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
	await hostStoragePackagesRegistered();
	const hosted = hostStorageAdapter(specifier);
	if (hosted !== undefined) return hosted;
	const settings = (
		await SettingsManager.createAsync(agentDir, agentDir, { projectTrusted: false })
	).getGlobalSettings();
	if (!Array.isArray(settings?.packages)) return undefined;
	const context: PackageLocationContext = { cwd: agentDir, agentDir };
	for (const entry of settings.packages) {
		const source = typeof entry === "string" ? entry : entry?.source;
		const root = typeof source === "string" ? await installedPackageRoot(context, source, requested.name) : undefined;
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

/** The package directories among `sources`, relative ones resolved against `cwd`. */
function localPackageRoots(sources: readonly string[] | undefined, cwd: string): string[] {
	const roots: string[] = [];
	for (const source of sources ?? []) {
		if (!isLocalPath(source)) continue;
		try {
			roots.push(resolvePath(source, cwd));
		} catch {}
	}
	return roots;
}

function addHostStoragePackage(root: string, pkg: { name?: string } | undefined): void {
	const adapters = getManifestFromPackageJson(pkg)?.storageAdapters ?? [];
	if (typeof pkg?.name !== "string" || adapters.length === 0) return;
	addHostStorageAdapter(pkg.name, resolve(root, adapters[0]!));
	for (const module of adapters)
		addHostStorageAdapter(`${pkg.name}/${basename(module, extname(module))}`, resolve(root, module));
}

/**
 * Makes the storage adapters of the package directories among `sources`, the extension paths a host passes to load as
 * code, selectable by name in this process and the processes it starts. Other sources are ignored, and relative paths
 * resolve against `cwd`. `<package>` selects the package's first listed `storageAdapters` entry and `<package>/<name>`
 * the first entry whose file name without its extension is `<name>`; a name registered first keeps its module.
 */
export function registerHostStoragePackages(sources: readonly string[] | undefined, cwd: string): void {
	for (const root of localPackageRoots(sources, cwd)) addHostStoragePackage(root, readPackageJsonSync(root));
}

/** The {@link registerHostStoragePackagesAsync} calls still reading their packages, chained in call order. */
let pendingHostStorageRegistrations: Promise<void> = Promise.resolve();

/**
 * {@link registerHostStoragePackages} without blocking. Registrations complete in call order, and storage that selects
 * an adapter by name waits for them through {@link hostStoragePackagesRegistered}.
 */
export function registerHostStoragePackagesAsync(sources: readonly string[] | undefined, cwd: string): Promise<void> {
	const roots = localPackageRoots(sources, cwd);
	const registration = pendingHostStorageRegistrations.then(async () => {
		const packages = await Promise.all(roots.map((root) => readJson(join(root, "package.json"))));
		roots.forEach((root, index) => {
			addHostStoragePackage(root, packages[index]);
		});
	});
	pendingHostStorageRegistrations = registration;
	return registration;
}

/** Settles once every {@link registerHostStoragePackagesAsync} call made so far has registered its adapters. */
export function hostStoragePackagesRegistered(): Promise<void> {
	return pendingHostStorageRegistrations;
}
