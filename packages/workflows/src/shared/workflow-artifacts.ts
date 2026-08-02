import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, getEnvValue } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { getDurableBackend } from "../durable/factory.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
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
		run.exitReason === "quit" ||
		run.resumable === true
	) {
		return "protected";
	}
	return "terminal";
}

function durableRunState(backend: DurableWorkflowBackend, runId: string): WorkflowArtifactRunState | undefined {
	const handle = backend.getLoadableWorkflow(runId);
	if (handle === undefined) return undefined;
	if (
		handle.status === "running" ||
		handle.status === "paused" ||
		handle.status === "blocked" ||
		handle.pendingPrompts > 0 ||
		handle.resumable === true ||
		isDurableWorkflowResumable(handle)
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
			// Ordering invariant: durable history is explicit-delete-only in this
			// release. If aligned durable retention is added later, delete the durable
			// entry first, then this directory; never leave resumable metadata pointing
			// at an artifact directory that has already been removed.
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
		await pending;
		return;
	}
	const previous = lastArtifactPruneAt.get(root);
	if (previous !== undefined && now - previous < ARTIFACT_PRUNE_RECHECK_MS) return;
	const operation = pruneWorkflowArtifactRuns(root, now, createWorkflowArtifactRunStateResolver());
	pendingArtifactPrunes.set(root, operation);
	try {
		await operation;
		lastArtifactPruneAt.set(root, now);
	} catch (error) {
		lastArtifactPruneAt.delete(root);
		throw error;
	} finally {
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

/** Create a durable run directory and prune expired siblings after resolving their state. */
export async function createWorkflowArtifactDirectory(runId?: string): Promise<string> {
	const effectiveRunId = runId ?? store.activeRunId() ?? randomUUID();
	return ensureWorkflowArtifactRunDirectory(effectiveRunId);
}
