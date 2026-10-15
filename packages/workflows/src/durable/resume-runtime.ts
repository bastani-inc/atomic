import { raceAbort } from "../shared/abort.js";
/** Resume workflows from durable checkpoints without repeating completed work. */

import type { JobTracker } from "../runs/background/job-tracker.js";
import { launchDetachedUntilStartup, workflowStartupFailureMessage } from "../runs/background/startup-admission.js";
import {
	isWorkflowDefinition,
	workflowDefinitionRequirementMessage,
} from "../runs/foreground/executor-child-helpers.js";
import { resolveAndValidateInputs } from "../runs/foreground/executor-inputs.js";
import type { RunOpts } from "../runs/foreground/executor-types.js";
import { isFullRunId, resolveRunIdTarget } from "../shared/run-id.js";
import type { WorkflowDefinition, WorkflowInputValues } from "../shared/types.js";
import type { WorkflowRegistry } from "../workflows/registry.js";
import { type DurableWorkflowBackend, resumableEntryFromHandle } from "./backend.js";
import { durableWorkflowRunSnapshots } from "./completed-catalog.js";
import { getDurableBackend } from "./factory.js";
import { forkDurableWorkflow } from "./fork-workflow.js";
import { JournalDurableBackend } from "./journal/journal-backend.js";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import { foreignInstanceMessage } from "./sdk-owner-release.js";
import { canonicalDirectory, isSdkRunAdoptable } from "./sdk-recovery-scope.js";
import { resolveToolResumeFrontier } from "./tool-resume-frontier.js";
import type { ResumableWorkflowEntry } from "./types.js";

export type ResumeDurableResult =
	| { ok: true; runId: string; workflowId: string; name: string; message: string }
	| {
			ok: false;
			reason:
				| "workflow_not_found"
				| "not_resumable"
				| "owned_elsewhere"
				| "invalid_inputs"
				| "not_registered"
				| "stale"
				| "different_project"
				| "startup_failed";
			message: string;
	  };

export interface ResumeDurableDeps {
	readonly registry: WorkflowRegistry;
	/** Base run options forwarded to the detached runner (store, persistence, …). */
	readonly baseRunOpts: RunOpts;
	/** Durable backend override (defaults to the global singleton). */
	readonly durableBackend?: DurableWorkflowBackend;
	/** Resolve a definition from its original invocation directory after restart. */
	readonly resolveDefinition?: (name: string, cwd: string | undefined) => Promise<WorkflowDefinition | undefined>;
	/** Job tracker used by the detached resume launch. */
	readonly jobs?: JobTracker;
	readonly signal?: AbortSignal;
	readonly onRunAccepted?: (runId: string) => void;
	readonly onBeforeResume?: (runId: string, forkedFrom?: string) => Promise<void>;
	readonly confirmCrossProjectFork?: (cwd: string) => Promise<boolean>;
	readonly forkModelOwner?: string;
}

/** Refresh metadata and checkpoints before synchronous replay reads. */
export async function prepareDurableResume(
	workflowId: string | undefined,
	deps: ResumeDurableDeps,
): Promise<readonly ResumableWorkflowEntry[]> {
	const backend = deps.durableBackend ?? getDurableBackend();
	await backend.hydrateResumableWorkflows();
	const catalog = backend.listResumableWorkflows();
	// If a specific target was requested, hydrate that workflow too (it might
	// be resumable but not yet in the resumable filter — e.g. recently failed).
	if (workflowId !== undefined) {
		const resolved = resolveDurableEntry(workflowId, catalog);
		if (resolved !== undefined && !("kind" in resolved)) {
			await backend.hydrateWorkflow(resolved.workflowId);
		}
	}
	return backend.listResumableWorkflows();
}

/**
 * Resolve a catalog entry by full run id or unique 8-hex prefix.
 *
 * The durable `workflowId` is the live run id, so it takes the same strict
 * contract. Malformed and ambiguous targets are reported separately from an
 * absent one.
 */
export function resolveDurableEntry(
	workflowId: string,
	catalog: readonly ResumableWorkflowEntry[],
): ResumableWorkflowEntry | { kind: "malformed" | "ambiguous"; message: string } | undefined {
	const resolution = resolveRunIdTarget(
		workflowId,
		catalog.map((entry) => entry.workflowId),
	);
	if (resolution.kind === "not_found") return undefined;
	if (resolution.kind === "malformed" || resolution.kind === "ambiguous") return resolution;
	return catalog.find((entry) => entry.workflowId === resolution.runId);
}

