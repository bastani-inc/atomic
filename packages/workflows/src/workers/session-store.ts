import { randomUUID } from "node:crypto";
import type { SessionStore } from "@bastani/atomic/storage";
import { stampCheckpointAttempt } from "../durable/attempt-identity.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { PoolMutation } from "../durable/journal/pool-mutations.js";
import { durableStageCheckpointMetadata } from "../durable/stage-topology.js";
import type { DurableStageCheckpoint } from "../durable/types.js";
import { durableRunTopology } from "../engine/run-durable-topology.js";
import type { Store } from "../shared/store.js";

/**
 * The session store a pooled worker's stage sessions use: writes of entries go through `commit`, which the pool
 * validates against the worker's attempt, and reads and blobs go to `reader`, the pool's own session tables.
 *
 * A blob's bytes are written straight to `reader`, not through `commit`: a large tool output would otherwise travel
 * as JSON over the worker's IPC and be hashed and applied inside the coordinator's transaction. Bytes may come from
 * any attempt because nothing reads a blob that no entry references. The `atomic.tool-output` entry that does is
 * appended through `commit`, so a fenced attempt's blob stays an unreferenced row inside its own session.
 *
 * A host that ships its checkpoints keeps a write in its local journal and acknowledges it from there (#4768): the
 * pool's session tables hold it only once the host ships it. A read of a session with such a write first asks the pool
 * to ship what the attempt holds (`sync`), and so does a blob of a session whose create the pool may not have shipped
 * yet, which the tables refuse until the session exists in them.
 */
