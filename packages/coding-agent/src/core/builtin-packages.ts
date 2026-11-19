import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPackageDir, isBunBinary } from "../config.js";
import { pathExists as exists } from "../utils/path-exists.ts";
import { moduleDirFromMetaUrl } from "../utils/split-launcher.ts";
import { stripBom } from "../utils/text.ts";
import { type BuiltinPackageDirName, requiredEntriesForBuiltin } from "./builtin-install-layout.ts";
import type { AtomicBuiltin } from "./sdk-types.ts";

interface BuiltinPackageDescriptor {
	readonly packageName: string;
	readonly distDirName: BuiltinPackageDirName;
	readonly mandatory: boolean;
	readonly requiredEntries: readonly string[];
	readonly sourceCandidates: (context: BuiltinPackageCandidateContext) => string[];
}

interface BuiltinPackageCandidateContext {
	/** Module directory; undefined in a compiled binary, whose bundled module URL is a build-time path. */
	readonly here: string | undefined;
	readonly packageDir: string;
	readonly isSourceCheckout: boolean;
}

export interface BuiltinPackageLocation {
	readonly packageName: string;
	readonly distDirName: BuiltinPackageDirName;
	readonly packageDir: string;
}

interface WorkspaceBuiltinSpec {
	readonly packageName: string;
	readonly workspaceDirName: BuiltinPackageDirName;
	readonly distDirName: BuiltinPackageDirName;
}

const WORKSPACE_BUILTINS: readonly (WorkspaceBuiltinSpec & { mandatory?: boolean })[] = [
	{ packageName: "@bastani/subagents", workspaceDirName: "subagents", distDirName: "subagents" },
	{ packageName: "@bastani/mcp", workspaceDirName: "mcp", distDirName: "mcp" },
	{ packageName: "@bastani/web-access", workspaceDirName: "web-access", distDirName: "web-access" },
	{ packageName: "@bastani/intercom", workspaceDirName: "intercom", distDirName: "intercom", mandatory: true },
];

const BUILTIN_PACKAGES: readonly BuiltinPackageDescriptor[] = WORKSPACE_BUILTINS.map(
	(spec): BuiltinPackageDescriptor => ({
		packageName: spec.packageName,
		distDirName: spec.distDirName,
		mandatory: spec.mandatory === true,
		requiredEntries: requiredEntriesForBuiltin(spec.distDirName),
		sourceCandidates: ({ here, packageDir, isSourceCheckout }) =>
			isSourceCheckout
				? [
						join(packageDir, "..", spec.workspaceDirName),
						...(here === undefined ? [] : [join(here, "..", "..", "..", spec.workspaceDirName)]),
					]
				: [],
	}),
);

function packageNameOf(packageJson: string): string | undefined {
	try {
		return (JSON.parse(stripBom(packageJson)) as { name?: string }).name;
	} catch {
		return undefined;
	}
}

