import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBlueprintActionsDir, getGlobalBlueprintPath, getProjectBlueprintPath } from "../../../config.js";
import { getHomeDir } from "../../../utils/paths.ts";
import { getShellEnv } from "../../../utils/shell.ts";
import type { ActionFetcher } from "./actions.ts";
import { sessionEnvrcPath } from "./envrc.ts";
import {
	BlueprintBuildFailedError,
	type BlueprintError,
	BlueprintInvalidError,
	type BlueprintScope,
	type BlueprintSection,
	isBlueprintError,
} from "./errors.ts";
import {
	type BlueprintLedger,
	blueprintDigest,
	readLedger,
	repositoryKey,
	rootKey,
	updateLedger,
	type WorkspaceLedgerEntry,
	workspaceKey,
} from "./ledger.ts";
import { hostPlatform, parseBlueprint, selectDocument } from "./schema.ts";
import { BLUEPRINT_STEP_TIMEOUT_MS, runSection, type StepContext, type StepFailure } from "./steps.ts";
import type { BlueprintDocument, BlueprintPlatform, BlueprintWarning, ParsedBlueprint, RunStep } from "./types.ts";

/** A full build runs instead of a differential one when the last full build is older than this: 7 days. */
export const BLUEPRINT_FULL_BUILD_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The name the deprecated `resume.setupCommand` alias goes by in steps, logs and failures. */
export const SETUP_COMMAND_ALIAS = "resume.setupCommand";

/** A repository a build sets up: the worktree restored for it and a stable identity for the ledger. */
export interface BlueprintRepository {
	/** Root of the restored worktree. */
	readonly root: string;
	/** What makes two restores the same repository on this machine: its sorted remotes, else its root. */
	readonly identity: string;
	/** Run `initialize` whatever the ledger says, as for a worktree a prebuild builds from nothing (#4748). */
	readonly initialize?: boolean;
}

export interface BlueprintBuildConfig {
	readonly agentDir: string;
	/** Host directory that holds the build ledger, logs and `$ENVRC` files. */
	readonly storeDir: string;
	/** Whether the project at a worktree is trusted: only trusted projects run build steps. */
	readonly trusted: (worktree: string) => boolean;
	/** The deprecated `resume.setupCommand`, run as one global maintenance step in each restored repository root. */
	readonly setupCommand?: string;
	readonly platform?: BlueprintPlatform;
	readonly homeDir?: string;
	readonly now?: () => number;
	readonly stepTimeoutMs?: number;
	readonly fullBuildMaxAgeMs?: number;
	/** The environment steps start from. Default: the shell environment of Atomic's own tools. */
	readonly environment?: NodeJS.ProcessEnv;
	readonly fetchAction?: ActionFetcher;
}

/** A blueprint that did not complete: which one, which step, and where its log is. */
export interface BlueprintFailure {
	readonly scope: BlueprintScope;
	/** The blueprint file, or {@link SETUP_COMMAND_ALIAS}. */
	readonly blueprint: string;
	/** The repository root the blueprint belongs to; null for the global blueprint. */
	readonly root: string | null;
	/** The workspace directory within the repository, `.` for its root; null for the global blueprint. */
	readonly directory: string | null;
	readonly error: BlueprintError;
	readonly logPath: string | null;
	/** The end of the failing step's output. */
	readonly outputTail: string;
}

export type BlueprintLayerState =
	| { readonly kind: "built"; readonly action: "rebuild" | "inherit" }
	| {
			readonly kind: "not-run";
			readonly reason: "untrusted" | "in-place" | "earlier" | "global-failed" | "build-failed" | "skipped";
	  }
	| { readonly kind: "failed"; readonly failure: BlueprintFailure; readonly section: BlueprintSection | null }
	| { readonly kind: "no-document" };

/** One blueprint of a build: its document for this platform, and what the build did with it. */
export interface BlueprintLayer {
	readonly scope: BlueprintScope;
	readonly blueprint: string;
	readonly root: string | null;
	readonly directory: string | null;
	/** The document that targets this platform; undefined when the file is invalid or has none. */
	readonly document: BlueprintDocument | undefined;
	readonly state: BlueprintLayerState;
}

