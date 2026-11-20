import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME } from "../config.js";
import { stripBom } from "../utils/text.ts";
import type { McpServerConfig } from "./mcp-servers.ts";
import type { FileKind, PackageFilter, PiManifest } from "./package-manager-types.ts";

const MANIFEST_ENTRY_FIELDS = ["extensions", "skills", "prompts", "themes", "storageAdapters", "agents"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep the object-valued entries of an `mcpServers` map; the MCP adapter validates their fields. */
export function sanitizeMcpServers(value: unknown): Record<string, McpServerConfig> | undefined {
	if (!isRecord(value)) return undefined;
	const servers: Record<string, McpServerConfig> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (isRecord(entry)) servers[name] = entry as unknown as McpServerConfig;
	}
	return servers;
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
	for (const name of ["workflows", "workflow"] as const) {
		const entries = value[name];
		if (Array.isArray(entries) && entries.every((entry): entry is string => typeof entry === "string")) {
			manifest.legacyWorkflowFiles = entries;
			break;
		}
	}
	const mcpServers = typeof value.mcpServers === "string" ? value.mcpServers : sanitizeMcpServers(value.mcpServers);
	if (mcpServers !== undefined) manifest.mcpServers = mcpServers;
	return manifest;
}

export function getManifestFromPackageJson(pkg: unknown): PiManifest | null {
	if (!isRecord(pkg)) return null;
	return sanitizeManifest(pkg[APP_NAME]) ?? sanitizeManifest(pkg.pi);
}

export function readPiManifestFile(packageJsonPath: string): PiManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(stripBom(content)) as Record<string, unknown>;
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

export function conventionDirsForResource(packageRoot: string, resourceType: FileKind): string[] {
	// A package ships subagents only through its manifest's `agents` field: an `agents/` directory alone is not one.
	if (resourceType === "agents") return [];
	if (resourceType === "legacyWorkflowFiles") {
		return [join(packageRoot, "workflows"), join(packageRoot, "workflow")];
	}
	return [join(packageRoot, resourceType)];
}

/** Old package filters restrict only the paths the migration catalog may advertise. */
export function legacyWorkflowFilePatterns(filter: PackageFilter | undefined): string[] | undefined {
	if (!filter || !("workflows" in filter)) return undefined;
	const entries = filter.workflows;
	return Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string") : [];
}
