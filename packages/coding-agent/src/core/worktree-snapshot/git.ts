import { spawn } from "node:child_process";
import { createChildProcessEnvironment } from "../../utils/child-process.ts";
import { createGitEnvironment } from "../../utils/git-env.ts";
import { GitUnavailableError, WorkspaceGitError } from "./errors.ts";

/** The Git executable snapshot operations run, with the environment it needs (a provisioned Git may need some). */
export interface GitExecutable {
	readonly path: string;
	readonly env: Readonly<Record<string, string>>;
}

export type GitExecutableResolver = () => Promise<GitExecutable>;

const DEFAULT_GIT: GitExecutable = Object.freeze({ path: "git", env: Object.freeze({}) });
let resolveExecutable: GitExecutableResolver = async () => DEFAULT_GIT;

/**
 * The single place every worktree snapshot Git invocation gets its executable from. Returns the previous resolver so
 * callers can restore it.
 */
export function setWorktreeSnapshotGit(resolver: GitExecutableResolver): GitExecutableResolver {
	const previous = resolveExecutable;
	resolveExecutable = resolver;
	return previous;
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
/** Settings that keep snapshot commands from running hooks, daemons, maintenance or signing in the user's repository. */
const BASE_CONFIG = [
	"-c",
	`core.hooksPath=${NULL_DEVICE}`,
	"-c",
	"core.fsmonitor=false",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
	"-c",
	"commit.gpgSign=false",
];
/** Conversion settings that make materialization and verification independent of the host's Git configuration. */
export const NEUTRAL_CONVERSION_CONFIG: readonly string[] = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.eol=lf",
	"-c",
	"core.safecrlf=false",
];

export interface GitRunOptions {
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly input?: string | Uint8Array;
	readonly signal?: AbortSignal;
	/** Exit codes that are results rather than failures, such as 1 from `git cat-file -e`. */
	readonly allowExitCodes?: readonly number[];
	/** Prepend {@link NEUTRAL_CONVERSION_CONFIG}. */
	readonly neutral?: boolean;
}

export interface GitRunResult {
	readonly stdout: Buffer;
	readonly stderr: string;
	readonly exitCode: number;
}

function exitStatusReportsClosedInput(): void {}

const CREDENTIALS_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi;

/** Removes the user-info part of URLs, which can hold access tokens. */
export function redactUrlCredentials(text: string): string {
	return text.replace(CREDENTIALS_IN_URL, "$1");
}

function gitOperation(args: readonly string[]): string {
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-c") index++;
		else if (!args[index]!.startsWith("-")) return args[index]!;
	}
	return "";
}

function firstLine(text: string): string {
	return redactUrlCredentials(text.trim().split("\n", 1)[0] ?? "").slice(0, 300);
}

/** Runs one Git command through the injected executable. Rejects with the signal's reason when aborted. */
export async function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
	options.signal?.throwIfAborted();
	const executable = await resolveExecutable();
	const env = createGitEnvironment(
		{ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GCM_INTERACTIVE: "never" },
		createChildProcessEnvironment(),
	);
	Object.assign(env, executable.env, options.env);
	const argv = [...BASE_CONFIG, ...(options.neutral ? NEUTRAL_CONVERSION_CONFIG : []), ...args];
	return new Promise<GitRunResult>((resolve, reject) => {
		const child = spawn(executable.path, argv, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(options.signal?.reason);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (action: () => void) => {
			options.signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			settled = true;
			action();
		};
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error: NodeJS.ErrnoException) =>
			finish(() =>
				reject(
					error.code === "ENOENT" || error.code === "EACCES"
						? new GitUnavailableError("not-installed", executable.path, { cause: error })
						: new WorkspaceGitError(
								{
									operation: gitOperation(args),
									cwd: options.cwd,
									exitCode: null,
									detail: firstLine(error.message),
								},
								error,
							),
				),
			),
		);
		child.stdin.on("error", exitStatusReportsClosedInput);
		child.on("close", (code) =>
			finish(() => {
				const result = {
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: code ?? -1,
				};
				if (code === 0 || (code !== null && options.allowExitCodes?.includes(code))) resolve(result);
				else
					reject(
						new WorkspaceGitError({
							operation: gitOperation(args),
							cwd: options.cwd,
							exitCode: code,
							detail: firstLine(result.stderr),
						}),
					);
			}),
		);
		child.stdin.end(options.input === undefined ? undefined : options.input);
	});
}

/** Runs a Git command and returns its standard output as UTF-8 text without the trailing newline. */
export async function gitText(args: readonly string[], options: GitRunOptions): Promise<string> {
	const { stdout } = await runGit(args, options);
	return stdout.toString("utf8").replace(/\n$/, "");
}

/** Splits NUL-terminated Git output. */
export function nulFields(output: Buffer | string): string[] {
	const text = typeof output === "string" ? output : output.toString("utf8");
	const fields = text.split("\0");
	if (fields.at(-1) === "") fields.pop();
	return fields;
}
