import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "../config.ts";
import type { PiManifest, ResourceType } from "./package-manager-types.ts";

export function getManifestFromPackageJson(pkg: Record<string, unknown>): PiManifest | null {
	const appManifest = pkg[APP_NAME];
	if (appManifest && typeof appManifest === "object" && !Array.isArray(appManifest)) {
		return appManifest as PiManifest;
	}
	const legacyManifest = pkg.pi;
	if (legacyManifest && typeof legacyManifest === "object" && !Array.isArray(legacyManifest)) {
		return legacyManifest as PiManifest;
	}
	return null;
}

export function readPiManifestFile(packageJsonPath: string): PiManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as Record<string, unknown>;
		return getManifestFromPackageJson(pkg);
	} catch {
		return null;
	}
}

export function readPiManifest(packageRoot: string): PiManifest | null {
	const packageJsonPath = join(packageRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		return null;
	}
	return readPiManifestFile(packageJsonPath);
}

export function conventionDirsForResource(packageRoot: string, resourceType: ResourceType): string[] {
	if (resourceType === "workflows") {
		return [join(packageRoot, "workflows"), join(packageRoot, "workflow")];
	}
	return [join(packageRoot, resourceType)];
}

export function manifestEntriesForResource(
	manifest: PiManifest | null,
	resourceType: ResourceType,
): string[] | undefined {
	if (!manifest) return undefined;
	if (resourceType === "workflows") return manifest.workflows ?? manifest.workflow;
	return manifest[resourceType];
}
