import { dirname, join } from "node:path";
import { getPathComparisonKey, pathsEqual } from "../utils/paths.ts";
import type { PathMetadata, ResolvedResource } from "./package-manager-types.ts";

export interface LegacyWorkflowFiles {
	readonly files: readonly {
		readonly path: string;
		readonly scope: "project" | "user" | "package" | "settings" | "borrowed";
	}[];
	readonly total: number;
}

const MAX_LISTED_FILES = 20;

function recipeScope(metadata: PathMetadata): LegacyWorkflowFiles["files"][number]["scope"] {
	if (metadata.borrowedProjectLocal) return "borrowed";
	if (metadata.origin === "package") return "package";
	if (metadata.source === "local") return "settings";
	return metadata.scope === "user" ? "user" : "project";
}

/** Summarize discovery after project trust; a borrowed source needs its own positive decision. */
export function findLegacyWorkflowFiles(
	trustedBorrowedSources: ReadonlySet<string> | undefined,
	...sources: (readonly ResolvedResource[])[]
): LegacyWorkflowFiles {
	const files: Array<LegacyWorkflowFiles["files"][number]> = [];
	const seen = new Set<string>();
	for (const resources of sources) {
		for (const { path, enabled, metadata } of resources) {
			if (!enabled || !/\.(?:ts|js|mjs|cjs)$/.test(path) || path.endsWith(".d.ts")) continue;
			if (metadata.borrowedProjectLocal && !trustedBorrowedSources?.has(metadata.source)) continue;
			// Automatic project/user discovery loaded only files directly in workflows/, not helpers or run artifacts.
			if (
				metadata.source === "auto" &&
				(!metadata.baseDir || !pathsEqual(dirname(path), join(metadata.baseDir, "workflows")))
			)
				continue;
			const key = getPathComparisonKey(path);
			if (seen.has(key)) continue;
			seen.add(key);
			if (files.length === MAX_LISTED_FILES) continue;
			files.push({ path, scope: recipeScope(metadata) });
		}
	}
	return { files, total: seen.size };
}

export function legacyWorkflowSection(catalog?: LegacyWorkflowFiles): string | undefined {
	if (!catalog?.total) return undefined;
	return [
		"When the user asks for an earlier workflow, read the matching file as text, never import or execute the module. Use the workflow-files skill when available to carry out its steps with codemode and subagents. A file's presence is not a request to run it.",
		...catalog.files.map(
			({ scope, path }) => `${scope}: ${JSON.stringify(path).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}`,
		),
		...(catalog.total > catalog.files.length ? [`+${catalog.total - catalog.files.length} more`] : []),
	].join("\n");
}
