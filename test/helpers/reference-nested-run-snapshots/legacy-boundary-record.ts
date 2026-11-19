import type { DurableCheckpoint } from "../../../packages/workflows/src/durable/types.js";

/** A journal written before failed and skipped boundaries recorded whether their child started. */
export function legacyBoundaryRecord(record: DurableCheckpoint): DurableCheckpoint {
	if (record.kind !== "stage" || record.topology?.boundary?.event !== "terminal") return record;
	const { startedChildStatus: _started, ...boundary } = record.topology.boundary;
	return { ...record, topology: { ...record.topology, boundary } };
}
