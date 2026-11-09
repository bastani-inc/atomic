import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync, writeSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { parse } from "yaml";
import { isBunBinary, isBunRuntime } from "../../../config.js";
import { getPowerShellConfig, getShellConfig, type ShellConfig } from "../../../utils/shell.ts";
import { isWorkspaceGitError } from "../../workspace/errors.ts";
import { redactUrlCredentials, runGit } from "../../worktree-snapshot/git.ts";
import {
	closedObject,
	type ExpressionContext,
	ExpressionError,
	type ExpressionObject,
	evaluateCondition,
	interpolate,
} from "./action-expressions.ts";
import { bashPath, shellQuote } from "./envrc.ts";
import {
	type BlueprintStepLocation,
	BlueprintUsesUnsupportedError,
	type BlueprintUsesUnsupportedReason,
} from "./errors.ts";
import { type ProcessExit, runLoggedProcess, type StepLog } from "./process.ts";

/** The environment variable that replaces `https://github.com` as the place actions are fetched from. */
export const ACTIONS_GITHUB_BASE_URL_ENV = "ATOMIC_BLUEPRINT_GITHUB_BASE_URL";

export interface ActionStepRequest {
	/** `github.com/<owner>/<repo>[/<subpath>]@<ref>`, already validated by the parser. */
	readonly uses: string;
	/** `with`, every value already stringified. */
	readonly inputs: Readonly<Record<string, string>>;
}

export interface ActionFetchRequest {
	readonly owner: string;
	readonly repo: string;
	readonly ref: string;
	/** An empty directory the checkout goes into. */
	readonly destination: string;
	readonly signal?: AbortSignal;
}

/** Puts a checkout of the repository at the ref into `destination`. Injectable so tests need no network. */
export type ActionFetcher = (request: ActionFetchRequest) => Promise<void>;

export interface RunActionOptions {
	readonly step: ActionStepRequest;
	/** Where the step sits, for typed errors. `logPath` is filled from `log.path`. */
	readonly location: BlueprintStepLocation;
	/** The step's working directory; becomes GITHUB_WORKSPACE. */
	readonly cwd: string;
	/** The step's environment: process env + variables from earlier steps' $ENVRC + the step's own `env`. */
	readonly env: NodeJS.ProcessEnv;
	/**
	 * The build's $ENVRC file. What the action writes to GITHUB_ENV and GITHUB_PATH is appended to it as bash that
	 * `set -a; . "$ENVRC"` understands, so later steps and the session see it.
	 */
	readonly envrcPath: string;
	/** Root of the fetched-action cache: `getBlueprintActionsDir(agentDir)`. */
	readonly cacheDir: string;
	readonly log: StepLog;
	/** The whole step's budget: pre and main, or all composite steps, share it. */
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	/** Default: git over `https://github.com`. */
	readonly fetchAction?: ActionFetcher;
}

export interface ActionReference {
	readonly owner: string;
	readonly repo: string;
	/** The directory that holds action.yml, relative to the repository root; empty for the root. */
	readonly subpath: string;
	readonly ref: string;
}

/** A string is not `github.com/<owner>/<repo>[/<subpath>]@<ref>`. */
export class ActionReferenceError extends Error {
	override readonly name = "ActionReferenceError" as const;

	constructor(uses: string) {
		super(`"${uses.slice(0, 120)}" is not an action reference: expected github.com/<owner>/<repo>[/<subpath>]@<ref>`);
	}
}

const REFERENCE_PREFIX = "github.com/";
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_REF_CHARACTERS = /[\s\p{Cc}~^:?*[\\]/u;

/**
 * Splits `github.com/<owner>/<repo>[/<subpath>]@<ref>`. The subpath is returned as written: whether it stays inside
 * the repository is checked when the action runs.
 */
export function parseActionReference(uses: string): ActionReference {
	const at = uses.indexOf("@");
	if (!uses.startsWith(REFERENCE_PREFIX) || at === -1) throw new ActionReferenceError(uses);
	const [owner = "", repo = "", ...subpath] = uses.slice(REFERENCE_PREFIX.length, at).split("/");
	const ref = uses.slice(at + 1);
	if (
		!OWNER_PATTERN.test(owner) ||
		!REPOSITORY_PATTERN.test(repo) ||
		repo === "." ||
		repo === ".." ||
		ref === "" ||
		ref.startsWith("-") ||
		FORBIDDEN_REF_CHARACTERS.test(ref)
	) {
		throw new ActionReferenceError(uses);
	}
	return { owner, repo, subpath: subpath.join("/"), ref };
}

function describeReference({ owner, repo, subpath, ref }: ActionReference): string {
	return `${REFERENCE_PREFIX}${owner}/${repo}${subpath === "" ? "" : `/${subpath}`}@${ref}`;
}

type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = { [key: string]: YamlValue };

class MetadataError extends Error {}

function isMap(value: YamlValue | undefined): value is YamlMap {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: YamlValue | undefined, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	throw new MetadataError(`${field} must be a string`);
}

function requiredText(value: YamlValue | undefined, field: string): string {
	const text = optionalText(value, field);
	if (text === undefined) throw new MetadataError(`${field} is required`);
	return text;
}

function textMap(value: YamlValue | undefined, field: string): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isMap(value)) throw new MetadataError(`${field} must be a mapping`);
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, optionalText(entry, `${field}.${key}`) ?? ""]),
	);
}