function readPackageName(packageJsonPath: string): string | undefined {
	try {
		return packageNameOf(readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return undefined;
	}
}

function isPackageDir(dir: string, descriptor: BuiltinPackageDescriptor): boolean {
	return (
		descriptor.requiredEntries.some((entry) => existsSync(join(dir, entry))) &&
		readPackageName(join(dir, "package.json")) === descriptor.packageName
	);
}

async function isPackageDirAsync(dir: string, descriptor: BuiltinPackageDescriptor): Promise<boolean> {
	const entries = await Promise.all(descriptor.requiredEntries.map((entry) => exists(join(dir, entry))));
	if (!entries.includes(true)) return false;
	const packageJson = await readFile(join(dir, "package.json"), "utf-8").catch(() => undefined);
	return packageJson !== undefined && packageNameOf(packageJson) === descriptor.packageName;
}

function distCandidates(context: BuiltinPackageCandidateContext, descriptor: BuiltinPackageDescriptor): string[] {
	const { here, packageDir } = context;
	return [
		...(here === undefined ? [] : [join(here, "..", "builtin", descriptor.distDirName)]),
		join(packageDir, "builtin", descriptor.distDirName),
		join(packageDir, "dist", "builtin", descriptor.distDirName),
	];
}

function builtinCandidates(context: BuiltinPackageCandidateContext, descriptor: BuiltinPackageDescriptor): string[] {
	return [
		...new Set(
			[...descriptor.sourceCandidates(context), ...distCandidates(context, descriptor)].map((path) => resolve(path)),
		),
	];
}

function getBuiltinPackageCandidateContext(
	packageDir: string,
	isSourceCheckout: boolean,
): BuiltinPackageCandidateContext {
	// A compiled binary's app.js keeps the build machine's module URL. Where that
	// build tree still exists it would win over the shipped `builtin/` beside the
	// executable, so binaries resolve builtins from the package dir only (#3917).
	const here = isBunBinary ? undefined : moduleDirFromMetaUrl(import.meta.url);
	return { here, packageDir, isSourceCheckout };
}

interface BuiltinPackageDiscovery {
	readonly roots: ReadonlyMap<BuiltinPackageDescriptor, readonly string[]>;
	readonly mandatoryExtensionPaths: readonly string[];
}

const builtinPackageDiscoveries = new Map<string, BuiltinPackageDiscovery>();

function mandatoryRoots(roots: BuiltinPackageDiscovery["roots"]): string[] {
	return BUILTIN_PACKAGES.filter((descriptor) => descriptor.mandatory).flatMap(
		(descriptor) => roots.get(descriptor)?.slice(0, 1) ?? [],
	);
}

function manifestExtensionPathsOf(packageDir: string, packageJson: string): string[] {
	try {
		const manifest = JSON.parse(stripBom(packageJson)) as {
			atomic?: { extensions?: string[] };
			pi?: { extensions?: string[] };
		};
		return (manifest.atomic?.extensions ?? manifest.pi?.extensions ?? []).map((entry) => resolve(packageDir, entry));
	} catch {
		return [];
	}
}

function readManifestExtensionPaths(packageDir: string): string[] {
	try {
		return manifestExtensionPathsOf(packageDir, readFileSync(join(packageDir, "package.json"), "utf-8"));
	} catch {
		return [];
	}
}

function discoverBuiltinPackages(): BuiltinPackageDiscovery {
	const packageDir = getPackageDir();
	const known = builtinPackageDiscoveries.get(packageDir);
	if (known) return known;
	const context = getBuiltinPackageCandidateContext(packageDir, existsSync(join(packageDir, "src", "main.ts")));
	const roots = new Map(
		BUILTIN_PACKAGES.map(
			(descriptor) =>
				[
					descriptor,
					builtinCandidates(context, descriptor).filter((path) => isPackageDir(path, descriptor)),
				] as const,
		),
	);
	const discovery = { roots, mandatoryExtensionPaths: mandatoryRoots(roots).flatMap(readManifestExtensionPaths) };
	builtinPackageDiscoveries.set(packageDir, discovery);
	return discovery;
}

async function preloadBuiltinPackages(): Promise<void> {
	const packageDir = getPackageDir();
	if (builtinPackageDiscoveries.has(packageDir)) return;
	const context = getBuiltinPackageCandidateContext(packageDir, await exists(join(packageDir, "src", "main.ts")));
	const roots = new Map(
		await Promise.all(
			BUILTIN_PACKAGES.map(async (descriptor) => {
				const candidates = builtinCandidates(context, descriptor);
				const verified = await Promise.all(candidates.map((path) => isPackageDirAsync(path, descriptor)));
				return [descriptor, candidates.filter((_path, index) => verified[index])] as const;
			}),
		),
	);
	const manifests = await Promise.all(
		mandatoryRoots(roots).map(async (root) =>
			manifestExtensionPathsOf(root, await readFile(join(root, "package.json"), "utf-8").catch(() => "")),
		),
	);
	if (!builtinPackageDiscoveries.has(packageDir)) {
		builtinPackageDiscoveries.set(packageDir, { roots, mandatoryExtensionPaths: manifests.flat() });
	}
}

void preloadBuiltinPackages().catch(() => {});

/** Atomic-owned builtin package roots paired with their verified descriptors. */
export function getBuiltinPackageLocations(
	required = false,
	builtins?: Partial<Record<AtomicBuiltin, boolean>>,
): BuiltinPackageLocation[] {
	const { roots } = discoverBuiltinPackages();
	return BUILTIN_PACKAGES.flatMap((descriptor) => {
		if (builtins?.[descriptor.distDirName] === false) return [];
		const packageDir = roots.get(descriptor)?.[0];
		if (!packageDir && required) {
			throw Object.assign(new Error(`Builtin unavailable: ${descriptor.packageName}`), {
				code: "BuiltinUnavailable",
			});
		}
		return packageDir
			? [{ packageName: descriptor.packageName, distDirName: descriptor.distDirName, packageDir }]
			: [];
	});
}

/** Every verified shipped root, including alternate source/dist locations in a built checkout. */
export function getAllBuiltinPackageLocations(): BuiltinPackageLocation[] {
	const { roots } = discoverBuiltinPackages();
	return BUILTIN_PACKAGES.flatMap((descriptor) =>
		(roots.get(descriptor) ?? []).map((packageDir) => ({
			packageName: descriptor.packageName,
			distDirName: descriptor.distDirName,
			packageDir,
		})),
	);
}

/**
 * Built-in pi package roots shipped with this Atomic distribution.
 *
 * Development layout:
 *   packages/coding-agent/src/core -> packages/<builtin>
 *
 * npm/dist layout:
 *   packages/coding-agent/dist/core -> packages/coding-agent/dist/builtin/<package>
 *
 * Bun binary layout:
 *   process executable dir -> builtin/<package>
 */
export function getBuiltinPackagePaths(builtins?: Partial<Record<AtomicBuiltin, boolean>>): string[] {
	return getBuiltinPackageLocations(true, builtins).map(({ packageDir }) => packageDir);
}

/** Built-in package roots whose extensions Atomic must load in every model session. */
export function getMandatoryBuiltinPackagePaths(): string[] {
	return mandatoryRoots(discoverBuiltinPackages().roots);
}

/** Trusted extension entries resolved from Atomic's mandatory bundled packages. */
export function getMandatoryBuiltinExtensionPaths(): string[] {
	return [...discoverBuiltinPackages().mandatoryExtensionPaths];
}