export function workerSessionStore(input: {
	readonly reader: SessionStore;
	readonly backend: DurableWorkflowBackend;
	readonly store: Store;
	readonly root: string;
	readonly commit: (mutation: PoolMutation) => Promise<{ readonly lastSeq?: number; readonly local?: true }>;
	/** Ships what the attempt wrote of `sessionId` (of any session, without one) and kept in the host's local journal. */
	readonly sync?: (sessionId?: string) => Promise<void>;
}): SessionStore {
	/** Binds a created or replaced session to its stage; appends need no checkpoint. */
	const checkpoint = (id: string, header: Parameters<SessionStore["create"]>[0]): DurableStageCheckpoint => {
		const owner = header.workflow;
		const run = owner === undefined ? undefined : input.store.run(owner.runId);
		const stage = run?.stages.find((stage) => stage.id === owner?.stageId);
		if (!run || !stage?.replayKey) throw new Error("Pool session has no active stage");
		const boundary = input.backend
			.listCheckpoints(input.root)
			.find((entry) => entry.kind === "stage" && entry.topology?.boundary?.child.runId === run.id);
		if (boundary?.kind !== "stage" || !boundary.topology?.boundary)
			throw new Error("Pool session has no owning boundary");
		const prefix = boundary.topology.boundary.replayScope;
		// Its id is new, so it is stamped with the root's attempt as every other checkpoint the worker commits (#4874).
		return stampCheckpointAttempt<DurableStageCheckpoint>(
			{
				...durableStageCheckpointMetadata(stage, durableRunTopology(run), run.stages.indexOf(stage)),
				kind: "stage",
				workflowId: input.root,
				checkpointId: `${prefix}:session:${id}:${randomUUID()}`,
				replayKey: `${prefix}:${stage.replayKey}`,
				name: stage.name,
				sessionId: id,
				completedAt: Date.now(),
			},
			input.backend.workflowAttempt?.(input.root) ?? 0,
			undefined,
		);
	};
	/**
	 * The sessions with writes the pool acknowledged from its local journal since the last sync, each with a count of
	 * those writes, so a sync that overlaps a later write leaves that write's session marked.
	 */
	const unsynced = new Map<string, number>();
	/** Sessions the pool may not have created in its session tables yet: created locally and not synced since. */
	const unshippedCreates = new Set<string>();
	const sync = async (sessionId?: string) => {
		const sync = input.sync;
		if (sync === undefined) return;
		if (sessionId === undefined ? unsynced.size === 0 : !unsynced.has(sessionId)) return;
		const seen = new Map(sessionId === undefined ? unsynced : [[sessionId, unsynced.get(sessionId)!]]);
		await sync(sessionId);
		for (const [id, writes] of seen)
			if (unsynced.get(id) === writes) {
				unsynced.delete(id);
				unshippedCreates.delete(id);
			}
	};
	const write = async (id: string, mutation: PoolMutation) => {
		const receipt = await input.commit(mutation);
		if (receipt.lastSeq === undefined) throw new Error("Missing pool session receipt");
		if (receipt.local === true) {
			unsynced.set(id, (unsynced.get(id) ?? 0) + 1);
			if (mutation.kind === "session-create") unshippedCreates.add(id);
		}
		return { lastSeq: receipt.lastSeq };
	};
	/** Reads `id` once what the attempt wrote of it is in the pool's session tables. */
	const synced =
		<A extends unknown[], R>(read: (id: string, ...rest: A) => Promise<R>) =>
		async (id: string, ...rest: A): Promise<R> => {
			await sync(id);
			return read(id, ...rest);
		};
	return {
		descriptor: input.reader.descriptor,
		create: async (header, entries) =>
			write(header.id, { kind: "session-create", checkpoint: checkpoint(header.id, header), header, entries }),
		append: async (id, entries, options) =>
			write(id, { kind: "session-append", sessionId: id, entries, expectSeq: options.expectSeq }),
		replace: async (id, header, entries, options) =>
			write(id, {
				kind: "session-replace",
				checkpoint: checkpoint(id, header),
				header,
				entries,
				expectSeq: options.expectSeq,
			}),
		...(input.reader.putBlob !== undefined && input.reader.getBlob !== undefined
			? {
					// The session's tables refuse a blob of a session they do not hold yet.
					putBlob: async (id: string, data: Uint8Array) => {
						if (unshippedCreates.has(id)) await sync(id);
						return input.reader.putBlob!(id, data);
					},
					getBlob: (id: string, hash: string) => input.reader.getBlob!(id, hash),
				}
			: {}),
		load: synced((id) => input.reader.load(id)),
		...(input.reader.readEntryRange !== undefined
			? {
					readEntryRange: synced((id: string, query: Parameters<NonNullable<SessionStore["readEntryRange"]>>[1]) =>
						input.reader.readEntryRange!(id, query),
					),
				}
			: {}),
		...(input.reader.searchIndex !== undefined ? { searchIndex: input.reader.searchIndex } : {}),
		...(input.reader.readResume
			? { readResume: synced((id: string, leafId?: string) => input.reader.readResume!(id, leafId)) }
			: {}),
		...(input.reader.findEntrySeq
			? { findEntrySeq: synced((id: string, entryId: string) => input.reader.findEntrySeq!(id, entryId)) }
			: {}),
		...(input.reader.readTail !== undefined &&
		input.reader.readRange !== undefined &&
		input.reader.findLatestCompaction !== undefined
			? {
					readTail: synced((id: string, fromSeq: number) => input.reader.readTail!(id, fromSeq)),
					readRange: synced((id: string, startSeq: number, endSeq: number) =>
						input.reader.readRange!(id, startSeq, endSeq),
					),
					findLatestCompaction: synced((id: string, leafId?: string) =>
						input.reader.findLatestCompaction!(id, leafId),
					),
				}
			: {}),
		readHeader: synced((id) => input.reader.readHeader(id)),
		list: (query) =>
			(async function* () {
				await sync();
				yield* input.reader.list(query);
			})(),
		findMostRecent: async (query) => {
			await sync();
			return input.reader.findMostRecent(query);
		},
		delete: async () => {
			throw new Error("Worker cannot delete sessions");
		},
		close: async () => {},
	};
}