interface InputDefinition {
	readonly name: string;
	readonly defaultValue: string | undefined;
	readonly required: boolean;
}

interface CompositeRun {
	readonly kind: "run";
	readonly run: string;
	readonly shell: string;
}

interface CompositeUses {
	readonly kind: "uses";
	readonly uses: string;
	readonly inputs: Readonly<Record<string, string>>;
}

interface CompositeStep {
	readonly id: string | undefined;
	readonly name: string | undefined;
	readonly condition: string | undefined;
	readonly env: Readonly<Record<string, string>>;
	readonly workingDirectory: string | undefined;
	readonly continueOnError: string | undefined;
	readonly action: CompositeRun | CompositeUses;
}

interface NodeRuns {
	readonly kind: "node";
	readonly main: string;
	readonly pre: string | undefined;
	readonly preCondition: string | undefined;
}

interface CompositeRuns {
	readonly kind: "composite";
	readonly steps: readonly CompositeStep[];
	readonly outputs: Readonly<Record<string, string>>;
}

interface DockerRuns {
	readonly kind: "docker";
}

interface UnknownRuns {
	readonly kind: "unknown";
	readonly using: string;
}

interface ActionMetadata {
	readonly inputs: readonly InputDefinition[];
	readonly runs: NodeRuns | CompositeRuns | DockerRuns | UnknownRuns;
}

const METADATA_FILES = ["action.yml", "action.yaml"] as const;
const NODE_RUNTIMES: ReadonlySet<string> = new Set(["node12", "node16", "node20", "node24"]);

function parseInputs(value: YamlValue | undefined): InputDefinition[] {
	if (value === undefined || value === null) return [];
	if (!isMap(value)) throw new MetadataError("inputs must be a mapping");
	return Object.entries(value).map(([name, definition]) => {
		const fields = isMap(definition) ? definition : {};
		const required = fields.required;
		return {
			name,
			defaultValue: optionalText(fields.default, `inputs.${name}.default`),
			required: required === true || (typeof required === "string" && required.toLowerCase() === "true"),
		};
	});
}

function parseCompositeAction(step: YamlMap, field: string): CompositeRun | CompositeUses {
	const run = optionalText(step.run, `${field}.run`);
	const uses = optionalText(step.uses, `${field}.uses`);
	if (run !== undefined && uses !== undefined) throw new MetadataError(`${field} cannot have both run and uses`);
	if (run !== undefined) {
		const shell = optionalText(step.shell, `${field}.shell`);
		if (shell === undefined) throw new MetadataError(`${field} needs a shell for its run`);
		return { kind: "run", run, shell };
	}
	if (uses === undefined) throw new MetadataError(`${field} needs run or uses`);
	return { kind: "uses", uses, inputs: textMap(step.with, `${field}.with`) };
}

function parseCompositeStep(value: YamlValue, index: number): CompositeStep {
	const field = `runs.steps[${index}]`;
	if (!isMap(value)) throw new MetadataError(`${field} must be a mapping`);
	return {
		id: optionalText(value.id, `${field}.id`),
		name: optionalText(value.name, `${field}.name`),
		condition: optionalText(value.if, `${field}.if`),
		env: textMap(value.env, `${field}.env`),
		workingDirectory: optionalText(value["working-directory"], `${field}.working-directory`),
		continueOnError: optionalText(value["continue-on-error"], `${field}.continue-on-error`),
		action: parseCompositeAction(value, field),
	};
}

function parseOutputs(value: YamlValue | undefined): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (!isMap(value)) throw new MetadataError("outputs must be a mapping");
	return Object.fromEntries(
		Object.entries(value).map(([name, definition]) => [
			name,
			isMap(definition) ? (optionalText(definition.value, `outputs.${name}.value`) ?? "") : "",
		]),
	);
}

function parseRuns(root: YamlMap): ActionMetadata["runs"] {
	const runs = root.runs;
	if (!isMap(runs)) throw new MetadataError("runs is required");
	const using = requiredText(runs.using, "runs.using");
	const kind = using.toLowerCase();
	if (kind === "docker") return { kind: "docker" };
	if (NODE_RUNTIMES.has(kind)) {
		return {
			kind: "node",
			main: requiredText(runs.main, "runs.main"),
			pre: optionalText(runs.pre, "runs.pre"),
			preCondition: optionalText(runs["pre-if"], "runs.pre-if"),
		};
	}
	if (kind !== "composite") return { kind: "unknown", using };
	if (!Array.isArray(runs.steps)) throw new MetadataError("runs.steps is required");
	return {
		kind: "composite",
		steps: runs.steps.map(parseCompositeStep),
		outputs: parseOutputs(root.outputs),
	};
}

