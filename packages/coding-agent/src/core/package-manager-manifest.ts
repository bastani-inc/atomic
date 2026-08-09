import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "../config.ts";
import type { PiManifest, ResourceType } from "./package-manager-types.ts";

const MANIFEST_ENTRY_FIELDS = ["extensions", "skills", "prompts", "themes", "workflows", "workflow"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeManifest(value: unknown): PiManifest | null {
	if (!isRecord(value)) return null;
	const manifest: PiManifest = {};
	for (const field of MANIFEST_ENTRY_FIELDS) {
		const entries = value[field];
		if (Array.isArray(entries) && entries.every((entry): entry is string => typeof entry === "string")) {
			manifest[field] = entries;
		}
	}
	return manifest;
}

export function getManifestFromPackageJson(pkg: unknown): PiManifest | null {
	if (!isRecord(pkg)) return null;
	return sanitizeManifest(pkg[APP_NAME]) ?? sanitizeManifest(pkg.pi);
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
