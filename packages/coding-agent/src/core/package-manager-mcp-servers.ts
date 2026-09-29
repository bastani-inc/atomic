import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { stripBom } from "../utils/text.ts";
import type { McpServerConfig } from "./mcp-servers.ts";
import { getManifestFromPackageJson, sanitizeMcpServers } from "./package-manager-manifest.ts";
import { applyAutoloadDisabledNamePatterns, applyNamePatterns } from "./package-manager-resource-patterns.ts";
import type { PackageFilter, PathMetadata, ResolvedMcpServer } from "./package-manager-types.ts";

interface McpServersFile {
	mcpServers?: object;
	"mcp-servers"?: object;
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(stripBom(await readFile(path, "utf-8"))) as T;
}

async function readManifestMcpServers(
	packageRoot: string,
): Promise<{ path: string; servers: Record<string, McpServerConfig> } | undefined> {
	const packageJsonPath = resolve(packageRoot, "package.json");
	try {
		const declared = getManifestFromPackageJson(await readJson<object>(packageJsonPath))?.mcpServers;
		if (declared === undefined) return undefined;
		if (typeof declared !== "string") return { path: packageJsonPath, servers: declared };
		const path = resolve(packageRoot, declared);
		const file = await readJson<McpServersFile | null>(path);
		const servers = sanitizeMcpServers(file?.mcpServers ?? file?.["mcp-servers"]);
		return servers ? { path, servers } : undefined;
	} catch {
		return undefined;
	}
}

function selectMcpServers(names: string[], filter: PackageFilter | undefined): Map<string, boolean> {
	const patterns = filter?.mcpServers;
	if (filter?.autoload === false) return applyAutoloadDisabledNamePatterns(names, patterns ?? []);
	const enabled = patterns === undefined ? new Set(names) : applyNamePatterns(names, patterns);
	return new Map(names.map((name) => [name, patterns?.length !== 0 && enabled.has(name)]));
}

/** A package cannot know the user's project directory, so a relative `cwd` names a directory in the package. */
function resolvePackageCwd(config: McpServerConfig, packageRoot: string): McpServerConfig {
	const { cwd } = config;
	if (typeof cwd !== "string" || isAbsolute(cwd) || cwd.startsWith("~") || cwd.startsWith("$")) return config;
	return { ...config, cwd: resolve(packageRoot, cwd) };
}

/** Add a package's manifest `mcpServers`, honoring the package filter's `mcpServers` patterns. */
export async function collectPackageMcpServers(
	packageRoot: string,
	target: Map<string, ResolvedMcpServer>,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): Promise<void> {
	const declared = await readManifestMcpServers(packageRoot);
	if (!declared) return;
	for (const [name, enabled] of selectMcpServers(Object.keys(declared.servers), filter)) {
		const key = `${declared.path}\0${name}`;
		if (target.has(key)) continue;
		const config = resolvePackageCwd(declared.servers[name], packageRoot);
		target.set(key, { name, config, enabled, path: declared.path, metadata });
	}
}
