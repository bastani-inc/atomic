import { isWorkflowRunResumable, type WorkflowRunResumeCandidate } from "../durable/resume-eligibility.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { createRunIndicatorStatusResolver } from "../shared/run-indicator-status.js";
import { sortRunsByStatus } from "../shared/run-order.js";
import { isTopLevelWorkflowRun } from "../shared/run-visibility.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { workflowRunResumeCandidate } from "../shared/workflow-artifacts.js";

export interface PickerRow {
	readonly run: RunSnapshot;
	readonly bucket: "active" | "terminal";
}

export type ResumeCandidateProbe = (
	run: RunSnapshot,
	sessionRuns: readonly RunSnapshot[],
) => WorkflowRunResumeCandidate;
export type ResumeCandidateLookup = (run: RunSnapshot) => WorkflowRunResumeCandidate;

const RECENT_WINDOW_MS = 60 * 60 * 1000;

export function selectRunsForPicker(
	runs: readonly RunSnapshot[],
	query: string,
	includeAll: boolean,
	now: number = Date.now(),
	intent: "connect" | "resume" | "pause" = "connect",
	resumeCandidateLookup?: ResumeCandidateLookup,
): PickerRow[] {
	const q = query.trim().toLowerCase();
	const matches = (r: RunSnapshot): boolean => {
		if (!q) return true;
		return r.name.toLowerCase().includes(q) || r.id.startsWith(q);
	};

	const rows: PickerRow[] = [];
	for (const r of runs) {
		if (!isTopLevelWorkflowRun(r)) continue;
		if (!matches(r)) continue;
		if (intent === "resume") {
			const candidate = resumeCandidateLookup?.(r) ?? workflowRunResumeCandidate(runCandidate(r), runs, undefined);
			if (!isWorkflowRunResumable(candidate)) continue;
		}
		const endedAt = r.endedAt;
		if (endedAt === undefined) {
			rows.push({ run: r, bucket: "active" });
			continue;
		}

		if (includeAll || now - endedAt <= RECENT_WINDOW_MS) {
			rows.push({ run: r, bucket: "terminal" });
		}
	}
	return sortRunsByStatus(rows, (row) => row.run, createRunIndicatorStatusResolver(runs, effectiveRunStatus));
}

function runCandidate(run: RunSnapshot): RunSnapshot {
	return run;
}