export function crossProjectResumeMessage(workflowId: string, cwd: string): string {
	return `Workflow run found in different project: ${cwd}. Run /workflow resume ${workflowId} in an interactive session to fork it into the current directory, or open the original project to resume it.`;
}

const pendingResumes = new WeakMap<DurableWorkflowBackend, Set<string>>();
const unsettledResumeClaims = new WeakMap<DurableWorkflowBackend, Set<string>>();

/** Serialize admission per durable identity, including callers from different runtime views. */
export async function resumeDurableWorkflow(
	workflowId: string,
	deps: ResumeDurableDeps,
	catalog?: readonly ResumableWorkflowEntry[],
): Promise<ResumeDurableResult> {
	const backend = deps.durableBackend ?? getDurableBackend();
	const target = resolveDurableEntry(workflowId, catalog ?? backend.listResumableWorkflows());
	const id = target !== undefined && !("kind" in target) ? target.workflowId : workflowId;
	let pending = pendingResumes.get(backend);
	if (pending === undefined) {
		pending = new Set();
		pendingResumes.set(backend, pending);
	}
	if (pending.has(id) || unsettledResumeClaims.get(backend)?.has(id) || deps.jobs?.has(id))
		return {
			ok: false,
			reason: "not_resumable",
			message: `Workflow ${id} is already running or has a pending resume admission.`,
		};
	pending.add(id);
	try {
		const resume = () => resumeDurableWorkflowClaimed(workflowId, deps, catalog);
		const execution = backend instanceof JournalDurableBackend ? backend.withWorkflowLease(id, resume) : resume();
		return await raceAbort(execution, deps.signal);
	} finally {
		pending.delete(id);
	}
}

