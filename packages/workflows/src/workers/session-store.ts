import { randomUUID } from "node:crypto";
import type { SessionStore } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { PoolMutation } from "../durable/journal/pool-mutations.js";
import { durableStageCheckpointMetadata } from "../durable/stage-topology.js";
import type { DurableStageCheckpoint } from "../durable/types.js";
import { durableRunTopology } from "../engine/run-durable-topology.js";
import type { Store } from "../shared/store.js";

export function workerSessionStore(input: {
	readonly reader: SessionStore;
	readonly backend: DurableWorkflowBackend;
	readonly store: Store;
	readonly root: string;
	readonly commit: (mutation: PoolMutation) => Promise<{ readonly lastSeq?: number }>;
}): SessionStore {
	const checkpoint = async (
		id: string,
		header?: Parameters<SessionStore["create"]>[0],
	): Promise<DurableStageCheckpoint> => {
		const owner = (header ?? (await input.reader.readHeader(id)))?.workflow;
		const run = input.store.runs().find((run) => run.id === owner?.runId);
		const stage = run?.stages.find((stage) => stage.id === owner?.stageId);
		if (!run || !stage?.replayKey) throw new Error("Pool session has no active stage");
		const boundary = input.backend
			.listCheckpoints(input.root)
			.find((entry) => entry.kind === "stage" && entry.topology?.boundary?.child.runId === run.id);
		if (boundary?.kind !== "stage" || !boundary.topology?.boundary)
			throw new Error("Pool session has no owning boundary");
		const prefix = boundary.topology.boundary.replayScope;
		return {
			...durableStageCheckpointMetadata(stage, durableRunTopology(run), run.stages.indexOf(stage)),
			kind: "stage",
			workflowId: input.root,
			checkpointId: `${prefix}:session:${id}:${randomUUID()}`,
			replayKey: `${prefix}:${stage.replayKey}`,
			name: stage.name,
			sessionId: id,
			completedAt: Date.now(),
		};
	};
	const write = async (mutation: PoolMutation) => {
		const receipt = await input.commit(mutation);
		if (receipt.lastSeq === undefined) throw new Error("Missing pool session receipt");
		return { lastSeq: receipt.lastSeq };
	};
	return {
		descriptor: input.reader.descriptor,
		create: async (header, entries) =>
			write({ kind: "session-create", checkpoint: await checkpoint(header.id, header), header, entries }),
		append: async (id, entries, options) =>
			write({ kind: "session-append", checkpoint: await checkpoint(id), entries, expectSeq: options.expectSeq }),
		replace: async (id, header, entries, options) =>
			write({
				kind: "session-replace",
				checkpoint: await checkpoint(id, header),
				header,
				entries,
				expectSeq: options.expectSeq,
			}),
		load: (id) => input.reader.load(id),
		readHeader: (id) => input.reader.readHeader(id),
		list: (query) => input.reader.list(query),
		findMostRecent: (query) => input.reader.findMostRecent(query),
		delete: async () => {
			throw new Error("Worker cannot delete sessions");
		},
		close: async () => {},
	};
}
