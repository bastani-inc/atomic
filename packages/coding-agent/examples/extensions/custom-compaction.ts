/**
 * Custom Compaction Deletion Policy Extension
 *
 * Verbatim Compaction is deletion-only: extensions cannot replace history with a
 * generated summary. This example shows how to provide an exact deletion request
 * before Atomic's internal planner runs. Atomic still validates the requested
 * entry IDs locally before appending a context_compaction entry.
 *
 * This policy deletes older, unprotected, successful bash execution entries once
 * they are large enough to matter. If no safe candidates are present, it returns
 * nothing and Atomic uses its default deletion planner.
 *
 * Usage:
 *   atomic --extension examples/extensions/custom-compaction.ts
 */

import type { ContextDeletionRequest, ExtensionAPI } from "@bastani/atomic";

const MIN_BASH_OUTPUT_TOKENS = 250;
const MAX_DELETIONS_PER_RUN = 12;

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, reason, mode } = event;
		const candidates = preparation.transcript.entries
			.filter((entry) => !entry.protected)
			.filter((entry) => entry.message.role === "bashExecution" && entry.message.exitCode === 0)
			.filter((entry) => entry.tokenEstimate >= MIN_BASH_OUTPUT_TOKENS)
			.slice(0, MAX_DELETIONS_PER_RUN);

		if (candidates.length === 0) {
			if (ctx.hasUI) {
				ctx.ui.notify("Custom compaction policy found no safe bash output to delete; using default planner", "info");
			}
			return;
		}

		const deletions: ContextDeletionRequest["deletions"] = candidates.map((entry) => ({
			kind: "entry",
			entryId: entry.entryId,
			rationale: "Large successful bash output selected by custom compaction policy",
		}));

		if (ctx.hasUI) {
			const tokenEstimate = candidates.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
			ctx.ui.notify(
				`Custom compaction (${reason ?? "manual"}/${mode}): requesting ${deletions.length} deletion(s), about ${tokenEstimate.toLocaleString()} tokens`,
				"info",
			);
		}

		return {
			deletionRequest: { deletions },
		};
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!ctx.hasUI || !event.fromExtension) return;
		ctx.ui.notify(
			`Custom compaction policy deleted ${event.result.stats.objectsDeleted} object(s)`,
			"info",
		);
	});
}
