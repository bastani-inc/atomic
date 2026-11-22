import { getAgentDir, getDocsPath, getExamplesPath, getReadmePath } from "../../packages/coding-agent/src/config.js";
import { getDefaultSessionDirPath } from "../../packages/coding-agent/src/core/session-manager-paths.js";
import { defaultSessionDatabasePath } from "../../packages/coding-agent/src/core/storage/file-identity.js";

/** Inert placeholder containing no letters, digits, or path separators. */
const ENVIRONMENT_PATH_PLACEHOLDER = "[...]";

/**
 * Single-pass leftmost-longest literal replacement so replaced placeholders are never re-scanned and adjacent
 * surrounding characters are never concatenated together.
 */
function stripLiteralPaths(text: string, paths: readonly string[]): string {
	const sorted = [...new Set(paths.filter((path) => path.length > 0))].sort((a, b) => b.length - a.length);
	if (sorted.length === 0) return text;
	let result = "";
	for (let index = 0; index < text.length; ) {
		const match = sorted.find((candidate) => text.startsWith(candidate, index));
		if (match !== undefined) {
			result += ENVIRONMENT_PATH_PLACEHOLDER;
			index += match.length;
		} else {
			result += text[index]!;
			index += 1;
		}
	}
	return result;
}

export interface StripSystemPromptPathsOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly extraPaths?: readonly string[];
}

/**
 * Replaces the environment-derived paths embedded in a built system prompt (working directory, agent directory
 * database and session folder, and installed documentation roots) with `[...]` so assertions test the prompt's
 * instructions rather than accidental substrings of temporary directories, home directories, or checkout locations.
 */
export function stripSystemPromptEnvironmentPaths(prompt: string, options: StripSystemPromptPathsOptions): string {
	const agentDir = options.agentDir ?? getAgentDir();
	const normalizedCwd = options.cwd.replace(/\\/g, "/");
	const withoutCwdLine = prompt.replaceAll(
		`Current working directory: ${normalizedCwd}`,
		`Current working directory: ${ENVIRONMENT_PATH_PLACEHOLDER}`,
	);
	return stripLiteralPaths(withoutCwdLine, [
		defaultSessionDatabasePath(agentDir),
		getDefaultSessionDirPath(options.cwd, agentDir),
		getReadmePath(),
		getDocsPath(),
		getExamplesPath(),
		...(options.extraPaths ?? []),
	]);
}
