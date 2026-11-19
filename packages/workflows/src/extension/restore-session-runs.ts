import { type DurableWorkflowBackend, readDurableCheckpoints } from "../durable/backend.js";
import { durableWorkflowRunSnapshots } from "../durable/completed-catalog.js";
import { uncommittedBlockKind } from "../durable/restored-block.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
import { bindRunDurableBackend } from "../durable/run-owner-backend.js";
import type { DurableWorkflowHandle } from "../durable/types.js";
import { normalizeSessionEntries, type SessionEntry } from "../shared/persistence-restore.js";
import { findRunBlockedMetadata } from "../shared/persistence-restore-helpers.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";

const RESTING_STATUSES: readonly string[] = ["blocked", "failed", "paused"];

/** Reopen the session's saved graphs without admitting an executor or writing to the journal. */
export async function restoreSessionRuns(
	backend: DurableWorkflowBackend,
	store: Store,
	owner: string,
	entries: readonly SessionEntry[],
	current: () => boolean,
	beforeRestore?: (runs: readonly RunSnapshot[]) => void,
	knownIds?: readonly string[],
): Promise<void> {
	const records = Map.groupBy(
		normalizeSessionEntries(entries).filter((entry) => entry.type.startsWith("workflow.run.")),
		(entry) => entry.payload.runId,
	);
	const catalog = knownIds === undefined ? await backend.prepareWorkflowCatalog() : undefined;
	const ids =
		knownIds ??
		catalog?.inspectableIds ??
		[...(catalog?.resumable ?? []), ...(catalog?.completed ?? [])].map((row) => row.workflowId);
	const restored: { readonly handle: DurableWorkflowHandle; readonly runs: readonly RunSnapshot[] }[] = [];
	for (const id of ids) {
		if (!current()) return;
		const existing = store.run(id);
		if (existing && !existing.restored) continue;
		const recorded = findRunBlockedMetadata(records.get(id) ?? [], id);
		if (catalog !== undefined) {
			const candidate = backend.getWorkflow(id);
			if (candidate?.modelOwner !== owner || (!recorded && !RESTING_STATUSES.includes(candidate.status))) continue;
		}
		await backend.hydrateWorkflow(id);
		let handle = backend.getLoadableWorkflow(id);
		if (handle?.modelOwner !== owner || (!recorded && !RESTING_STATUSES.includes(handle.status))) continue;
		const checkpoints = await readDurableCheckpoints(backend, id);
		handle = backend.getLoadableWorkflow(id);
		if (handle?.modelOwner !== owner) continue;
		// A session block from an earlier occurrence than the journal's latest pause or block is not this run's state.
		const block = recorded && (recorded.runGeneration ?? 0) >= (handle.runGeneration ?? 0) ? recorded : undefined;
		const uncommitted = uncommittedBlockKind(backend, handle, block);
		if (uncommitted === undefined && !RESTING_STATUSES.includes(handle.status)) continue;
		const graph = durableWorkflowRunSnapshots(backend, handle, checkpoints);
		const runs: RunSnapshot[] = [];
		for (const run of graph) {
			const root = run.id === id;
			const blocked = root && (uncommitted !== undefined || handle.status === "blocked");
			const { ts: blockedAt, ...details } = block ?? {};
			const snapshot: RunSnapshot = {
				...run,
				modelOwner: owner,
				origin: handle.origin,
				restored: "journal",
				...(blocked ? { ...details, status: "blocked", blockedAt: blockedAt ?? handle.updatedAt } : {}),
				...(root && uncommitted === "earlier" ? { earlierBlockVersion: handle.updatedAt } : {}),
				...(root
					? {
							resumable: uncommitted === "current" || isDurableWorkflowResumable(handle),
							exited: handle.exited,
							exitReason: handle.exitReason,
						}
					: {}),
			};
			if (root) bindRunDurableBackend(snapshot, backend);
			runs.push(snapshot);
		}
		restored.push({ handle, runs });
	}
	if (!current()) return;
	// Another writer can end, claim or adopt a run while later runs are read: publish only what the journal still says.
	const published = restored
		.filter(({ handle }) => {
			const latest = backend.getLoadableWorkflow(handle.workflowId);
			return (
				latest?.modelOwner === owner && latest.status === handle.status && latest.updatedAt === handle.updatedAt
			);
		})
		.flatMap(({ runs }) => runs);
	const keep = new Set(published.map((run) => run.id));
	store.batch(() => {
		for (const run of [...store.runs()])
			if (
				run.restored &&
				!keep.has(run.id) &&
				(knownIds === undefined || knownIds.includes(run.rootRunId ?? run.id))
			)
				store.removeRun(run.id);
		const missing = published.filter((run) => !store.run(run.id) || store.run(run.id)?.restored);
		beforeRestore?.(missing);
		for (const run of missing) store.recordRunStart(run);
	});
}
