import { canonicalizePath } from "../utils/paths.ts";
import type {
	PathMetadata,
	ResolvedPaths,
	ResolvedResource,
	ResourceAccumulator,
	ResourceMap,
	ResourceType,
} from "./package-manager-types.ts";

function resourcePrecedenceRank(m: PathMetadata): number {
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
	};
}

export function toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
	const mapToResolved = (entries: ResourceMap): ResolvedResource[] => {
		const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
			path,
			enabled,
			metadata,
		}));
		resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

		const seen = new Set<string>();
		return resolved.filter((entry) => {
			const canonicalPath = canonicalizePath(entry.path);
			if (seen.has(canonicalPath)) return false;
			seen.add(canonicalPath);
			return true;
		});
	};

	return {
		extensions: mapToResolved(accumulator.extensions),
		skills: mapToResolved(accumulator.skills),
		prompts: mapToResolved(accumulator.prompts),
		themes: mapToResolved(accumulator.themes),
		workflows: mapToResolved(accumulator.workflows),
	};
}
