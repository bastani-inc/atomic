/**
 * `atomic blueprint cache-key` prints the cache contract of a repository for a runner's cache action: the entries its
 * blueprint's `cache:` section declares, plus Atomic's Git object store and extension transpile cache (#4748).
 */

import { resolve } from "node:path";
import { APP_NAME } from "../config.js";
import {
	type BlueprintCacheKeyFormat,
	blueprintCacheKeys,
	formatBlueprintCacheKeys,
} from "../core/resume/blueprint/cache.ts";
import { runGit } from "../core/worktree-snapshot/git.ts";

const HELP = `Usage:
  ${APP_NAME} blueprint cache-key [dir] [--format text|json|github-output]

Commands:
  cache-key  Print the cache entries of the repository at [dir] (default: the current directory)
             for a runner's cache action such as actions/cache: a key, a restore prefix and the
             paths of each. "stores" holds the package stores the blueprint's cache: section
             declares, "build" its kind: build output, "git" Atomic's Git object store of the
             repository, and "atomic" Atomic's extension transpile cache. Paths that could carry
             credentials are left out with a warning on stderr. Atomic never uploads or downloads
             caches; save them only from trusted default-branch jobs.

Options:
  --format <format>  text (default), json, or github-output: <name>-key, <name>-restore-prefix and
                     <name>-paths lines to append to $GITHUB_OUTPUT`;

const FORMATS: readonly BlueprintCacheKeyFormat[] = ["text", "json", "github-output"];

export type BlueprintCommand =
	| { readonly kind: "help" }
	| { readonly kind: "cache-key"; readonly dir: string | undefined; readonly format: BlueprintCacheKeyFormat }
	| { readonly kind: "error"; readonly message: string };

/** Parse the arguments after `blueprint`. */
export function parseBlueprintCommand(args: readonly string[]): BlueprintCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
	}
	if (command !== "cache-key") return { kind: "error", message: `Unknown command "${command}". Use cache-key.` };
	let format: BlueprintCacheKeyFormat = "text";
	const positional: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (arg === "--format" || arg.startsWith("--format=")) {
			const value = arg === "--format" ? rest[++index] : arg.slice("--format=".length);
			const known = FORMATS.find((candidate) => candidate === value);
			if (known === undefined) return { kind: "error", message: "--format must be text, json or github-output." };
			format = known;
		} else if (arg.startsWith("-")) {
			return { kind: "error", message: `Unknown option ${arg.split("=")[0]}.` };
		} else {
			positional.push(arg);
		}
	}
	if (positional.length > 1) return { kind: "error", message: "Pass at most one directory." };
	return { kind: "cache-key", dir: positional[0], format };
}

export interface BlueprintCommandOptions {
	readonly cwd: string;
	readonly agentDir: string;
	/** What `~` in a cache path expands to. Default: the user's home directory. */
	readonly home?: string;
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
}

/** Run `atomic blueprint <args>` and return the exit code: 0, 1 when the keys cannot be computed, 2 for bad usage. */
export async function runBlueprintCommand(args: readonly string[], options: BlueprintCommandOptions): Promise<number> {
	const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
	const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
	const command = parseBlueprintCommand(args);
	if (command.kind === "help") {
		stdout(`${HELP}\n`);
		return 0;
	}
	if (command.kind === "error") {
		stderr(`Error: ${command.message} Use "${APP_NAME} blueprint --help" for usage.\n`);
		return 2;
	}
	try {
		const root = await repositoryRoot(resolve(options.cwd, command.dir ?? "."));
		const keys = await blueprintCacheKeys(root, {
			agentDir: options.agentDir,
			...(options.home === undefined ? {} : { home: options.home }),
		});
		for (const warning of keys.warnings) stderr(`Warning: ${warning}\n`);
		stdout(formatBlueprintCacheKeys(keys, command.format));
		return 0;
	} catch (error) {
		stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/** The top level of the checkout `directory` is in, else `directory` itself. */
async function repositoryRoot(directory: string): Promise<string> {
	const { stdout, exitCode } = await runGit(["rev-parse", "--show-toplevel"], {
		cwd: directory,
		allowExitCodes: [128],
	});
	return exitCode === 0 ? resolve(stdout.toString("utf8").trim()) : directory;
}
