import type {
	PathMetadata,
	ResolvedPaths,
	ResolvedResource,
	ResourceAccumulator,
	ResourceMap,
	ResourceType,
} from "./package-manager-types.ts";
import { getResourcePathKeyAsync } from "./source-info.ts";

function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.source === "builtin") return 6;
	if (m.origin === "package") return 4;
	if (m.borrowedProjectLocal) return 5;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

export function getTargetMap(accumulator: ResourceAccumulator, resourceType: ResourceType): ResourceMap {
	switch (resourceType) {
		case "extensions":
			return accumulator.extensions;
		case "skills":
			return accumulator.skills;
		case "prompts":
			return accumulator.prompts;
		case "themes":
			return accumulator.themes;
		case "workflows":
			return accumulator.workflows;
		default:
			throw new Error(`Unknown resource type: ${resourceType}`);
	}
}

export function addResource(map: ResourceMap, path: string, metadata: PathMetadata, enabled: boolean): void {
	if (!path) return;
	if (!map.has(path)) {
		map.set(path, { metadata, enabled });
	}
}

export function createAccumulator(): ResourceAccumulator {
	return {
		extensions: new Map(),
		skills: new Map(),
		prompts: new Map(),
		themes: new Map(),
		workflows: new Map(),
		mcpServers: new Map(),
	};
}

export async function toResolvedPaths(accumulator: ResourceAccumulator): Promise<ResolvedPaths> {
	const mapToResolved = async (entries: ResourceMap): Promise<ResolvedResource[]> => {
		const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
			path,
			enabled,
			metadata,
		}));
		resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

		const pathKeys = await Promise.all(resolved.map((entry) => getResourcePathKeyAsync(entry.path)));
		const seen = new Set<string>();
		return resolved.filter((_entry, index) => {
			const pathKey = pathKeys[index]!;
			if (seen.has(pathKey)) return false;
			seen.add(pathKey);
			return true;
		});
	};

	const [extensions, skills, prompts, themes, workflows] = await Promise.all([
		mapToResolved(accumulator.extensions),
		mapToResolved(accumulator.skills),
		mapToResolved(accumulator.prompts),
		mapToResolved(accumulator.themes),
		mapToResolved(accumulator.workflows),
	]);
	return { extensions, skills, prompts, themes, workflows, mcpServers: [...accumulator.mcpServers.values()] };
}
