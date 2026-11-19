import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import { getPathComparisonKey, pathsEqual } from "../utils/paths.ts";
import type { ResolvedResource } from "./package-manager-types.ts";

export interface LegacyWorkflowFiles {
	readonly files: readonly {
		readonly path: string;
		readonly scope: "project" | "global";
		readonly targetSkillsDir: string;
	}[];
	readonly total: number;
}

const MAX_LISTED_FILES = 20;

interface ConversionContext {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
	trustedBorrowedSources?: ReadonlySet<string>;
}

/** Locate source files and their conversion scope; never load the module or write a skill during discovery. */
export function findLegacyWorkflowFiles(
	{ cwd, agentDir, projectTrusted, trustedBorrowedSources }: ConversionContext,
	...sources: (readonly ResolvedResource[])[]
): LegacyWorkflowFiles {
	const files: Array<LegacyWorkflowFiles["files"][number]> = [];
	const seen = new Set<string>();
	const projectSkillsDir = join(cwd, CONFIG_DIR_NAME, "skills");
	const globalSkillsDir = join(agentDir, "skills");
	for (const resources of sources) {
		for (const { path, enabled, metadata } of resources) {
			const fileName = process.platform === "win32" ? path.toLowerCase() : path;
			if (!enabled || !/\.(?:ts|js|mjs|cjs)$/.test(fileName) || fileName.endsWith(".d.ts")) continue;
			const scope = metadata.scope === "user" ? "global" : "project";
			if (scope === "project" && !projectTrusted) continue;
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
			files.push({ path, scope, targetSkillsDir: scope === "project" ? projectSkillsDir : globalSkillsDir });
		}
	}
	return { files, total: seen.size };
}

export function legacyWorkflowSection(catalog?: LegacyWorkflowFiles): string | undefined {
	if (!catalog?.total) return undefined;
	return [
		"If asked to migrate or run an earlier workflow file, read it as text. Use workflow-files and skill-creator to create a new skill in its targetSkillsDir. Never import, execute, modify or delete the original, or overwrite an existing skill. Run the new skill with codemode and subagents only when execution was requested. Discovery alone authorizes no writes.",
		...catalog.files.map((file) => JSON.stringify(file).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")),
		...(catalog.total > catalog.files.length ? [`+${catalog.total - catalog.files.length} more`] : []),
	].join("\n");
}
