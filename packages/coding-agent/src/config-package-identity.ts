import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { BUILTIN_PACKAGE_DIR_NAMES } from "./core/builtin-install-layout.ts";
import { stripBom } from "./utils/text.ts";

export const COMPANION_BUILTIN_PACKAGE_NAMES: readonly string[] = BUILTIN_PACKAGE_DIR_NAMES.map(
	(dirName) => `@bastani/${dirName}`,
);

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

export type PackageIdentityJson = {
	readonly name?: string;
	readonly atomicConfig?: JsonObject;
	readonly piConfig?: JsonObject;
};

export function isCompanionBuiltinPackageName(name: string | undefined): boolean {
	return name !== undefined && COMPANION_BUILTIN_PACKAGE_NAMES.includes(name);
}

export function packageJsonDefinesAppIdentity(pkg: PackageIdentityJson): boolean {
	if (pkg.name === "@bastani/atomic" || pkg.name === "@mariozechner/pi") return true;
	return pkg.atomicConfig !== undefined || pkg.piConfig !== undefined;
}

/**
 * Walk from a bundled or compiled module directory to the Atomic app package.
 *
 * Prebundled companion extensions live under `dist/builtin/<name>/` with their
 * own `package.json`. The first package.json from those bundles is
 * `@bastani/workflows` (or another companion), which must not become APP_NAME.
 */
export function resolvePackageDirFrom(startDir: string): string {
	let dir = startDir;
	let firstPackageDir: string | undefined;
	while (dir !== dirname(dir)) {
		const packageJsonPath = join(dir, "package.json");
		if (existsSync(packageJsonPath)) {
			firstPackageDir ??= dir;
			if (shouldUsePackageDir(readPackageIdentity(packageJsonPath))) {
				return dir;
			}
		}
		dir = dirname(dir);
	}
	return firstPackageDir ?? startDir;
}

function shouldUsePackageDir(pkg: PackageIdentityJson): boolean {
	if (packageJsonDefinesAppIdentity(pkg)) return true;
	return !isCompanionBuiltinPackageName(pkg.name);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPackageIdentity(packageJsonPath: string): PackageIdentityJson {
	try {
		const parsed: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isJsonValue(parsed) || !isJsonObject(parsed)) return {};
		const name = parsed.name;
		const atomicConfig = parsed.atomicConfig;
		const piConfig = parsed.piConfig;
		return {
			...(typeof name === "string" ? { name } : {}),
			...(atomicConfig !== undefined && isJsonObject(atomicConfig) ? { atomicConfig } : {}),
			...(piConfig !== undefined && isJsonObject(piConfig) ? { piConfig } : {}),
		};
	} catch {
		// Unreadable or invalid JSON is not an app identity package.
	}
	return {};
}
