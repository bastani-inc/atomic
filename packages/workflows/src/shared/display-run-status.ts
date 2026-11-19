import { effectiveRunStatus } from "./returned-run-status.js";
import type { RunSnapshot, RunStatus } from "./store-types.js";

type BlockMarker = Pick<RunSnapshot, "blockedAt" | "endedAt" | "phase" | "resumable">;

/** A recorded block can stop live work without changing the execution status or its saved result. */
export function hasLiveBlockMarker(run: BlockMarker, marker: Pick<BlockMarker, "blockedAt"> = run): boolean {
	try {
		return (
			"blockedAt" in marker &&
			(!("endedAt" in run) || run.endedAt === undefined) &&
			(!("resumable" in run) || run.resumable !== false) &&
			(!("phase" in run) || run.phase !== "starting") &&
			marker.blockedAt !== undefined
		);
	} catch {
		// A partial view may declare the optional column without having loaded it.
		return false;
	}
}

/** Presentation only. Admission, notifications, and saved results use the execution status. */
export function displayRunStatus(run: RunSnapshot, marker: Pick<BlockMarker, "blockedAt"> = run): RunStatus {
	const status = effectiveRunStatus(run);
	return status === "running" && hasLiveBlockMarker(run, marker) ? "blocked" : status;
}
