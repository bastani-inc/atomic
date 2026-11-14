/**
 * `atomic blueprint cache-key` prints the cache contract of a repository for a runner's cache action: the entries its
 * blueprint's `cache:` section declares, plus Atomic's Git object store and extension transpile cache (#4748).
 * `atomic blueprint prebuild` builds a repository ahead of time into an idle worktree a later resume claims, and with
 * `--park` moves its build output where the cache contract's `build` entry saves it from.
 */

import { resolve } from "node:path";
import { APP_NAME } from "../config.js";
import {
	type BlueprintCacheKeyFormat,
	blueprintCacheKeys,
	formatBlueprintCacheKeys,
} from "../core/resume/blueprint/cache.ts";
import { prebuildRepository } from "../core/resume/blueprint/prebuild.ts";
import { resumeStoreDir } from "../core/resume/session-resume.ts";
import { formatResumeTimings } from "../core/resume/timings.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { runGit } from "../core/worktree-snapshot/git.ts";

const HELP = `Usage:
  ${APP_NAME} blueprint cache-key [dir] [--format text|json|github-output]
  ${APP_NAME} blueprint prebuild [dir] [--park] [--approve]

Commands:
  cache-key  Print the cache entries of the repository at [dir] (default: the current directory)
             for a runner's cache action such as actions/cache: a key, a restore prefix and the
             paths of each. "stores" holds the package stores the blueprint's cache: section
             declares, "build" its kind: build output, "git" Atomic's Git object store of the
             repository, and "atomic" Atomic's extension transpile cache. Paths that could carry
             credentials are left out with a warning on stderr. Atomic never uploads or downloads
             caches; save them only from trusted default-branch jobs.
  prebuild   Restore the committed HEAD of the repository at [dir] into a new restored worktree,
             build it with its blueprints (initialize and maintenance), and leave it idle, so a
             later resume of a session of the repository claims it ready-built. Only committed
             files are restored; ignored and untracked files such as .env are not. A build that
             fails removes the new worktree and keeps earlier ones. Runs project code: only for a
             trusted project ("defaultProjectTrust": "always", a saved decision, or --approve).

Options:
  --format <format>  text (default), json, or github-output: <name>-key, <name>-restore-prefix and
                     <name>-paths lines to append to $GITHUB_OUTPUT
  --park             (prebuild) Move the blueprint's kind: build output into the seed directory that
                     the "build" cache entry saves, for a resume on another machine to adopt
  --approve, -a      (prebuild) Trust the project for this run`;

const FORMATS: readonly BlueprintCacheKeyFormat[] = ["text", "json", "github-output"];

export type BlueprintCommand =
	| { readonly kind: "help" }
	| { readonly kind: "cache-key"; readonly dir: string | undefined; readonly format: BlueprintCacheKeyFormat }
	| {
			readonly kind: "prebuild";
			readonly dir: string | undefined;
			readonly park: boolean;
			readonly approve: boolean;
	  }
	| { readonly kind: "error"; readonly message: string };

/** Parse the arguments after `blueprint`. */
export function parseBlueprintCommand(args: readonly string[]): BlueprintCommand {
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		return { kind: "help" };
	}
	if (command !== "cache-key" && command !== "prebuild") {
		return { kind: "error", message: `Unknown command "${command}". Use cache-key or prebuild.` };
	}
	let format: BlueprintCacheKeyFormat = "text";
	let park = false;
	let approve = false;
	const positional: string[] = [];
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index]!;
		if (command === "prebuild" && arg === "--park") park = true;
		else if (command === "prebuild" && (arg === "--approve" || arg === "-a")) approve = true;
		else if (command === "cache-key" && (arg === "--format" || arg.startsWith("--format="))) {
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
	if (command === "prebuild") return { kind: "prebuild", dir: positional[0], park, approve };
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
		if (command.kind === "prebuild") return await prebuild(root, command, options, stdout, stderr);
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

/** `atomic blueprint prebuild`: 0 when an idle worktree is ready, 1 when the project is untrusted or the build failed. */
async function prebuild(
	root: string,
	command: Extract<BlueprintCommand, { kind: "prebuild" }>,
	options: BlueprintCommandOptions,
	stdout: (text: string) => void,
	stderr: (text: string) => void,
): Promise<number> {
	const settings = SettingsManager.create(root, options.agentDir, { projectTrusted: false });
	const trusted =
		command.approve ||
		(new ProjectTrustStore(options.agentDir).get(root) ?? settings.getDefaultProjectTrust() === "always");
	if (!trusted) {
		stderr(
			`Error: ${root} is not a trusted project, and a prebuild runs its blueprints. Trust it, or pass --approve.\n`,
		);
		return 1;
	}
	const outcome = await prebuildRepository(root, {
		agentDir: options.agentDir,
		storeDir: resumeStoreDir(options.agentDir),
		settings: settings.getWorktreeSnapshotSettings(),
		maxIdlePerRepository: settings.getWorktreePoolSettings().maxIdlePerRepository,
		park: command.park,
		setupCommand: settings.getResumeSetupCommand(),
		...(options.home === undefined ? {} : { home: options.home }),
	});
	for (const warning of outcome.warnings) stderr(`Warning: ${warning}\n`);
	for (const line of formatResumeTimings(outcome.timings)) stderr(`${line}\n`);
	if (outcome.path === undefined) {
		const failure = outcome.build.failures[0];
		const log = failure?.logPath ? ` (log: ${failure.logPath})` : "";
		stderr(
			`Error: the blueprint build of ${outcome.head} did not finish; earlier worktrees and seeds are kept${log}.\n`,
		);
		return 1;
	}
	stdout(`prebuilt ${outcome.head} in ${outcome.path}\n`);
	if (outcome.parkMs !== null) {
		stdout(
			outcome.parked.length === 0
				? "parked nothing: the blueprint declares no kind: build output that the build produced\n"
				: `parked ${outcome.parked.join(", ")} in ${(outcome.parkMs / 1000).toFixed(1)} s\n`,
		);
	}
	return 0;
}