function parseMetadata(text: string): ActionMetadata {
	const root = parse(text) as YamlValue;
	if (!isMap(root)) throw new MetadataError("it is not a mapping");
	return { inputs: parseInputs(root.inputs), runs: parseRuns(root) };
}

type StubVariable = readonly [property: string, variable: string, stub: string];

const GITHUB_CONTEXT_STUBS: readonly StubVariable[] = [
	["repository", "GITHUB_REPOSITORY", "atomic/blueprint"],
	["repository_owner", "GITHUB_REPOSITORY_OWNER", "atomic"],
	["sha", "GITHUB_SHA", "0000000000000000000000000000000000000000"],
	["ref", "GITHUB_REF", "refs/heads/main"],
	["ref_name", "GITHUB_REF_NAME", "main"],
	["ref_type", "GITHUB_REF_TYPE", "branch"],
	["event_name", "GITHUB_EVENT_NAME", "workflow_dispatch"],
	["run_id", "GITHUB_RUN_ID", "1"],
	["run_number", "GITHUB_RUN_NUMBER", "1"],
	["run_attempt", "GITHUB_RUN_ATTEMPT", "1"],
	["actor", "GITHUB_ACTOR", "atomic"],
	["job", "GITHUB_JOB", "blueprint"],
	["workflow", "GITHUB_WORKFLOW", "blueprint"],
	["server_url", "GITHUB_SERVER_URL", "https://github.com"],
	["api_url", "GITHUB_API_URL", "https://api.github.com"],
	["graphql_url", "GITHUB_GRAPHQL_URL", "https://api.github.com/graphql"],
];

const RUNNER_OS_NAMES: Readonly<Record<string, string>> = { linux: "Linux", darwin: "macOS", win32: "Windows" };
const RUNNER_ARCH_NAMES: Readonly<Record<string, string>> = { x64: "X64", arm64: "ARM64", ia32: "X86", arm: "ARM" };

const MAX_NESTING_DEPTH = 10;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RunContext {
	readonly options: RunActionOptions;
	readonly startedAt: number;
	readonly deadline: number;
	/** What every process of the run sees; grows as actions write GITHUB_ENV and GITHUB_PATH. */
	readonly env: Record<string, string>;
	readonly runnerTemp: string;
	readonly toolCache: string;
	readonly fetchAction: ActionFetcher;
}

/** Which action is running, for the errors it causes: nested actions are named, the step's own is not. */
interface ActionScope {
	readonly label: string;
	readonly depth: number;
}

interface ActionFrame extends ActionScope {
	readonly reference: ActionReference;
	readonly directory: string;
	/** The `env` of the step that used this action, and of the actions that used it. */
	readonly env: Readonly<Record<string, string>>;
}

interface ActionOutcome {
	readonly exit: ProcessExit;
	readonly outputs: Readonly<Record<string, string>>;
}

interface ProcessRequest {
	readonly title: string;
	readonly shown: string;
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly stdin?: string;
	readonly env: Readonly<Record<string, string>>;
}

function defined(env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value;
	return result;
}

function mapValues(values: Readonly<Record<string, string>>, map: (value: string) => string): Record<string, string> {
	return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, map(value)]));
}

function log(context: RunContext, text: string): void {
	writeSync(context.options.log.fd, `${text}\n`);
}

function failure(
	context: RunContext,
	scope: ActionScope,
	reason: BlueprintUsesUnsupportedReason,
	detail: string,
	cause?: Error,
): BlueprintUsesUnsupportedError {
	const prefix = scope.depth === 0 ? "" : `${scope.label}: `;
	return new BlueprintUsesUnsupportedError(
		{
			...context.options.location,
			uses: context.options.step.uses,
			reason,
			detail: `${prefix}${detail}`.slice(0, 300),
			logPath: context.options.log.path,
		},
		cause,
	);
}

function succeeded(exit: ProcessExit): boolean {
	return exit.exitStatus === 0 && exit.signal === null && !exit.timedOut && exit.spawnError === undefined;
}

function elapsed(context: RunContext): number {
	return Date.now() - context.startedAt;
}

function timedOut(context: RunContext): ProcessExit {
	return { exitStatus: null, signal: null, timedOut: true, elapsedMs: elapsed(context) };
}

function unstartable(context: RunContext, spawnError: Error): ProcessExit {
	return { exitStatus: null, signal: null, timedOut: false, elapsedMs: elapsed(context), spawnError };
}