/** Resume by workflow id and replay persisted checkpoints. */
async function resumeDurableWorkflowClaimed(
	workflowId: string,
	deps: ResumeDurableDeps,
	catalog?: readonly ResumableWorkflowEntry[],
): Promise<ResumeDurableResult> {
	deps.signal?.throwIfAborted();
	const backend = deps.durableBackend ?? getDurableBackend();
	const knownCatalog = catalog ?? backend.listResumableWorkflows();
	const target = resolveRunIdTarget(
		workflowId,
		knownCatalog.map((entry) => entry.workflowId),
	);
	if (target.kind === "malformed" || target.kind === "ambiguous") {
		return { ok: false, reason: "not_registered", message: target.message };
	}
	if (target.kind === "not_found") {
		if (!isFullRunId(workflowId)) {
			return { ok: false, reason: "not_registered", message: `No resumable workflow found for id: ${workflowId}` };
		}
	} else {
		workflowId = target.runId;
	}
	const initial = backend.getWorkflow(workflowId);
	const currentCwd = deps.baseRunOpts.cwd;
	const crossProject =
		initial?.invocationCwd !== undefined &&
		currentCwd !== undefined &&
		canonicalDirectory(initial.invocationCwd) !== canonicalDirectory(currentCwd);
	const resolvedCatalog = catalog ?? backend.listResumableWorkflows();
	const resolved = resolveDurableEntry(workflowId, resolvedCatalog);
	if (resolved === undefined) {
		const direct = backend.getWorkflow(workflowId);
		if (direct !== undefined && direct.status === "running") {
			if (hasActiveLiveRun(deps.baseRunOpts.store, direct.workflowId)) {
				return alreadyRunningResult(direct.name, direct.workflowId, deps.baseRunOpts.store);
			}
			if (backend.workflowOwnership(direct.workflowId) === "foreign") {
				return foreignRunningResult(direct.name, direct.workflowId);
			}
		}
		if (!backend.isWorkflowLoadable(workflowId)) {
			return {
				ok: false,
				reason: "not_registered",
				message: `Workflow ${workflowId} has no valid journal state.`,
			};
		}
		return {
			ok: false,
			reason: "not_registered",
			message: `No resumable workflow found for id: ${workflowId}`,
		};
	}
	if ("kind" in resolved) {
		return { ok: false, reason: "not_registered", message: resolved.message };
	}
	if (!backend.isWorkflowLoadable(resolved.workflowId)) {
		return {
			ok: false,
			reason: "not_registered",
			message: `Workflow ${resolved.workflowId} has no valid journal state.`,
		};
	}
	// Revalidate ownership before claiming the run.
	const handle = backend.getWorkflow(resolved.workflowId);
	if (handle === undefined) {
		return {
			ok: false,
			reason: "stale",
			message: `Workflow ${resolved.workflowId} has no checkpoint state; re-run the workflow to start fresh.`,
		};
	}

	if (handle.status === "running") {
		if (hasActiveLiveRun(deps.baseRunOpts.store, resolved.workflowId)) {
			return alreadyRunningResult(handle.name, resolved.workflowId, deps.baseRunOpts.store);
		}
		if (backend.workflowOwnership(handle.workflowId) === "foreign") {
			return foreignRunningResult(handle.name, resolved.workflowId);
		}
	}
	if (!isDurableWorkflowResumable(handle)) {
		return {
			ok: false,
			reason: "not_resumable",
			message: `Workflow ${resolved.workflowId} is ${handle.status}, not resumable.`,
		};
	}
	const requestedOwner = deps.baseRunOpts.modelOwner;
	const adopting =
		requestedOwner !== undefined &&
		requestedOwner !== handle.modelOwner &&
		(handle.modelOwner !== undefined || handle.origin === "agent");
	if (adopting && !isSdkRunAdoptable(handle, deps.baseRunOpts.cwd, backend)) {
		return { ok: false, reason: "owned_elsewhere", message: foreignInstanceMessage(backend, resolved.workflowId) };
	}

	if (crossProject) {
		if (deps.confirmCrossProjectFork === undefined)
			return {
				ok: false,
				reason: "different_project",
				message: crossProjectResumeMessage(workflowId, initial.invocationCwd!),
			};
		if (!(await deps.confirmCrossProjectFork(initial.invocationCwd!)))
			return {
				ok: false,
				reason: "different_project",
				message: "Workflow resume cancelled; the source run was not changed.",
			};
	}

	const def = crossProject
		? (deps.registry.get(handle.name) ?? (await deps.resolveDefinition?.(handle.name, handle.invocationCwd)))
		: handle.invocationCwd === undefined
			? deps.registry.get(handle.name)
			: ((await deps.resolveDefinition?.(handle.name, handle.invocationCwd)) ?? deps.registry.get(handle.name));
	if (def === undefined) {
		return { ok: false, reason: "workflow_not_found", message: `Workflow definition not found: ${handle.name}` };
	}
	if (!isWorkflowDefinition(def)) {
		return {
			ok: false,
			reason: "workflow_not_found",
			message: workflowDefinitionRequirementMessage("resumeDurableWorkflow", def),
		};
	}

	const inputs: Record<string, unknown> = { ...handle.inputs };
	try {
		resolveAndValidateInputs(def.inputs, inputs as WorkflowInputValues, `workflow "${def.name}"`);
	} catch (err) {
		return {
			ok: false,
			reason: "invalid_inputs",
			message: `invalid_inputs: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (crossProject) {
		deps.signal?.throwIfAborted();
		const forkId = await forkDurableWorkflow(backend, handle, currentCwd!, deps.forkModelOwner ?? requestedOwner);
		const fork = backend.getWorkflow(forkId)!;
		const result = await resumeDurableWorkflow(
			forkId,
			{
				...deps,
				confirmCrossProjectFork: undefined,
				resolveDefinition: async () => def,
				onBeforeResume:
					deps.onBeforeResume === undefined
						? undefined
						: (runId) => deps.onBeforeResume!(runId, handle.workflowId),
			},
			[resumableEntryFromHandle(fork)],
		);
		return result.ok
			? { ...result, message: `Forked workflow ${workflowId} into the current directory. ${result.message}` }
			: result;
	}
	let toolContinuation: RunOpts["continuation"] = deps.baseRunOpts.continuation;
	if (
		handle.status === "failed" &&
		(handle.failedToolNodeId !== undefined ||
			/^atomic-workflows: ctx\.tool .* aborted by node abort$/s.test(handle.error ?? ""))
	) {
		const source = durableWorkflowRunSnapshots(backend, handle).find((run) => run.id === handle.workflowId);
		const frontier = source === undefined ? undefined : resolveToolResumeFrontier(source, backend);
		if (frontier?.ok !== true)
			return {
				ok: false,
				reason: "startup_failed",
				message: frontier?.message ?? `insufficient_state: missing tool frontier in run ${handle.workflowId}`,
			};
		toolContinuation = {
			source: source!,
			resumeFromToolNodeId: frontier.toolNodeId,
			retryToolNodes: frontier.retryToolNodes,
		};
	}
	deps.signal?.throwIfAborted();
	const sourceFailure = {
		error: handle.error,
		exited: handle.exited,
		exitReason: handle.exitReason,
		failureKind: handle.failureKind,
		failureCode: handle.failureCode,
		failureRecoverability: handle.failureRecoverability,
		failureDisposition: handle.failureDisposition,
		failedToolNodeId: handle.failedToolNodeId,
	};
	const sourceSnapshot =
		toolContinuation?.source ?? deps.baseRunOpts.store?.runs().find((run) => run.id === resolved.workflowId);
	let adoptedClaimUpdatedAt: number | undefined;
	const rollbackStartup = async (onRestored?: () => void): Promise<boolean> => {
		if (adopting) {
			const current = backend.getWorkflow(resolved.workflowId);
			if (adoptedClaimUpdatedAt === undefined || current?.modelOwner !== requestedOwner) return false;
			const restored = await backend.transitionWorkflowStatus(
				resolved.workflowId,
				["running"],
				handle.status,
				handle.pendingPrompts,
				handle.resumable,
				adoptedClaimUpdatedAt,
			);
			if (restored) onRestored?.();
			return restored;
		}
		backend.setWorkflowStatus(
			resolved.workflowId,
			handle.status,
			handle.pendingPrompts,
			handle.resumable,
			sourceFailure,
		);
		onRestored?.();
		return true;
	};

	await deps.onBeforeResume?.(resolved.workflowId);

	// Claim resume against concurrent deletion through the required transition seam.
	let claimed: boolean;
	try {
		deps.signal?.throwIfAborted();
		let unsettled = unsettledResumeClaims.get(backend);
		if (unsettled === undefined) {
			unsettled = new Set();
			unsettledResumeClaims.set(backend, unsettled);
		}
		unsettled.add(resolved.workflowId);
		try {
			claimed = await backend.transitionWorkflowStatus(
				resolved.workflowId,
				[handle.status],
				"running",
				undefined,
				undefined,
				resolved.updatedAt,
				adopting ? requestedOwner : undefined,
			);
			if (claimed && adopting) adoptedClaimUpdatedAt = backend.getWorkflow(resolved.workflowId)?.updatedAt;
			if (claimed && !adopting && deps.signal?.aborted) await rollbackStartup();
			deps.signal?.throwIfAborted();
		} finally {
			unsettled.delete(resolved.workflowId);
		}
	} catch (error) {
		if (deps.signal?.aborted) throw deps.signal.reason ?? error;
		return {
			ok: false,
			reason: "startup_failed",
			message: `Failed to resume durable workflow ${resolved.workflowId}: ${error instanceof Error ? error.message : String(error)} No executor was launched; inspect the retained instance before retrying.`,
		};
	}
	if (!claimed) {
		return {
			ok: false,
			reason: "stale",
			message: `Workflow ${resolved.workflowId} changed while resume was pending; refresh the workflow list and try again.`,
		};
	}

	const resumeRunOpts: RunOpts = {
		...deps.baseRunOpts,
		...(handle.invocationCwd !== undefined ? { cwd: handle.invocationCwd } : {}),
		...(handle.origin !== undefined ? { origin: handle.origin } : {}),
		modelOwner: adopting ? requestedOwner : handle.modelOwner,
		runId: resolved.workflowId,
		durableBackend: backend,
		...(toolContinuation === undefined ? {} : { continuation: toolContinuation }),
	};

	let launch: ReturnType<typeof launchDetachedUntilStartup>;
	try {
		launch = launchDetachedUntilStartup(def, inputs, {
			...resumeRunOpts,
			startupSignal: deps.signal,
			...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}),
			onRawSettled: async (_ok, result, error) => {
				const message = result?.error ?? (error instanceof Error ? error.message : String(error));
				if (
					toolContinuation !== undefined &&
					(message.includes("insufficient_state: replay topology mismatch") ||
						message.includes("insufficient_state: replay topology ambiguous"))
				) {
					const current = deps.baseRunOpts.store?.runs().find((run) => run.id === resolved.workflowId);
					// Do not undo a concurrent terminal control decision.
					if (current?.status === "failed" && current.error === message) {
						backend.setWorkflowStatus(
							resolved.workflowId,
							handle.status,
							handle.pendingPrompts,
							handle.resumable,
							sourceFailure,
						);
						if (
							deps.baseRunOpts.store?.runs().find((run) => run.id === resolved.workflowId) === current &&
							current.status === "failed" &&
							current.error === message
						) {
							deps.baseRunOpts.store.recordRunStart({ ...toolContinuation.source, error: message });
						}
					}
				}
			},
		});
	} catch (error) {
		await rollbackStartup(() => {
			if (sourceSnapshot !== undefined) deps.baseRunOpts.store?.recordRunStart(sourceSnapshot);
		});
		return {
			ok: false,
			reason: "startup_failed",
			message: `Failed to resume durable workflow ${resolved.workflowId}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const { accepted } = launch;
	deps.onRunAccepted?.(accepted.runId);
	const admission = await launch.wait;
	if (!admission.started) {
		const snapshot = deps.baseRunOpts.store?.runs().find((run) => run.id === accepted.runId);
		const error = workflowStartupFailureMessage(
			admission,
			snapshot?.error,
			`Workflow ${resolved.workflowId} ended before startup admission`,
		);
		if (!adopting && sourceSnapshot === undefined) deps.baseRunOpts.store?.removeRun(accepted.runId);
		await rollbackStartup(() => {
			if (adopting && sourceSnapshot === undefined) deps.baseRunOpts.store?.removeRun(accepted.runId);
			if (sourceSnapshot !== undefined) deps.baseRunOpts.store?.recordRunStart(sourceSnapshot);
		});
		return {
			ok: false,
			reason: "startup_failed",
			message: `Failed to resume durable workflow ${resolved.workflowId}: ${error}`,
		};
	}

	return {
		ok: true,
		runId: accepted.runId,
		workflowId: resolved.workflowId,
		name: handle.name,
		message: `Resuming durable workflow "${handle.name}" (${resolved.workflowId}) — completed checkpoints will be replayed.`,
	};
}

function foreignRunningResult(name: string, workflowId: string): ResumeDurableResult {
	return {
		ok: false,
		reason: "owned_elsewhere",
		message:
			`Workflow "${name}" (${workflowId}) is actively running in another Atomic session. ` +
			"Control it from that session; it becomes resumable here only after that session pauses, quits, or crashes.",
	};
}

function alreadyRunningResult(name: string, workflowId: string, store: RunOpts["store"]): ResumeDurableResult {
	const here = store?.runs().some((r) => r.id === workflowId && r.endedAt === undefined) === true;
	return {
		ok: false,
		reason: "not_resumable",
		message: `Workflow "${name}" (${workflowId}) is already running${
			here ? " in this session" : " in another session"
		}. See agents working and chat with or steer each stage using \`/workflow connect ${workflowId}\`; use \`/workflow quit ${workflowId}\` to pause the run for later resume.`,
	};
}

/**
 * True when the live run store has an actively-executing (not ended, not quit)
 * run for `workflowId`. This is the only reliable signal that a durable
 * `running` handle is genuinely live in THIS process — distinguishing a real
 * double-resume from cross-session crash recovery.
 */
function hasActiveLiveRun(store: RunOpts["store"] | undefined, workflowId: string): boolean {
	if (store === undefined) return false;
	return store.runs().some((r) => r.id === workflowId && r.endedAt === undefined && r.exitReason !== "quit");
}

/** Remove local snapshots that do not exist in the journal. */
export function purgeSuppressedWorkflowRuns(
	backend: DurableWorkflowBackend,
	store: RunOpts["store"],
): readonly string[] {
	if (store === undefined) return [];
	const removed: string[] = [];
	for (const run of store.runs()) {
		if (backend.isWorkflowLoadable(run.id)) continue;
		if (store.removeRun(run.id)) removed.push(run.id);
	}
	return removed;
}

/** Refresh known workflow ids for resume discovery. */
export async function prepareTargetedDurableResumable(
	backend: DurableWorkflowBackend,
	workflowIds: readonly string[],
): Promise<readonly ResumableWorkflowEntry[]> {
	const entries: ResumableWorkflowEntry[] = [];
	const seen = new Set<string>();
	for (const workflowId of workflowIds) {
		if (seen.has(workflowId)) continue;
		seen.add(workflowId);
		await backend.hydrateWorkflow(workflowId);
		const handle = backend.getLoadableWorkflow(workflowId);
		if (
			handle === undefined ||
			!isDurableWorkflowResumable(handle) ||
			(handle.status === "running" && backend.workflowOwnership(workflowId) !== "available")
		)
			continue;
		entries.push(resumableEntryFromHandle(handle));
	}
	return entries;
}

export async function prepareRuntimeDurableResumable(
	getBackend: () => DurableWorkflowBackend,
	workflowId?: string,
): Promise<readonly ResumableWorkflowEntry[]> {
	const backend = getBackend();
	await backend.hydrateResumableWorkflows();
	if (workflowId !== undefined) {
		const resolved = resolveDurableEntry(workflowId, backend.listResumableWorkflows());
		if (resolved !== undefined && !("kind" in resolved)) await backend.hydrateWorkflow(resolved.workflowId);
	}
	return backend.listResumableWorkflows();
}
