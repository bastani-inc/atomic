import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { SessionManager } from "../../session-manager.ts";
import {
	type BlueprintBuildConfig,
	type BlueprintBuildOutcome,
	type BlueprintLayer,
	type BlueprintRepository,
	describeBlueprints,
	needsRebuild,
	runBlueprintBuild,
} from "./build.ts";
import { BLUEPRINT_CONTEXT_TYPE, renderBlueprintContext } from "./context.ts";
import { BlueprintBuildFailedError } from "./errors.ts";
import { type BlueprintLedger, readLedger, rootKey } from "./ledger.ts";
import { type BlueprintNotice, blueprintNotices } from "./notices.ts";

/** A checkout of a session's repository on this node, with the remotes its snapshot recorded. */
export interface BlueprintCheckout {
	readonly root: string;
	readonly remotes: readonly string[];
}

/** The repository a checkout belongs to for the build ledger: its sorted remotes, else its own root. */
export function blueprintRepository(checkout: BlueprintCheckout): BlueprintRepository {
	const identity = checkout.remotes.length === 0 ? checkout.root : [...checkout.remotes].sort().join("\n");
	return { root: checkout.root, identity };
}

/** A restore a session or run recorded: work under `from` continues under `to`. */
export interface RestoreLink {
	readonly from: string;
	readonly to: string;
	readonly snapshotId: string;
}

function latestRestoreInto(restores: readonly RestoreLink[], root: string): RestoreLink | undefined {
	for (let index = restores.length - 1; index >= 0; index--) {
		const restore = restores[index]!;
		if (resolve(restore.to) === root) return restore;
	}
	return undefined;
}

/**
 * The remotes that identify the repository of the checkout at `root` for the build ledger. A worktree that an Atomic
 * before 0.9.85 restored comes from a store without remotes, so a snapshot captured inside it records none; the
 * repository's remotes are then found by following the recorded restores back, from the worktree to the checkout it
 * replaced, to the first snapshot that has some. `own` are the remotes of the checkout's own latest snapshot. Empty when the chain has none, in which
 * case the repository is identified by its root.
 */
export function inheritedRemotes(
	root: string,
	own: readonly string[],
	restores: readonly RestoreLink[],
	snapshots: ReadonlyMap<string, { readonly remotes: readonly string[] }>,
): readonly string[] {
	if (own.length > 0) return own;
	let current = resolve(root);
	for (let hop = 0; hop < restores.length; hop++) {
		const link = latestRestoreInto(restores, current);
		if (link === undefined) break;
		const remotes = snapshots.get(link.snapshotId)?.remotes ?? [];
		if (remotes.length > 0) return remotes;
		current = resolve(link.from);
	}
	return [];
}

/** What a resume does with the blueprints: the outcome of the build, what the user is told, what the agent is told. */
export interface ResumedBlueprints {
	/** Undefined when no build was attempted. */
	readonly outcome: BlueprintBuildOutcome | undefined;
	readonly notices: readonly BlueprintNotice[];
	readonly layers: readonly BlueprintLayer[];
	/** The first-turn context for the agent; undefined when no blueprint has anything to say. */
	readonly context: string | undefined;
}

export interface SetUpBlueprintsOptions {
	/** Worktrees Atomic restored for this resume, or earlier and then failed to build: built now. */
	readonly restored: readonly BlueprintCheckout[];
	/** Checkouts used as they are or restored earlier and built then: only described for the agent. */
	readonly inPlace?: readonly BlueprintCheckout[];
	readonly earlier?: readonly BlueprintCheckout[];
	readonly config: BlueprintBuildConfig;
	readonly signal?: AbortSignal;
}

/**
 * Builds the blueprints of the worktrees a resume restored and describes every checkout the session works in.
 */
async function setUpAndDescribe(options: SetUpBlueprintsOptions): Promise<ResumedBlueprints> {
	const restored = options.restored.map(blueprintRepository);
	const outcome =
		restored.length === 0 ? undefined : await runBlueprintBuild(restored, options.config, options.signal);
	const layers: BlueprintLayer[] = [...(outcome?.layers ?? [])];
	const described: [readonly BlueprintCheckout[] | undefined, "in-place" | "earlier"][] = [
		[options.inPlace, "in-place"],
		[options.earlier, "earlier"],
	];
	for (const [checkouts, reason] of described) {
		if (checkouts === undefined || checkouts.length === 0) continue;
		const includeGlobal = !layers.some((layer) => layer.scope === "global");
		layers.push(
			...(await describeBlueprints(checkouts.map(blueprintRepository), options.config, reason, includeGlobal)),
		);
	}
	if (outcome === undefined && !layers.some((layer) => layer.scope === "global")) {
		layers.unshift(...(await describeBlueprints([], options.config, "skipped")));
	}
	const notRemembered = await persistRootContexts(options.config.storeDir, restored, layers);
	return {
		outcome,
		notices: [
			...(outcome === undefined ? [] : blueprintNotices(outcome, Boolean(options.config.setupCommand?.trim()))),
			...notRemembered,
		],
		layers,
		context: renderBlueprintContext(layers),
	};
}

/**
 * What a resumed session's first turn carries while the blueprint build runs behind it (`resume.waitForBlueprint:
 * "tools"`), in place of the blueprint context the build produces.
 */
export const BLUEPRINT_BUILDING_CONTEXT = [
	"<blueprint_context>",
	"This session was resumed, and the environment of the worktrees it restored is still being built by their blueprints (.atomic/blueprint.yaml files). Tools that run project code or read the worktree wait until the build ends; the first of them then reports how the build went and what the blueprints say.",
	"</blueprint_context>",
].join("\n");