function isInside(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function containedPath(root: string, requested: string): string | undefined {
	if (
		requested.startsWith("/") ||
		requested.startsWith("\\") ||
		isAbsolute(requested) ||
		win32.isAbsolute(requested)
	) {
		return undefined;
	}
	const candidate = resolve(root, requested);
	return isInside(root, candidate) ? candidate : undefined;
}

/** The environment variable that holds the search path: `PATH`, or on Windows whatever case the environment spells it. */
export function pathVariableName(env: Readonly<Record<string, string>>, platform: NodeJS.Platform): string {
	if (platform !== "win32") return "PATH";
	return Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "Path";
}

function prependPath(env: Record<string, string>, directory: string): void {
	const name = pathVariableName(env, process.platform);
	env[name] = env[name] ? `${directory}${delimiter}${env[name]}` : directory;
}

/** The errors that mean a search-path entry holds no usable executable of that name: the search moves on. */
const NOT_A_CANDIDATE_ERRORS: ReadonlySet<string> = new Set([
	"ENOENT",
	"ENOTDIR",
	"EACCES",
	"EPERM",
	"ELOOP",
	"ENAMETOOLONG",
]);

/** The first executable file called `name` in the directories of the search path in `env`. */
export function findOnPath(
	name: string,
	env: Readonly<Record<string, string>>,
	platform: NodeJS.Platform,
): string | undefined {
	for (const directory of (env[pathVariableName(env, platform)] ?? "").split(delimiter)) {
		if (directory === "") continue;
		const candidate = join(directory, name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch (error) {
			if (!NOT_A_CANDIDATE_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	return undefined;
}

/**
 * The node that runs a Node.js action: the one running Atomic, or, when Bun hosts it and `process.execPath` is Bun, the
 * one on the action's search path.
 */
export function nodeExecutableFor(
	env: Readonly<Record<string, string>>,
	hostedByBun: boolean,
	platform: NodeJS.Platform,
): string | undefined {
	if (!hostedByBun) return process.execPath;
	return findOnPath(platform === "win32" ? "node.exe" : "node", env, platform);
}

function nodeExecutable(env: Readonly<Record<string, string>>): string | undefined {
	return nodeExecutableFor(env, isBunBinary || isBunRuntime, process.platform);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

class ActionNotFoundError extends Error {}

const GIT_NOT_FOUND =
	/couldn't find remote ref|not our ref|repository .* not found|does not appear to be a git repository/i;

const fetchFromGitHub: ActionFetcher = async ({ owner, repo, ref, destination, signal }) => {
	const base = (process.env[ACTIONS_GITHUB_BASE_URL_ENV] || "https://github.com").replace(/\/+$/, "");
	const options = { cwd: destination, env: { LC_ALL: "C" }, signal };
	try {
		await runGit(["init", "--quiet"], options);
		await runGit(["fetch", "--quiet", "--depth", "1", "--no-tags", "--", `${base}/${owner}/${repo}.git`, ref], {
			...options,
			nonInteractive: true,
		});
		await runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], { ...options, neutral: true });
	} catch (error) {
		if (isWorkspaceGitError(error) && GIT_NOT_FOUND.test(error.detail)) {
			throw new ActionNotFoundError(`${owner}/${repo}@${ref} does not exist`, { cause: error });
		}
		throw error;
	}
	await rm(join(destination, ".git"), { recursive: true, force: true, maxRetries: 3 });
};

function encodeRef(ref: string): string {
	return encodeURIComponent(ref).replace(/^\./, "%2E");
}

async function ensureRepository(
	context: RunContext,
	scope: ActionScope,
	reference: ActionReference,
	repositoryDirectory: string,
): Promise<void> {
	if (await isDirectory(repositoryDirectory)) {
		log(context, `=== Using the cached ${scope.label} ===`);
		return;
	}
	log(context, `=== Fetching ${scope.label} ===`);
	const staging = join(dirname(repositoryDirectory), `.fetch-${randomUUID()}`);
	let primary: unknown;
	try {
		await mkdir(staging, { recursive: true });
		await context.fetchAction({
			owner: reference.owner,
			repo: reference.repo,
			ref: reference.ref,
			destination: staging,
			signal: context.options.signal,
		});
		try {
			await rename(staging, repositoryDirectory);
		} catch (error) {
			if (!(await isDirectory(repositoryDirectory))) throw error;
		}
	} catch (error) {
		primary = fetchFailure(context, scope, reference, error);
	}
	const cleanup: unknown = await rm(staging, { recursive: true, force: true, maxRetries: 3 }).then(
		() => undefined,
		(reason: unknown) => reason,
	);
	if (primary !== undefined) {
		if (cleanup !== undefined && primary instanceof Error) {
			Object.defineProperty(primary, "cleanupCause", { value: cleanup, enumerable: false });
		}
		throw primary;
	}
	if (cleanup !== undefined) throw cleanup;
}

/** The error a failed fetch ends in: the signal's reason when the run was cancelled, else the typed failure. */
function fetchFailure(context: RunContext, scope: ActionScope, reference: ActionReference, error: unknown): unknown {
	const signal = context.options.signal;
	if (signal?.aborted) return signal.reason;
	const cause = error instanceof Error ? error : new Error(String(error));
	log(context, `could not fetch: ${redactUrlCredentials(cause.message)}`);
	if (cause instanceof ActionNotFoundError) return failure(context, scope, "action-not-found", cause.message, cause);
	return failure(
		context,
		scope,
		"action-fetch-failed",
		`could not fetch ${reference.owner}/${reference.repo}@${reference.ref}`,
		cause,
	);
}

async function locateAction(context: RunContext, scope: ActionScope, reference: ActionReference): Promise<string> {
	const repositoryDirectory = join(
		context.options.cacheDir,
		reference.owner,
		reference.repo,
		encodeRef(reference.ref),
	);
	const directory = containedPath(repositoryDirectory, reference.subpath);
	if (directory === undefined) {
		throw failure(context, scope, "action-metadata-invalid", "the action path leaves the repository");
	}
	await ensureRepository(context, scope, reference, repositoryDirectory);
	return directory;
}

async function readMetadata(context: RunContext, scope: ActionScope, directory: string): Promise<ActionMetadata> {
	for (const fileName of METADATA_FILES) {
		let text: string | undefined;
		try {
			text = await readTextIfPresent(join(directory, fileName));
		} catch (error) {
			throw failure(context, scope, "action-metadata-invalid", `${fileName} cannot be read`, error as Error);
		}
		if (text === undefined) continue;
		try {
			return parseMetadata(text);
		} catch (error) {
			const detail =
				error instanceof MetadataError ? `${fileName}: ${error.message}` : `${fileName} is not valid YAML`;
			throw failure(context, scope, "action-metadata-invalid", detail, error as Error);
		}
	}
	throw failure(context, scope, "action-not-found", "the repository has no action.yml at that path");
}

function inputEnvironment(inputs: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(inputs).map(([name, value]) => [`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`, value]),
	);
}

function actionEnvironment(frame: ActionFrame): Record<string, string> {
	return {
		GITHUB_ACTION_PATH: frame.directory,
		GITHUB_ACTION_REPOSITORY: `${frame.reference.owner}/${frame.reference.repo}`,
		GITHUB_ACTION_REF: frame.reference.ref,
	};
}

function expressionContext(
	context: RunContext,
	frame: ActionFrame,
	inputs: Readonly<Record<string, string>>,
	steps: ExpressionObject,
	failed: boolean,
): ExpressionContext {
	const env = { ...context.env, ...frame.env };
	const github: ExpressionObject = Object.fromEntries(
		GITHUB_CONTEXT_STUBS.map(([property, variable]) => [property, env[variable] ?? ""]),
	);
	return {
		failed,
		roots: {
			inputs: { ...inputs },
			env,
			steps,
			github: closedObject("github", {
				...github,
				token: "",
				event: {},
				workspace: context.options.cwd,
				action_path: frame.directory,
				action_repository: `${frame.reference.owner}/${frame.reference.repo}`,
				action_ref: frame.reference.ref,
			}),
			runner: closedObject("runner", {
				os: env.RUNNER_OS ?? "",
				arch: env.RUNNER_ARCH ?? "",
				temp: context.runnerTemp,
				tool_cache: context.toolCache,
			}),
		},
	};
}

function resolveInputs(
	context: RunContext,
	frame: ActionFrame,
	metadata: ActionMetadata,
	given: Readonly<Record<string, string>>,
): Record<string, string> {
	const declared = new Map(metadata.inputs.map((input) => [input.name.toLowerCase(), input.name]));
	const inputs: Record<string, string> = {};
	for (const [name, value] of Object.entries(given)) inputs[declared.get(name.toLowerCase()) ?? name] = value;
	const defaults = expressionContext(context, frame, {}, {}, false);
	for (const input of metadata.inputs) {
		if (Object.hasOwn(inputs, input.name)) continue;
		if (input.defaultValue !== undefined) inputs[input.name] = interpolate(input.defaultValue, defaults);
		else if (input.required)
			throw failure(context, frame, "required-input-missing", `input "${input.name}" is required`);
		else inputs[input.name] = "";
	}
	return inputs;
}

interface FileCommands {
	readonly directory: string;
	readonly env: string;
	readonly path: string;
	readonly output: string;
	readonly state: string;
	readonly summary: string;
}

async function createFileCommands(runnerTemp: string): Promise<FileCommands> {
	const directory = join(runnerTemp, "_runner_file_commands", randomUUID());
	await mkdir(directory, { recursive: true });
	const files = {
		directory,
		env: join(directory, "set_env"),
		path: join(directory, "add_path"),
		output: join(directory, "set_output"),
		state: join(directory, "save_state"),
		summary: join(directory, "step_summary"),
	};
	await Promise.all(
		[files.env, files.path, files.output, files.state, files.summary].map((file) =>
			writeFile(file, "", { mode: 0o600 }),
		),
	);
	return files;
}

interface FileEntries {
	readonly entries: readonly { readonly name: string; readonly value: string }[];
	readonly malformed: number;
}

/** The `name=value` and `name<<DELIMITER` entries of a GITHUB_ENV, GITHUB_OUTPUT or GITHUB_STATE file. */
function parseFileEntries(text: string): FileEntries {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const entries: { name: string; value: string }[] = [];
	let malformed = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line === "") continue;
		const equals = line.indexOf("=");
		const heredoc = line.indexOf("<<");
		if (equals > 0 && (heredoc === -1 || equals < heredoc)) {
			entries.push({ name: line.slice(0, equals), value: line.slice(equals + 1) });
			continue;
		}
		const terminator = heredoc > 0 ? line.slice(heredoc + 2) : "";
		if (terminator === "") {
			malformed++;
			continue;
		}
		const closing = lines.indexOf(terminator, index + 1);
		if (closing === -1) {
			malformed++;
			break;
		}
		entries.push({ name: line.slice(0, heredoc), value: lines.slice(index + 1, closing).join("\n") });
		index = closing;
	}
	return { entries, malformed };
}

async function applyFileCommands(
	context: RunContext,
	files: FileCommands,
): Promise<{ outputs: Record<string, string>; state: Record<string, string> }> {
	const [envText, pathText, outputText, stateText] = await Promise.all(
		[files.env, files.path, files.output, files.state].map(async (file) => (await readTextIfPresent(file)) ?? ""),
	);
	const variables = parseFileEntries(envText);
	const outputs = parseFileEntries(outputText);
	const state = parseFileEntries(stateText);
	let malformed = variables.malformed + outputs.malformed + state.malformed;
	const lines: string[] = [];
	for (const { name, value } of variables.entries) {
		if (!ENVIRONMENT_NAME.test(name)) {
			malformed++;
			continue;
		}
		context.env[name] = value;
		lines.push(`export ${name}=${shellQuote(value)}`);
	}
	for (const line of pathText.split("\n")) {
		const directory = line.trim();
		if (directory === "") continue;
		prependPath(context.env, directory);
		lines.push(`export PATH=${shellQuote(bashPath(directory))}:"$PATH"`);
	}
	if (lines.length > 0) await appendFile(context.options.envrcPath, `${lines.join("\n")}\n`);
	if (malformed > 0)
		log(context, `ignored ${malformed} malformed entries written to GITHUB_ENV, GITHUB_OUTPUT or GITHUB_STATE`);
	const toRecord = ({ entries }: FileEntries) => Object.fromEntries(entries.map(({ name, value }) => [name, value]));
	return { outputs: toRecord(outputs), state: toRecord(state) };
}

async function runProcess(
	context: RunContext,
	request: ProcessRequest,
): Promise<{ exit: ProcessExit; outputs: Record<string, string>; state: Record<string, string> }> {
	context.options.signal?.throwIfAborted();
	const remaining = context.deadline - Date.now();
	if (remaining <= 0) return { exit: timedOut(context), outputs: {}, state: {} };
	const files = await createFileCommands(context.runnerTemp);
	try {
		log(context, `=== ${request.title} ===\n$ ${request.shown}`);
		const exit = await runLoggedProcess(
			{
				command: request.executable,
				args: request.args,
				cwd: request.cwd,
				env: {
					...context.env,
					...request.env,
					GITHUB_ENV: files.env,
					GITHUB_PATH: files.path,
					GITHUB_OUTPUT: files.output,
					GITHUB_STATE: files.state,
					GITHUB_STEP_SUMMARY: files.summary,
				},
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
			},
			context.options.log,
			{ timeoutMs: remaining, signal: context.options.signal },
		);
		return { exit, ...(await applyFileCommands(context, files)) };
	} finally {
		await rm(files.directory, { recursive: true, force: true, maxRetries: 3 });
	}
}

async function runNodeAction(
	context: RunContext,
	frame: ActionFrame,
	runs: NodeRuns,
	inputs: Readonly<Record<string, string>>,
): Promise<ActionOutcome> {
	const node = nodeExecutable(context.env);
	if (node === undefined) {
		throw failure(context, frame, "node-unavailable", "no node executable is available to run a Node.js action");
	}
	const scriptPath = (field: string, script: string): string => {
		const path = containedPath(frame.directory, script);
		if (path === undefined) {
			throw failure(context, frame, "action-metadata-invalid", `runs.${field} leaves the action directory`);
		}
		return path;
	};
	const phases = [{ name: "main", script: runs.main, path: scriptPath("main", runs.main) }];
	if (runs.pre !== undefined) {
		const pre = { name: "pre", script: runs.pre, path: scriptPath("pre", runs.pre) };
		const wanted =
			runs.preCondition === undefined ||
			evaluateCondition(runs.preCondition, expressionContext(context, frame, inputs, {}, false));
		if (wanted) phases.unshift(pre);
		else log(context, `=== Skipping pre of ${frame.label}: its pre-if is false ===`);
	}
	let state: Record<string, string> = {};
	let outputs: Record<string, string> = {};
	for (const phase of phases) {
		const result = await runProcess(context, {
			title: `${phase.name} of ${frame.label}`,
			shown: `node ${phase.script}`,
			executable: node,
			args: [phase.path],
			cwd: context.options.cwd,
			env: {
				...frame.env,
				...actionEnvironment(frame),
				...inputEnvironment(inputs),
				...Object.fromEntries(Object.entries(state).map(([name, value]) => [`STATE_${name}`, value])),
			},
		});
		outputs = { ...outputs, ...result.outputs };
		if (!succeeded(result.exit)) return { exit: result.exit, outputs };
		state = { ...state, ...result.state };
	}
	return { exit: { exitStatus: 0, signal: null, timedOut: false, elapsedMs: elapsed(context) }, outputs };
}

export interface ShellInvocation {
	readonly executable: string;
	readonly args: readonly string[];
	readonly stdin?: string;
}

/** How `config`'s bash runs `script` as a `bash` or `sh` step: failing at the first failing command, as GitHub does. */
export function bashInvocation(config: ShellConfig, name: string, script: string): ShellInvocation {
	const strict = name === "bash" && basename(config.shell).toLowerCase().startsWith("bash") ? "-eo pipefail" : "-e";
	const text = `set ${strict}\n${script}`;
	return config.commandTransport === "stdin"
		? { executable: config.shell, args: config.args, stdin: text }
		: { executable: config.shell, args: [...config.args, text] };
}

/** How `config`'s PowerShell runs `script` as a `pwsh` or `powershell` step. */
export function powerShellInvocation(config: ShellConfig, script: string): ShellInvocation {
	const text = `$ErrorActionPreference = 'stop'\n${script}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`;
	return { executable: config.shell, args: [...config.args, text] };
}

function shellInvocation(
	context: RunContext,
	frame: ActionFrame,
	shell: string,
	script: string,
): ShellInvocation | Error {
	const name = shell.toLowerCase();
	if (name === "bash" || name === "sh") {
		try {
			return bashInvocation(getShellConfig(), name, script);
		} catch (error) {
			return error as Error;
		}
	}
	if (name === "pwsh" || name === "powershell") {
		if (process.platform !== "win32") {
			throw failure(context, frame, "unsupported-expression", "PowerShell steps are only supported on Windows");
		}
		try {
			return powerShellInvocation(getPowerShellConfig(), script);
		} catch (error) {
			return error as Error;
		}
	}
	throw failure(context, frame, "unsupported-expression", `the shell "${shell.slice(0, 40)}" is not supported`);
}

function stepDirectory(
	context: RunContext,
	frame: ActionFrame,
	requested: string | undefined,
	expressions: ExpressionContext,
): string {
	if (requested === undefined) return context.options.cwd;
	const directory = resolve(context.options.cwd, interpolate(requested, expressions));
	if (!isInside(context.options.cwd, directory) && !isInside(frame.directory, directory)) {
		throw failure(context, frame, "action-metadata-invalid", "working-directory leaves the workspace and the action");
	}
	return directory;
}

function nestedReference(context: RunContext, frame: ActionFrame, uses: string): ActionReference {
	if (uses.startsWith("docker://")) throw failure(context, frame, "docker-action", "Docker actions are not supported");
	if (uses.startsWith(".") || uses.startsWith("/")) {
		throw failure(context, frame, "action-not-found", "local action paths are not supported");
	}
	try {
		return parseActionReference(uses.startsWith(REFERENCE_PREFIX) ? uses : `${REFERENCE_PREFIX}${uses}`);
	} catch (error) {
		if (error instanceof ActionReferenceError) {
			throw failure(context, frame, "action-not-found", `"${uses.slice(0, 80)}" is not an action reference`, error);
		}
		throw error;
	}
}

async function runCompositeAction(
	context: RunContext,
	frame: ActionFrame,
	runs: CompositeRuns,
	inputs: Readonly<Record<string, string>>,
): Promise<ActionOutcome> {
	const steps: ExpressionObject = {};
	let failed: ProcessExit | undefined;
	for (const [index, step] of runs.steps.entries()) {
		context.options.signal?.throwIfAborted();
		const title = `Step ${index + 1} of ${runs.steps.length}: ${step.name ?? step.id ?? step.action.kind} (${frame.label})`;
		const expressions = expressionContext(context, frame, inputs, steps, failed !== undefined);
		if (!evaluateCondition(step.condition ?? "success()", expressions)) {
			log(context, `=== ${title}: skipped ===`);
			if (step.id !== undefined) steps[step.id] = closedObject(`steps.${step.id}`, { outputs: {} });
			continue;
		}
		const env = { ...frame.env, ...mapValues(step.env, (value) => interpolate(value, expressions)) };
		let outcome: ActionOutcome;
		if (step.action.kind === "uses") {
			const reference = nestedReference(context, frame, step.action.uses);
			log(context, `=== ${title} ===\nuses ${step.action.uses}`);
			outcome = await executeAction(context, {
				reference,
				inputs: mapValues(step.action.inputs, (value) => interpolate(value, expressions)),
				env,
				depth: frame.depth + 1,
			});
		} else {
			const invocation = shellInvocation(
				context,
				frame,
				interpolate(step.action.shell, expressions).trim(),
				interpolate(step.action.run, expressions),
			);
			const directory = stepDirectory(context, frame, step.workingDirectory, expressions);
			if (invocation instanceof Error) {
				log(context, `=== ${title} ===\ncould not start: ${invocation.message}`);
				outcome = { exit: unstartable(context, invocation), outputs: {} };
			} else {
				const result = await runProcess(context, {
					title,
					shown: step.action.run,
					cwd: directory,
					env: { ...env, ...actionEnvironment(frame) },
					...invocation,
				});
				outcome = { exit: result.exit, outputs: result.outputs };
			}
		}
		if (step.id !== undefined) steps[step.id] = closedObject(`steps.${step.id}`, { outputs: { ...outcome.outputs } });
		if (succeeded(outcome.exit)) continue;
		const tolerated =
			step.continueOnError !== undefined &&
			!outcome.exit.timedOut &&
			interpolate(step.continueOnError, expressions).trim().toLowerCase() === "true";
		if (tolerated) log(context, `=== ${title}: failed, continuing because of continue-on-error ===`);
		else failed ??= outcome.exit;
	}
	if (failed !== undefined) return { exit: failed, outputs: {} };
	const finished = expressionContext(context, frame, inputs, steps, false);
	return {
		exit: { exitStatus: 0, signal: null, timedOut: false, elapsedMs: elapsed(context) },
		outputs: mapValues(runs.outputs, (value) => interpolate(value, finished)),
	};
}

interface ActionRequest {
	readonly reference: ActionReference;
	readonly inputs: Readonly<Record<string, string>>;
	readonly env: Readonly<Record<string, string>>;
	readonly depth: number;
}

async function executeAction(context: RunContext, request: ActionRequest): Promise<ActionOutcome> {
	const scope: ActionScope = { label: describeReference(request.reference), depth: request.depth };
	if (request.depth > MAX_NESTING_DEPTH) {
		throw failure(context, scope, "unsupported-expression", `actions are nested more than ${MAX_NESTING_DEPTH} deep`);
	}
	const directory = await locateAction(context, scope, request.reference);
	const metadata = await readMetadata(context, scope, directory);
	const frame: ActionFrame = { ...scope, reference: request.reference, directory, env: request.env };
	const { runs } = metadata;
	if (runs.kind === "docker") throw failure(context, scope, "docker-action", "Docker actions are not supported");
	if (runs.kind === "unknown") {
		throw failure(context, scope, "unknown-action-type", `runs.using "${runs.using.slice(0, 40)}" is not supported`);
	}
	try {
		const inputs = resolveInputs(context, frame, metadata, request.inputs);
		return runs.kind === "node"
			? await runNodeAction(context, frame, runs, inputs)
			: await runCompositeAction(context, frame, runs, inputs);
	} catch (error) {
		if (error instanceof ExpressionError)
			throw failure(context, scope, "unsupported-expression", error.message, error);
		throw error;
	}
}

async function createContext(options: RunActionOptions, startedAt: number): Promise<RunContext> {
	const runnerTemp = join(options.cacheDir, "_runner", "temp");
	const toolCache = join(options.cacheDir, "_runner", "tool");
	await mkdir(runnerTemp, { recursive: true });
	await mkdir(toolCache, { recursive: true });
	return {
		options,
		startedAt,
		deadline: startedAt + options.timeoutMs,
		runnerTemp,
		toolCache,
		fetchAction: options.fetchAction ?? fetchFromGitHub,
		env: {
			...Object.fromEntries(GITHUB_CONTEXT_STUBS.map(([, variable, stub]) => [variable, stub])),
			...defined(options.env),
			GITHUB_ACTIONS: "true",
			CI: "true",
			GITHUB_WORKSPACE: options.cwd,
			RUNNER_OS: RUNNER_OS_NAMES[process.platform] ?? "Linux",
			RUNNER_ARCH: RUNNER_ARCH_NAMES[process.arch] ?? process.arch.toUpperCase(),
			RUNNER_TEMP: runnerTemp,
			RUNNER_TOOL_CACHE: toolCache,
			AGENT_TOOLSDIRECTORY: toolCache,
		},
	};
}

/**
 * Runs one `uses` step as Devin does: the action is fetched at its ref (cached per owner, repository and ref), and a
 * Node.js action runs its `pre` and `main`, a composite action its steps. Docker actions and `post` are not run.
 * What the action writes to GITHUB_ENV and GITHUB_PATH is applied to its later processes and appended to
 * `options.envrcPath`.
 *
 * Resolves how the first failing process ended (non-zero exit, signal, timeout or no start), else success. Rejects
 * with a {@link BlueprintUsesUnsupportedError} when the action cannot run at all, and with `signal.reason` when
 * `options.signal` aborts.
 */
export async function runAction(options: RunActionOptions): Promise<ProcessExit> {
	options.signal?.throwIfAborted();
	const startedAt = Date.now();
	const context = await createContext(options, startedAt);
	let reference: ActionReference;
	try {
		reference = parseActionReference(options.step.uses);
	} catch (error) {
		if (error instanceof ActionReferenceError) {
			throw failure(context, { label: options.step.uses, depth: 0 }, "action-not-found", error.message, error);
		}
		throw error;
	}
	const { exit } = await executeAction(context, { reference, inputs: options.step.inputs, env: {}, depth: 0 });
	return { ...exit, elapsedMs: Date.now() - startedAt };
}
