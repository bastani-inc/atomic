import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";

/** Expire only the crashed fixture run, using the journal's authoritative clock. */
export function expireWorkflowLease(path: string, runId: string): void {
	const database = new DatabaseSync(path);
	try {
		const result = database
			.prepare(
				"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? - 1 WHERE run_id = ?",
			)
			.run(FOREIGN_LIVE_WORKFLOW_WINDOW_MS, runId);
		assert.equal(Number(result.changes), 1, "fixture run must have a retained lease");
	} finally {
		database.close();
	}
}