/**
 * `none`: no blueprint applies. `skipped`: blueprints apply but nothing ran (an untrusted project). `success`,
 * `partial` (a repository or workspace blueprint failed) and `failed` (the global blueprint or its post-build did).
 */
export type BlueprintBuildStatus = "none" | "skipped" | "success" | "partial" | "failed";

export interface BlueprintBuildOutcome {
	readonly status: BlueprintBuildStatus;
	/** Undefined when nothing ran. */
	readonly kind: "full" | "differential" | undefined;
	readonly layers: readonly BlueprintLayer[];
	readonly failures: readonly BlueprintFailure[];
	readonly warnings: readonly BlueprintWarning[];
	/** The workspace directories dropped from the ledger because their blueprint is gone. */
	readonly removed: readonly string[];
}

interface LoadedBlueprint {
	readonly path: string;
	readonly scope: BlueprintScope;
	readonly source: string | undefined;
	readonly parsed: ParsedBlueprint | undefined;
	readonly document: BlueprintDocument | undefined;
	/** Why the blueprint cannot be used: it is invalid, or it could not be read. */
	readonly invalid: BlueprintInvalidError | BlueprintBuildFailedError | undefined;
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

function unreadable(path: string, error: unknown): BlueprintBuildFailedError {
	return new BlueprintBuildFailedError(
		{ phase: "read-blueprint", detail: `${path} could not be read` },
		error instanceof Error ? error : new Error(String(error)),
	);
}

async function loadBlueprint(
	path: string,
	scope: BlueprintScope,
	platform: BlueprintPlatform,
): Promise<LoadedBlueprint> {
	let source: string | undefined;
	try {
		source = await readIfPresent(path);
	} catch (error) {
		return { path, scope, source: "", parsed: undefined, document: undefined, invalid: unreadable(path, error) };
	}
	if (source === undefined) return { path, scope, source, parsed: undefined, document: undefined, invalid: undefined };
	try {
		const parsed = parseBlueprint(source, { path, scope });
		return { path, scope, source, parsed, document: selectDocument(parsed, platform), invalid: undefined };
	} catch (error) {
		if (error instanceof BlueprintInvalidError) {
			return { path, scope, source, parsed: undefined, document: undefined, invalid: error };
		}
		return { path, scope, source, parsed: undefined, document: undefined, invalid: unreadable(path, error) };
	}
}

function aliasStep(command: string): RunStep {
	return { kind: "run", name: SETUP_COMMAND_ALIAS, run: command, env: {} };
}

/** The document of the global blueprint as the agent sees it: the alias is one more global maintenance step. */
function withAlias(document: BlueprintDocument | undefined, alias: string | undefined, platform: BlueprintPlatform) {
	if (alias === undefined) return document;
	const base: BlueprintDocument = document ?? {
		platforms: [platform],
		shell: "default",
		initialize: [],
		maintenance: [],
		knowledge: [],
		postBuild: [],
		includes: [],
	};
	return { ...base, maintenance: [...base.maintenance, aliasStep(alias)] };
}

function layerOf(
	loaded: LoadedBlueprint,
	root: string | null,
	directory: string | null,
	state: BlueprintLayerState,
	document: BlueprintDocument | undefined = loaded.document,
): BlueprintLayer {
	return { scope: loaded.scope, blueprint: loaded.path, root, directory, document, state };
}

async function loadGlobal(config: BlueprintBuildConfig, platform: BlueprintPlatform): Promise<LoadedBlueprint> {
	return loadBlueprint(getGlobalBlueprintPath(config.agentDir), "global", platform);
}

async function includedWorkspaces(
	root: string,
	rootBlueprint: LoadedBlueprint,
): Promise<{ readonly directory: string; readonly path: string }[]> {
	return (rootBlueprint.document?.includes ?? []).map((include) => ({
		directory: include.directory,
		path: join(root, include.file),
	}));
}

/**
 * What the blueprints of `repositories` and the global blueprint say, without running anything: every layer carries
 * `state` as given. This is what the agent is told when no build ran (an untrusted project, a checkout used in place).
 */
export async function describeBlueprints(
	repositories: readonly BlueprintRepository[],
	config: BlueprintBuildConfig,
	reason: "untrusted" | "in-place" | "earlier" | "build-failed" | "skipped",
	includeGlobal = true,
): Promise<BlueprintLayer[]> {
	const platform = config.platform ?? hostPlatform();
	const state: BlueprintLayerState = { kind: "not-run", reason };
	const layers: BlueprintLayer[] = [];
	const global = includeGlobal ? await loadGlobal(config, platform) : undefined;
	const globalDocument = withAlias(global?.document, config.setupCommand?.trim() || undefined, platform);
	if (global !== undefined && (globalDocument !== undefined || global.invalid !== undefined)) {
		layers.push(layerOf(global, null, null, state, globalDocument));
	}
	for (const repository of repositories) {
		layers.push(...(await describeRepository(repository, platform, state)));
	}
	return layers;
}

async function describeRepository(
	repository: BlueprintRepository,
	platform: BlueprintPlatform,
	state: BlueprintLayerState,
): Promise<BlueprintLayer[]> {
	const root = await loadBlueprint(getProjectBlueprintPath(repository.root), "repository", platform);
	if (root.source === undefined) return [];
	const layers = [layerOf(root, repository.root, ".", state)];
	for (const include of await includedWorkspaces(repository.root, root)) {
		const workspace = await loadBlueprint(include.path, "workspace", platform);
		if (workspace.source !== undefined) layers.push(layerOf(workspace, repository.root, include.directory, state));
	}
	return layers;
}

interface BuildRun {
	readonly config: BlueprintBuildConfig;
	readonly platform: BlueprintPlatform;
	readonly buildId: string;
	readonly full: boolean;
	readonly ledger: BlueprintLedger;
	readonly envrcPath: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly signal: AbortSignal | undefined;
	readonly layers: BlueprintLayer[];
	readonly failures: BlueprintFailure[];
	readonly warnings: BlueprintWarning[];
	readonly removed: string[];
	readonly workspaces: Map<string, WorkspaceLedgerEntry | null>;
	readonly roots: Map<string, "success" | "failed">;
}

function stepContext(
	run: BuildRun,
	options: { blueprint: string; scope: BlueprintScope; cwd: string; document: BlueprintDocument; tag: string },
): StepContext {
	return {
		blueprint: options.blueprint,
		scope: options.scope,
		cwd: options.cwd,
		shell: options.document.shell,
		platform: run.platform,
		envrcPath: run.envrcPath,
		logDirectory: join(run.config.storeDir, "blueprint-logs"),
		logPrefix: `${run.buildId}-${options.tag}`,
		timeoutMs: run.config.stepTimeoutMs ?? BLUEPRINT_STEP_TIMEOUT_MS,
		environment: run.environment,
		actionsCacheDir: getBlueprintActionsDir(run.config.agentDir),
		fetchAction: run.config.fetchAction,
		signal: run.signal,
	};
}

function tagOf(root: string | null, directory: string | null): string {
	if (root === null) return "global";
	const slug = (directory ?? ".").replaceAll(/[^A-Za-z0-9]+/gu, "_");
	return `${rootKey(root).slice(0, 8)}-${slug}`;
}

function failureOf(
	loaded: { path: string; scope: BlueprintScope },
	root: string | null,
	directory: string | null,
	step: StepFailure | { error: BlueprintError; logPath: null; outputTail: string },
): BlueprintFailure {
	return {
		scope: loaded.scope,
		blueprint: loaded.path,
		root,
		directory,
		error: step.error,
		logPath: step.logPath,
		outputTail: step.outputTail,
	};
}

function failureSection(error: BlueprintError): BlueprintSection | null {
	const section = (error.fields as { section?: unknown }).section;
	return section === "initialize" || section === "maintenance" || section === "post-build" ? section : null;
}

/** Builds one repository or workspace blueprint: initialize when it needs a rebuild, then maintenance. */
async function buildBlueprint(
	run: BuildRun,
	repository: BlueprintRepository,
	loaded: LoadedBlueprint,
	directory: string,
	forceRebuild: boolean,
): Promise<BlueprintLayer> {
	const key = workspaceKey(repository.identity, directory);
	const source = loaded.source ?? "";
	const digest = blueprintDigest(directory, source);
	const builtAt = new Date((run.config.now ?? Date.now)()).toISOString();
	const entry = run.ledger.workspaces[key];
	const action =
		run.full || forceRebuild || entry === undefined || entry.digest !== digest || entry.status !== "success"
			? "rebuild"
			: "inherit";
	const finish = (failure: BlueprintFailure | undefined): void => {
		run.workspaces.set(
			key,
			failure === undefined
				? { digest, status: "success", builtAt }
				: {
						digest,
						status: "failed",
						builtAt,
						failedStep: String((failure.error.fields as { step?: unknown }).step ?? failure.blueprint),
						...(failure.logPath === null ? {} : { logPath: failure.logPath }),
					},
		);
		if (failure !== undefined) run.failures.push(failure);
	};
	if (loaded.invalid !== undefined) {
		const failure = failureOf(loaded, repository.root, directory, {
			error: loaded.invalid,
			logPath: null,
			outputTail: "",
		});
		finish(failure);
		return layerOf(loaded, repository.root, directory, { kind: "failed", failure, section: null });
	}
	const document = loaded.document;
	if (document === undefined) {
		finish(undefined);
		return layerOf(loaded, repository.root, directory, { kind: "no-document" });
	}
	run.warnings.push(...(loaded.parsed?.warnings ?? []));
	const context = stepContext(run, {
		blueprint: loaded.path,
		scope: loaded.scope,
		cwd: directory === "." ? repository.root : join(repository.root, directory),
		document,
		tag: tagOf(repository.root, directory),
	});
	let failed: StepFailure | undefined;
	if (action === "rebuild") failed = (await runSection("initialize", document.initialize, context)).failure;
	if (failed === undefined) failed = (await runSection("maintenance", document.maintenance, context)).failure;
	const failure = failed === undefined ? undefined : failureOf(loaded, repository.root, directory, failed);
	finish(failure);
	return layerOf(
		loaded,
		repository.root,
		directory,
		failure === undefined
			? { kind: "built", action }
			: { kind: "failed", failure, section: failureSection(failure.error) },
	);
}

async function buildRepository(run: BuildRun, repository: BlueprintRepository, seen: Set<string>): Promise<void> {
	const forceRebuild =
		repository.initialize === true || run.ledger.roots[rootKey(repository.root)]?.state === "running";
	const root = await loadBlueprint(getProjectBlueprintPath(repository.root), "repository", run.platform);
	if (root.source === undefined) return;
	seen.add(workspaceKey(repository.identity, "."));
	run.layers.push(await buildBlueprint(run, repository, root, ".", forceRebuild));
	for (const include of await includedWorkspaces(repository.root, root)) {
		const workspace = await loadBlueprint(include.path, "workspace", run.platform);
		if (workspace.source !== undefined) {
			seen.add(workspaceKey(repository.identity, include.directory));
			run.layers.push(await buildBlueprint(run, repository, workspace, include.directory, forceRebuild));
		}
	}
}

function removedWorkspaces(run: BuildRun, repositories: readonly BlueprintRepository[], seen: Set<string>): void {
	for (const repository of repositories) {
		const prefix = `${repositoryKey(repository.identity)}:`;
		for (const key of Object.keys(run.ledger.workspaces)) {
			if (key.startsWith(prefix) && !seen.has(key)) {
				run.workspaces.set(key, null);
				run.removed.push(key.slice(prefix.length));
			}
		}
	}
}

async function runGlobalLayers(
	run: BuildRun,
	global: LoadedBlueprint,
	repositories: readonly BlueprintRepository[],
): Promise<BlueprintLayer | undefined> {
	const alias = run.config.setupCommand?.trim() || undefined;
	const document = global.document;
	const display = withAlias(document, alias, run.platform);
	if (global.invalid !== undefined) {
		const failure = failureOf(global, null, null, { error: global.invalid, logPath: null, outputTail: "" });
		run.failures.push(failure);
		return layerOf(global, null, null, { kind: "failed", failure, section: null });
	}
	if (display === undefined) return undefined;
	run.warnings.push(...(global.parsed?.warnings ?? []));
	const home = run.config.homeDir ?? getHomeDir();
	const context = (cwd: string, blueprint: string) =>
		stepContext(run, { blueprint, scope: "global", cwd, document: display, tag: "global" });
	let failed: StepFailure | undefined;
	if (document !== undefined && run.full) {
		failed = (await runSection("initialize", document.initialize, context(home, global.path))).failure;
	}
	if (failed === undefined && document !== undefined) {
		failed = (await runSection("maintenance", document.maintenance, context(home, global.path))).failure;
	}
	if (failed === undefined && alias !== undefined) {
		for (const repository of repositories) {
			const result = await runSection("maintenance", [aliasStep(alias)], {
				...context(repository.root, SETUP_COMMAND_ALIAS),
				logPrefix: `${run.buildId}-${tagOf(repository.root, "alias")}`,
			});
			if (result.failure !== undefined) {
				failed = result.failure;
				break;
			}
		}
	}
	if (failed === undefined)
		return layerOf(global, null, null, { kind: "built", action: run.full ? "rebuild" : "inherit" }, display);
	const failure = failureOf({ path: failedBlueprint(failed, global.path), scope: "global" }, null, null, failed);
	run.failures.push(failure);
	return layerOf(global, null, null, { kind: "failed", failure, section: failureSection(failed.error) }, display);
}

function failedBlueprint(failure: StepFailure, globalPath: string): string {
	const blueprint = (failure.error.fields as { blueprint?: unknown }).blueprint;
	return typeof blueprint === "string" ? blueprint : globalPath;
}

async function runPostBuild(run: BuildRun, global: LoadedBlueprint, layer: BlueprintLayer): Promise<BlueprintLayer> {
	const document = global.document;
	if (document === undefined || document.postBuild.length === 0) return layer;
	const context = stepContext(run, {
		blueprint: global.path,
		scope: "global",
		cwd: run.config.homeDir ?? getHomeDir(),
		document,
		tag: "global",
	});
	const { failure: failed } = await runSection("post-build", document.postBuild, context);
	if (failed === undefined) return layer;
	const failure = failureOf(global, null, null, failed);
	run.failures.push(failure);
	return { ...layer, state: { kind: "failed", failure, section: "post-build" } };
}

/** Runs `work`; its failure is the typed build failure of `phase`, with the original error as its cause. */
async function inPhase<T>(phase: "ledger" | "environment", detail: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (isBlueprintError(error)) throw error;
		throw new BlueprintBuildFailedError({ phase, detail }, error instanceof Error ? error : new Error(String(error)));
	}
}

