/**
 * The package-manager stores `atomic blueprint cache-key` detects (#4748): which lockfiles at the repository root name a
 * package manager, and where that manager keeps its download store. Locations follow each tool's documented default
 * and the environment variables that move it, as the `actions/setup-*` actions and the tools themselves resolve them.
 */

import { stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { BlueprintPlatform } from "./types.ts";

/** What a store location is computed from. */
export interface StoreLocationContext {
	readonly os: BlueprintPlatform;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Whether a root-relative file exists in the repository. */
	readonly present: ReadonlySet<string>;
}

export interface PackageManagerStores {
	readonly manager: string;
	/** Root-relative files whose content keys the stores; the present ones are read. */
	readonly keyFiles: readonly string[];
	/** Absolute store directories, in a fixed order. */
	readonly paths: readonly string[];
}

interface PackageManager {
	readonly name: string;
	/** Root-relative files whose presence names the manager; each one also keys its stores. */
	readonly files: readonly string[];
	readonly stores: (context: StoreLocationContext) => readonly string[];
}

/** A set environment variable; an empty one is unset. */
function variable(context: StoreLocationContext, name: string): string | undefined {
	const value = context.env[name];
	return value === undefined || value === "" ? undefined : value;
}

function underHome(context: StoreLocationContext, ...segments: string[]): string {
	return join(context.home, ...segments);
}

/** `%LOCALAPPDATA%`, else its default under the home directory. */
function localAppData(context: StoreLocationContext): string {
	return variable(context, "LOCALAPPDATA") ?? underHome(context, "AppData", "Local");
}

/** The XDG cache directory on Linux, `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows. */
function userCache(context: StoreLocationContext): string {
	if (context.os === "macos") return underHome(context, "Library", "Caches");
	if (context.os === "windows") return localAppData(context);
	return variable(context, "XDG_CACHE_HOME") ?? underHome(context, ".cache");
}

const PACKAGE_MANAGERS: readonly PackageManager[] = [
	{
		name: "npm",
		files: ["package-lock.json", "npm-shrinkwrap.json"],
		stores: (context) => [
			variable(context, "npm_config_cache") ??
				(context.os === "windows" ? join(localAppData(context), "npm-cache") : underHome(context, ".npm")),
		],
	},
	{
		name: "pnpm",
		files: ["pnpm-lock.yaml"],
		stores: (context) => {
			const configured = variable(context, "npm_config_store_dir");
			if (configured !== undefined) return [configured];
			const pnpmHome = variable(context, "PNPM_HOME");
			if (pnpmHome !== undefined) return [join(pnpmHome, "store")];
			if (context.os === "macos") return [underHome(context, "Library", "pnpm", "store")];
			if (context.os === "windows") return [join(localAppData(context), "pnpm", "store")];
			const data = variable(context, "XDG_DATA_HOME") ?? underHome(context, ".local", "share");
			return [join(data, "pnpm", "store")];
		},
	},
	{
		name: "yarn",
		files: ["yarn.lock"],
		stores: (context) => {
			// Yarn 2+ reads `.yarnrc.yml` and keeps a global cache; Yarn 1 keeps its cache in the user cache directory.
			if (context.present.has(".yarnrc.yml")) {
				return [join(variable(context, "YARN_GLOBAL_FOLDER") ?? underHome(context, ".yarn", "berry"), "cache")];
			}
			const configured = variable(context, "YARN_CACHE_FOLDER");
			if (configured !== undefined) return [configured];
			if (context.os === "macos") return [join(userCache(context), "Yarn")];
			if (context.os === "windows") return [join(localAppData(context), "Yarn", "Cache")];
			return [join(userCache(context), "yarn")];
		},
	},
	{
		name: "bun",
		files: ["bun.lock", "bun.lockb"],
		stores: (context) => [
			variable(context, "BUN_INSTALL_CACHE_DIR") ??
				join(variable(context, "BUN_INSTALL") ?? underHome(context, ".bun"), "install", "cache"),
		],
	},
	{
		name: "cargo",
		files: ["Cargo.lock"],
		stores: (context) => {
			const cargoHome = variable(context, "CARGO_HOME") ?? underHome(context, ".cargo");
			return [join(cargoHome, "registry"), join(cargoHome, "git")];
		},
	},
	{
		name: "uv",
		files: ["uv.lock"],
		// uv uses the XDG cache directory on macOS too.
		stores: (context) => [
			variable(context, "UV_CACHE_DIR") ??
				(context.os === "windows"
					? join(localAppData(context), "uv", "cache")
					: join(variable(context, "XDG_CACHE_HOME") ?? underHome(context, ".cache"), "uv")),
		],
	},
	{
		name: "pip",
		files: ["requirements.txt", "Pipfile.lock"],
		stores: (context) => [
			variable(context, "PIP_CACHE_DIR") ??
				join(userCache(context), context.os === "windows" ? join("pip", "Cache") : "pip"),
		],
	},
	{
		name: "poetry",
		files: ["poetry.lock"],
		stores: (context) => [
			variable(context, "POETRY_CACHE_DIR") ??
				join(userCache(context), context.os === "windows" ? join("pypoetry", "Cache") : "pypoetry"),
		],
	},
	{
		name: "go",
		files: ["go.sum"],
		stores: (context) => {
			const gopath = variable(context, "GOPATH")?.split(delimiter)[0] || underHome(context, "go");
			return [
				variable(context, "GOMODCACHE") ?? join(gopath, "pkg", "mod"),
				variable(context, "GOCACHE") ?? join(userCache(context), "go-build"),
			];
		},
	},
	{
		name: "gradle",
		files: [
			"gradle.lockfile",
			"gradle/wrapper/gradle-wrapper.properties",
			"build.gradle",
			"build.gradle.kts",
			"settings.gradle",
			"settings.gradle.kts",
		],
		stores: (context) => {
			const gradleHome = variable(context, "GRADLE_USER_HOME") ?? underHome(context, ".gradle");
			return [join(gradleHome, "caches"), join(gradleHome, "wrapper")];
		},
	},
	{
		name: "maven",
		files: ["pom.xml"],
		stores: (context) => [underHome(context, ".m2", "repository")],
	},
];

/** Every root-relative file detection looks at. */
const DETECTION_FILES: readonly string[] = [
	...new Set([...PACKAGE_MANAGERS.flatMap((manager) => manager.files), ".yarnrc.yml"]),
];

/** The root-relative detection files that exist as files under `root`. */
async function presentFiles(root: string): Promise<ReadonlySet<string>> {
	const found = await Promise.all(
		DETECTION_FILES.map(async (file) => {
			try {
				return (await stat(join(root, file))).isFile() ? file : undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return new Set(found.filter((file) => file !== undefined));
}

/** The stores of each package manager whose lockfile or build file is at the repository root `root`, in a fixed order. */
export async function detectPackageManagerStores(
	root: string,
	context: Omit<StoreLocationContext, "present">,
): Promise<readonly PackageManagerStores[]> {
	const present = await presentFiles(root);
	const full: StoreLocationContext = { ...context, present };
	return PACKAGE_MANAGERS.filter((manager) => manager.files.some((file) => present.has(file))).map((manager) => ({
		manager: manager.name,
		keyFiles: manager.files.filter((file) => present.has(file)),
		paths: manager.stores(full).map((path) => resolve(path)),
	}));
}
