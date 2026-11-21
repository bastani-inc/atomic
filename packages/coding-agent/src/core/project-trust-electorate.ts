import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, getAgentDirs } from "../config.js";
import { isOverridePattern } from "./package-manager-resource-patterns.ts";

/** The extension sources startup loads before it decides a project's trust, as configured for this run. */
export interface ProjectTrustElectorateInput {
	/** The `-e` sources of this run. */
	readonly cliExtensionPaths: readonly string[] | undefined;
	/** Extension factories an SDK caller passed in addition to Atomic's own. */
	readonly sdkExtensionFactoryCount: number;
	/** Builtin package paths an SDK caller passed instead of Atomic's bundled packages. */
	readonly customBuiltinPackagePaths: readonly string[] | undefined;
	/** `--no-extensions`: settings, packages and the extensions folders load nothing. */
	readonly noExtensions: boolean;
	/** The global settings' `extensions` and `packages` entries. */
	readonly globalExtensions: readonly unknown[] | undefined;
	readonly globalPackages: readonly unknown[] | undefined;
	/** The Atomic home whose `extensions` folder loads automatically. */
	readonly agentDir: string;
}

/**
 * Whether `dir` holds anything the extensions folder could load: a `.ts` or `.js` file, a `package.json` that can name
 * extensions, or a folder or link the loader would look into. A folder that cannot be read counts as one.
 */
async function hasExtensionCandidates(dir: string): Promise<boolean> {
	try {
		// Stops at the first candidate: a folder of many files is not listed in full.
		for await (const entry of await opendir(dir)) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			if (entry.isDirectory() || entry.isSymbolicLink() || !entry.isFile()) return true;
			if (entry.name.endsWith(".ts") || entry.name.endsWith(".js") || entry.name === "package.json") return true;
		}
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/**
 * Whether an extension that loads before a project's trust is decided could register a `project_trust` handler, read
 * from the configuration alone, before any extension code runs. Atomic's own extensions and bundled packages register
 * none. Any other source counts, whether or not it registers a handler: only running it would tell, and a handler
 * answers ahead of a saved decision (#5693).
 */
export async function extensionsCanDecideProjectTrust(input: ProjectTrustElectorateInput): Promise<boolean> {
	if ((input.cliExtensionPaths?.length ?? 0) > 0) return true;
	if (input.sdkExtensionFactoryCount > 0) return true;
	if ((input.customBuiltinPackagePaths?.length ?? 0) > 0) return true;
	if (input.noExtensions) return false;
	if ((input.globalPackages?.length ?? 0) > 0) return true;
	if ((input.globalExtensions ?? []).some((entry) => typeof entry !== "string" || !isOverridePattern(entry)))
		return true;
	const homes = input.agentDir === getAgentDir() ? getAgentDirs() : [input.agentDir];
	for (const home of homes) if (await hasExtensionCandidates(join(home, "extensions"))) return true;
	return false;
}