async function writeSessionEnvironment(run: BuildRun, roots: readonly BlueprintRepository[]): Promise<void> {
	const content = await readFile(run.envrcPath, "utf8");
	for (const repository of roots) {
		const target = sessionEnvrcPath(run.config.storeDir, repository.root);
		if (content.trim() === "") {
			await rm(target, { force: true });
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await copyFile(run.envrcPath, target);
	}
}

function statusOf(run: BuildRun, globalFailed: boolean): BlueprintBuildStatus {
	if (globalFailed) return "failed";
	return run.failures.length > 0 ? "partial" : "success";
}

async function executeBuild(
	repositories: readonly BlueprintRepository[],
	config: BlueprintBuildConfig,
	signal: AbortSignal | undefined,
): Promise<BlueprintBuildOutcome> {
	const platform = config.platform ?? hostPlatform();
	const now = config.now ?? Date.now;
	const trusted = repositories.filter((repository) => config.trusted(repository.root));
	const untrusted = repositories.filter((repository) => !trusted.includes(repository));
	const global = await loadGlobal(config, platform);
	const alias = config.setupCommand?.trim() || undefined;
	const layers: BlueprintLayer[] = [];
	const untrustedLayers = await describeBlueprints(untrusted, config, "untrusted", false);
	const hasTrustedBlueprint =
		global.source !== undefined ||
		alias !== undefined ||
		(await Promise.all(trusted.map((repository) => fileExists(getProjectBlueprintPath(repository.root))))).some(
			Boolean,
		);
	if (trusted.length === 0 || !hasTrustedBlueprint) {
		const described = await describeBlueprints(trusted, config, trusted.length === 0 ? "untrusted" : "skipped");
		const all = [...described, ...untrustedLayers];
		return {
			status: all.length === 0 ? "none" : "skipped",
			kind: undefined,
			layers: all,
			failures: [],
			warnings: [],
			removed: [],
		};
	}
	const ledger = await inPhase("ledger", "the build ledger could not be read", () => readLedger(config.storeDir));
	const globalDigest = blueprintDigest(".", global.source ?? "", alias ?? "");
	const last = ledger.global;
	const full =
		last === undefined ||
		last.status !== "success" ||
		last.digest !== globalDigest ||
		last.lastFullBuildAt === undefined ||
		now() - Date.parse(last.lastFullBuildAt) > (config.fullBuildMaxAgeMs ?? BLUEPRINT_FULL_BUILD_MAX_AGE_MS);
	const buildId = `${new Date(now()).toISOString().replaceAll(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
	const envrcPath = join(config.storeDir, "blueprint-builds", `${buildId}.envrc`);
	await inPhase("environment", "the $ENVRC file could not be created", async () => {
		await mkdir(dirname(envrcPath), { recursive: true });
		await writeFile(envrcPath, "", { mode: 0o600 });
	});
	const run: BuildRun = {
		config,
		platform,
		buildId,
		full,
		ledger,
		envrcPath,
		environment: config.environment ?? getShellEnv(),
		signal,
		layers,
		failures: [],
		warnings: [],
		removed: [],
		workspaces: new Map(),
		roots: new Map(),
	};
	const startedAt = new Date(now()).toISOString();
	await inPhase("ledger", "the build ledger could not be written", () =>
		updateLedger(config.storeDir, (current) => ({
			...current,
			roots: {
				...current.roots,
				...Object.fromEntries(
					trusted.map((repository) => [rootKey(repository.root), { state: "running" as const, at: startedAt }]),
				),
			},
		})),
	);
	try {
		let globalLayer = await runGlobalLayers(run, global, trusted);
		const globalFailed = globalLayer?.state.kind === "failed";
		const seen = new Set<string>();
		if (globalFailed) {
			for (const repository of trusted) {
				run.layers.push(
					...(await describeRepository(repository, platform, { kind: "not-run", reason: "global-failed" })),
				);
			}
		} else {
			for (const repository of trusted) await buildRepository(run, repository, seen);
			removedWorkspaces(run, trusted, seen);
			if (globalLayer !== undefined) globalLayer = await runPostBuild(run, global, globalLayer);
		}
		const globalOk = globalLayer === undefined || globalLayer.state.kind !== "failed";
		const finishedAt = new Date(now()).toISOString();
		const failedRoots = new Set(run.failures.map((failure) => failure.root).filter((root) => root !== null));
		await inPhase("environment", "the $ENVRC of the build could not be kept for the session", () =>
			writeSessionEnvironment(run, trusted),
		);
		await inPhase("ledger", "the build ledger could not be written", () =>
			updateLedger(config.storeDir, (current) => {
				const workspaces = { ...current.workspaces };
				for (const [key, entry] of run.workspaces) {
					if (entry === null) delete workspaces[key];
					else workspaces[key] = entry;
				}
				return {
					version: 1,
					global: {
						digest: globalDigest,
						status: globalOk ? "success" : "failed",
						builtAt: finishedAt,
						...(globalOk && full
							? { lastFullBuildAt: finishedAt }
							: !full && last?.lastFullBuildAt !== undefined
								? { lastFullBuildAt: last.lastFullBuildAt }
								: {}),
					},
					workspaces,
					roots: {
						...current.roots,
						...Object.fromEntries(
							trusted.map((repository) => [
								rootKey(repository.root),
								{
									state:
										!globalOk || failedRoots.has(repository.root)
											? ("failed" as const)
											: ("success" as const),
									at: finishedAt,
								},
							]),
						),
					},
				};
			}),
		);
		return {
			status: statusOf(run, !globalOk),
			kind: full ? "full" : "differential",
			layers: [...(globalLayer === undefined ? [] : [globalLayer]), ...run.layers, ...untrustedLayers],
			failures: run.failures,
			warnings: run.warnings,
			removed: run.removed,
		};
	} finally {
		await rm(envrcPath, { force: true });
	}
}

function crashedBuild(error: unknown): BlueprintBuildFailedError {
	const cause = error instanceof Error ? error : new Error(String(error));
	return new BlueprintBuildFailedError({ phase: "unknown", detail: cause.message.slice(0, 200) }, cause);
}

/**
 * The layers of a build that stopped before it finished: what each repository's blueprints say, labelled as not
 * confirmed, and the global layer carrying `failure`, so the agent still gets the maintenance, the knowledge and the
 * failure. Never throws: when the blueprints cannot even be described, only the global layer is returned.
 */
async function layersOfCrashedBuild(
	repositories: readonly BlueprintRepository[],
	config: BlueprintBuildConfig,
	failure: BlueprintFailure,
): Promise<BlueprintLayer[]> {
	const failedState: BlueprintLayerState = { kind: "failed", failure, section: null };
	const bare: BlueprintLayer = {
		scope: "global",
		blueprint: failure.blueprint,
		root: null,
		directory: null,
		document: undefined,
		state: failedState,
	};
	try {
		const trusted = repositories.filter((repository) => config.trusted(repository.root));
		const untrusted = repositories.filter((repository) => !trusted.includes(repository));
		const described = [
			...(await describeBlueprints(trusted, config, "build-failed")),
			...(await describeBlueprints(untrusted, config, "untrusted", false)),
		];
		const global = described.find((layer) => layer.scope === "global");
		return [{ ...(global ?? bare), state: failedState }, ...described.filter((layer) => layer.scope !== "global")];
	} catch {
		return [bare];
	}
}

/**
 * Builds the worktrees a resume restored: global `initialize` (in a full build) and `maintenance`, then each trusted
 * repository's `initialize` (when it needs a rebuild) and `maintenance` with its included workspaces, then the global
 * `post-build`. A step that fails stops the rest of its blueprint, never the other blueprints, and never the resume:
 * the failure is in the outcome. Only `signal` aborting rejects, with its reason. Untrusted repositories run nothing.
 */
export async function runBlueprintBuild(
	repositories: readonly BlueprintRepository[],
	config: BlueprintBuildConfig,
	signal?: AbortSignal,
): Promise<BlueprintBuildOutcome> {
	signal?.throwIfAborted();
	try {
		return await executeBuild(repositories, config, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		const crash = isBlueprintError(error) ? error : crashedBuild(error);
		const failure: BlueprintFailure = {
			scope: "global",
			blueprint: getGlobalBlueprintPath(config.agentDir),
			root: null,
			directory: null,
			error: crash,
			logPath: null,
			outputTail: "",
		};
		return {
			status: "failed",
			kind: undefined,
			layers: await layersOfCrashedBuild(repositories, config, failure),
			failures: [failure],
			warnings: [],
			removed: [],
		};
	}
}

/**
 * Whether the worktree at `root`, restored by Atomic, still needs a build: its last build failed or never finished, or
 * the ledger has no record of one (the worktree was never built, or a build died before it could write one).
 */
export function needsRebuild(ledger: BlueprintLedger, root: string): boolean {
	const state = ledger.roots[rootKey(root)]?.state;
	return state === undefined || state === "failed" || state === "running";
}
