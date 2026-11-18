import { type DurableWorkflowBackend, readDurableCheckpoints } from "../durable/backend.js";
import { durableWorkflowRunSnapshots } from "../durable/completed-catalog.js";
import { blockAttemptKey } from "../durable/restored-block.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
import { bindRunDurableBackend } from "../durable/run-owner-backend.js";
import { normalizeSessionEntries, type SessionEntry } from "../shared/persistence-restore.js";
import { findRunBlockedMetadata } from "../shared/persistence-restore-helpers.js";
import type { Store } from "../shared/store.js";
import type { RunSnapshot } from "../shared/store-types.js";

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
	const keep = new Set<string>();
	const snapshots: RunSnapshot[] = [];
	for (const id of ids) {
		if (!current()) return;
		const existing = store.run(id);
		if (existing && !existing.restored) continue;
		const block = findRunBlockedMetadata(records.get(id) ?? [], id);
		if (catalog !== undefined) {
			const candidate = backend.getWorkflow(id);
			if (candidate?.modelOwner !== owner || (!block && !["blocked", "failed", "paused"].includes(candidate.status)))
				continue;
		}
		await backend.hydrateWorkflow(id);
		let handle = backend.getLoadableWorkflow(id);
		if (handle?.modelOwner !== owner || (!block && !["blocked", "failed", "paused"].includes(handle.status)))
			continue;
		const checkpoints = await readDurableCheckpoints(backend, id);
		handle = backend.getLoadableWorkflow(id);
		if (handle?.modelOwner !== owner) continue;
		const unfinishedBlock =
			handle.status === "running" &&
			handle.resumable !== false &&
			block !== undefined &&
			(block.blockAttempt ?? "0:") === blockAttemptKey(backend, id);
		if (handle.status === "running" && !unfinishedBlock) continue;
		const graph = durableWorkflowRunSnapshots(backend, handle, checkpoints);
		for (const run of graph) {
			const root = run.id === id;
			const blocked = root && (unfinishedBlock || handle.status === "blocked");
			const { ts: blockedAt, ...details } = block ?? {};
			const snapshot: RunSnapshot = {
				...run,
				modelOwner: owner,
				origin: handle.origin,
				restored: true,
				...(blocked ? { ...details, status: "blocked", blockedAt: blockedAt ?? handle.updatedAt } : {}),
				...(root
					? {
							resumable: unfinishedBlock || isDurableWorkflowResumable(handle),
							exited: handle.exited,
							exitReason: handle.exitReason,
						}
					: {}),
			};
			if (root) bindRunDurableBackend(snapshot, backend);
			keep.add(run.id);
			snapshots.push(snapshot);
		}
	}
	if (!current()) return;
	store.batch(() => {
		for (const run of [...store.runs()])
			if (
				run.restored &&
				!keep.has(run.id) &&
				(knownIds === undefined || knownIds.includes(run.rootRunId ?? run.id))
			)
				store.removeRun(run.id);
		const missing = snapshots.filter((run) => !store.run(run.id) || store.run(run.id)?.restored);
		beforeRestore?.(missing);
		for (const run of missing) store.recordRunStart(run);
	});
}