/**
 * What the agent is told about a blueprint build that ran behind the first turn, with the first tool that waited for
 * it: whether it finished cleanly, the warnings the user would have seen at resume, and the blueprint context.
 */
export function blueprintBuildReport(blueprints: ResumedBlueprints): string {
	const status = blueprints.outcome?.status;
	const clean = blueprints.notices.length === 0 && status !== "partial" && status !== "failed";
	return [
		"<blueprint_build_finished>",
		clean
			? "The environment build of this resumed session has finished."
			: "The environment build of this resumed session has finished with problems:",
		...blueprints.notices.map((notice) => `- ${notice.message}`),
		"</blueprint_build_finished>",
		...(blueprints.context === undefined ? [] : [blueprints.context]),
	].join("\n");
}

/**
 * Builds the blueprints of the worktrees a resume restored and describes every checkout the session works in. Never
 * rejects for a blueprint or for the state it keeps: a failure is in the outcome and the notices, and an unexpected
 * one becomes a warning that the session resumed anyway. Only `signal` aborting rejects, with its reason.
 */
export async function setUpResumedBlueprints(options: SetUpBlueprintsOptions): Promise<ResumedBlueprints> {
	try {
		return await setUpAndDescribe(options);
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const failure = error instanceof Error ? error : new Error(String(error));
		return {
			outcome: undefined,
			notices: [
				{
					type: "warning",
					message: `Blueprint setup stopped unexpectedly: ${failure.message.slice(0, 200)}. The session resumed anyway.`,
				},
			],
			layers: [],
			context: undefined,
		};
	}
}

/**
 * The restored worktrees of `checkouts` whose last build failed or never finished: they are built again. When the
 * ledger cannot be read, none is known to be built, so all are; the build then reports the ledger as the failure.
 */
export async function checkoutsNeedingRebuild(
	checkouts: readonly BlueprintCheckout[],
	storeDir: string,
): Promise<BlueprintCheckout[]> {
	let ledger: BlueprintLedger;
	try {
		ledger = await readLedger(storeDir);
	} catch {
		return [...checkouts];
	}
	return checkouts.filter((checkout) => needsRebuild(ledger, checkout.root));
}

/**
 * Puts `context` in the session so the agent sees it in its next turn, unless the latest blueprint context in the
 * session already says the same. A session that resumes again before anything changed gets no duplicate.
 */
export async function recordBlueprintContext(
	sessionManager: SessionManager,
	context: string | undefined,
): Promise<void> {
	if (context === undefined) return;
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom_message" && entry.customType === BLUEPRINT_CONTEXT_TYPE) {
			if (entry.content === context) return;
			break;
		}
	}
	await sessionManager.appendCustomMessageEntry(BLUEPRINT_CONTEXT_TYPE, context, false);
}

/** The root of the repository `directory` is in, found by looking for `.git` upward; undefined outside a repository. */
export function enclosingRepositoryRoot(directory: string): string | undefined {
	let current = directory;
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current || current === parse(current).root) return undefined;
		current = parent;
	}
}

function contextFile(storeDir: string, root: string): string {
	return join(storeDir, "blueprint-context", `${rootKey(root)}.md`);
}

/**
 * Keeps, for each worktree a build just set up, what the agent is told about it, so a session that starts in that
 * worktree later without this resume (a stage of a resumed workflow run, a pooled child) is told the same.
 */
async function persistRootContexts(
	storeDir: string,
	restored: readonly BlueprintRepository[],
	layers: readonly BlueprintLayer[],
): Promise<BlueprintNotice[]> {
	try {
		for (const repository of restored) {
			const context = renderBlueprintContext(
				layers.filter((layer) => layer.scope === "global" || layer.root === repository.root),
			);
			const file = contextFile(storeDir, repository.root);
			if (context === undefined) {
				await rm(file, { force: true });
				continue;
			}
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, context, { mode: 0o600 });
		}
		return [];
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return [
			{
				type: "warning",
				message: `The blueprint context could not be kept for later sessions in these worktrees: ${reason.slice(0, 200)}.`,
			},
		];
	}
}

/** The worktree this machine restored that holds `directory`, under `storeDir`; undefined for any other directory. */
export function restoredWorktreeOf(storeDir: string, directory: string): string | undefined {
	const worktrees = resolve(storeDir, "worktrees");
	const path = relative(worktrees, resolve(directory));
	if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
	return join(worktrees, path.split(sep)[0]!);
}

/**
 * Puts the blueprint context of the worktree `directory` is in into a session that starts there without a resume of
 * its own, such as a stage of a resumed workflow run. A directory outside the restored worktrees adds nothing. Never
 * rejects: a kept context that cannot be read is returned as the typed failure, for the caller to report once, and the
 * session starts without it.
 */
export async function recordRestoredWorktreeContext(
	sessionManager: SessionManager,
	storeDir: string,
	directory: string,
): Promise<BlueprintBuildFailedError | undefined> {
	const root = restoredWorktreeOf(storeDir, directory);
	if (root === undefined) return undefined;
	let context: string;
	try {
		context = await readFile(contextFile(storeDir, root), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return new BlueprintBuildFailedError(
			{ phase: "environment", detail: `the blueprint context kept for ${root} could not be read` },
			error instanceof Error ? error : new Error(String(error)),
		);
	}
	await recordBlueprintContext(sessionManager, context);
	return undefined;
}
