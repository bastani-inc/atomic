import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, getEnvValue } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { getDurableBackend } from "../durable/factory.js";
import { type WorkflowRunResumeCandidate, workflowRunHasPausedState } from "../durable/resume-eligibility.js";
import { store } from "./store.js";
import type { RunSnapshot } from "./store-types.js";

/** Maximum age of durable workflow run artifacts before the next workflow write prunes them. */
export const WORKFLOW_ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Overrides the durable workflow-artifact root, mirroring the agent-directory override convention. */
export const ENV_WORKFLOW_ARTIFACT_DIR = "ATOMIC_WORKFLOW_ARTIFACT_DIR";

export type WorkflowArtifactRunState = "protected" | "terminal" | "orphan";
export type WorkflowArtifactRunStateResolver = (runId: string) => WorkflowArtifactRunState | undefined;

const ARTIFACT_PRUNE_RECHECK_MS = 60 * 60 * 1000;
const lastArtifactPruneAt = new Map<string, number>();
const pendingArtifactPrunes = new Map<string, Promise<void>>();

function workflowArtifactRoot(): string {
	const override = getEnvValue(ENV_WORKFLOW_ARTIFACT_DIR);
	if (override !== undefined && override.length > 0) return override;
	return join(dirname(getAgentDir()), "workflows");
}

export function workflowArtifactRunsRoot(): string {
	return join(workflowArtifactRoot(), "runs");
}

function safeRunId(runId: string): string {
	const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
	return safe.length > 0 ? safe : "run";
}

export function workflowArtifactRunPath(runId: string): string {
	return join(workflowArtifactRunsRoot(), safeRunId(runId));
}

/**
 * Detect a run-scoped artifact path anywhere in a run's result or stages.
 *
 * `JSON.stringify` escapes each Windows separator, so `…\runs\<id>\…` serializes
 * as `…\\runs\\<id>\\…` and a single backslash-to-slash pass leaves `//runs//`.
 * Collapsing repeated separators after that pass makes the probe behave the same
 * on both platforms; without it every Windows artifact reference was invisible,
 * so no run was ever reported as having lost its artifacts.
 */
export function workflowRunHasArtifactReference(run: Pick<RunSnapshot, "id" | "result" | "stages">): boolean {
	const serialized = JSON.stringify({ result: run.result, stages: run.stages });
	if (serialized === undefined) return false;
	const normalized = serialized.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
	return normalized.includes(`/runs/${safeRunId(run.id)}/`);
}

/** Return artifact integrity only for runs whose snapshot names a run-scoped artifact. */
export function workflowRunArtifactsIntact(run: Pick<RunSnapshot, "id" | "result" | "stages">): boolean | undefined {
	if (!workflowRunHasArtifactReference(run)) return undefined;
	return existsSync(workflowArtifactRunPath(run.id));
}

/** Build the one resume candidate shape used by all live-run resume surfaces. */
export function workflowRunResumeCandidate(run: RunSnapshot): WorkflowRunResumeCandidate {
	const artifactsIntact = workflowRunArtifactsIntact(run);
	let hasDurableCheckpoint: boolean | undefined;
	try {
		hasDurableCheckpoint = getDurableBackend().isWorkflowLoadable(run.id);
	} catch {
		// A backend that is not ready cannot prove a missing checkpoint.
	}
	return {
		...run,
		hasPausedState: workflowRunHasPausedState(run),
		...(hasDurableCheckpoint === undefined ? {} : { hasDurableCheckpoint }),
		...(artifactsIntact === undefined ? {} : { artifactsIntact }),
	};
}

/**
 * Protection means live work, not "could theoretically be resumed".
 *
 * A run still in flight, holding a pending prompt, or explicitly quit keeps its
 * artifacts indefinitely, because a resume is expected and those files are its
 * inputs. A run that has FAILED is terminal: it is retryable, but the retention
 * window is precisely the grace period it gets. Treating `resumable === true` as
 * protection made every failed run permanent, so repeated recoverable failures
 * accumulated run-scoped artifacts that the advertised window never reclaimed.
 */
function storeRunState(run: RunSnapshot): WorkflowArtifactRunState {
	const hasPendingInput =
		run.pendingPrompt !== undefined ||
		run.stages.some(
			(stage) => stage.status === "awaiting_input" || stage.status === "paused" || stage.status === "blocked",
		);
	if (
		hasPendingInput ||
		run.status === "pending" ||
		run.status === "running" ||
		run.status === "paused" ||
		run.status === "blocked" ||
		run.exitReason === "quit"
	) {
		return "protected";
	}
	return "terminal";
}

function durableRunState(backend: DurableWorkflowBackend, runId: string): WorkflowArtifactRunState | undefined {
	const handle = backend.getLoadableWorkflow(runId);
	if (handle === undefined) return undefined;
	// `isDurableWorkflowResumable` deliberately accepts `failed`, so it cannot be
	// used here: it would pin a failed run's artifacts forever.
	if (
		handle.status === "running" ||
		handle.status === "paused" ||
		handle.status === "blocked" ||
		handle.pendingPrompts > 0
	) {
		return "protected";
	}
	return "terminal";
}

/**
 * Snapshot the live store and durable backend once for a pruning pass. This
 * keeps the transcript write path from querying durable state once per stage.
 */
export function createWorkflowArtifactRunStateResolver(): WorkflowArtifactRunStateResolver {
	const localRuns = new Map(store.runs().map((run) => [run.id, run]));
	let backend: DurableWorkflowBackend | undefined;
	let backendReady = true;
	try {
		backend = getDurableBackend();
	} catch {
		backendReady = false;
	}
	return (runId: string): WorkflowArtifactRunState | undefined => {
		const local = localRuns.get(runId) ?? [...localRuns.values()].find((run) => safeRunId(run.id) === runId);
		const localState = local === undefined ? undefined : storeRunState(local);
		if (!backendReady) {
			// An unavailable durable backend cannot prove that even a terminal-looking
			// local snapshot has no resumable durable counterpart.
			return localState === "protected" ? "protected" : undefined;
		}
		let durable: WorkflowArtifactRunState | undefined;
		if (backend !== undefined) {
			try {
				durable = durableRunState(backend, runId);
			} catch {
				backendReady = false;
				return localState === "protected" ? "protected" : undefined;
			}
		}
		if (durable === "protected" || localState === "protected") return "protected";
		if (durable === "terminal" || localState === "terminal") return "terminal";
		return "orphan";
	};
}

/** Resolve one run's artifact ownership from a fresh durable/store snapshot. */
export function resolveWorkflowArtifactRunState(runId: string): WorkflowArtifactRunState | undefined {
	return createWorkflowArtifactRunStateResolver()(runId);
}

/** Delete the durable owner of a terminal run before its artifacts are removed. */
async function deleteTerminalDurableEntry(runId: string): Promise<boolean> {
	let backend: DurableWorkflowBackend;
	try {
		backend = getDurableBackend();
	} catch {
		return false;
	}
	try {
		const result = await backend.deleteWorkflowIfInactive(runId);
		return result.ok || result.reason === "not_found";
	} catch {
		return false;
	}
}

/** Remove stale run directories, retaining artifacts for resumable/non-terminal runs. */
export async function pruneWorkflowArtifactRuns(
	root = workflowArtifactRunsRoot(),
	now = Date.now(),
	stateResolver?: WorkflowArtifactRunStateResolver,
): Promise<void> {
	try {
		const entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const entryPath = join(root, entry.name);
			let metadata: Awaited<ReturnType<typeof stat>>;
			try {
				metadata = await stat(entryPath);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			if (now - metadata.mtimeMs <= WORKFLOW_ARTIFACT_RETENTION_MS) continue;
			// Without authoritative state, preserve the directory. An unknown run is
			// not safe to classify as history merely because its mtime is old.
			if (stateResolver === undefined) continue;
			const state = stateResolver(entry.name);
			if (state !== "terminal" && state !== "orphan") continue;
			// Delete the durable owner first. If authoritative deletion is unavailable
			// or refuses an active run, preserve the directory rather than leaving a
			// durable entry pointing at missing artifacts.
			if (state === "terminal" && !(await deleteTerminalDurableEntry(entry.name))) continue;
			await rm(entryPath, { recursive: true, force: true });
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

async function pruneArtifactRootIfDue(root: string, now: number): Promise<void> {
	const pending = pendingArtifactPrunes.get(root);
	if (pending !== undefined) {
		try {
			await pending;
		} catch {
			// Pruning is opportunistic and must never block a stage artifact write.
		}
		return;
	}
	const previous = lastArtifactPruneAt.get(root);
	if (previous !== undefined && now - previous < ARTIFACT_PRUNE_RECHECK_MS) return;
	const operation = pruneWorkflowArtifactRuns(root, now, createWorkflowArtifactRunStateResolver());
	pendingArtifactPrunes.set(root, operation);
	try {
		await operation;
	} catch {
		// A stale sibling that cannot be inspected is retained; writes continue.
	} finally {
		lastArtifactPruneAt.set(root, now);
		pendingArtifactPrunes.delete(root);
	}
}

/** Ensure a run-scoped durable directory exists and perform bounded state-aware GC at most hourly. */
export async function ensureWorkflowArtifactRunDirectory(runId: string): Promise<string> {
	const root = workflowArtifactRunsRoot();
	await pruneArtifactRootIfDue(root, Date.now());
	const directory = workflowArtifactRunPath(runId);
	await mkdir(directory, { recursive: true });
	return directory;
}

/** Create a unique durable artifact directory beneath the owning run and prune expired siblings. */
export async function createWorkflowArtifactDirectory(runId?: string): Promise<string> {
	const effectiveRunId = runId ?? randomUUID();
	const runDirectory = await ensureWorkflowArtifactRunDirectory(effectiveRunId);
	const artifactDirectory = join(runDirectory, `artifact-${randomUUID()}`);
	await mkdir(artifactDirectory, { recursive: true });
	return artifactDirectory;
}
