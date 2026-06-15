import type { AcceptanceLedger, AcceptanceLedgerStatus, ActivityState, AsyncJobStep } from "./types.ts";

type StepStatusLike = Pick<AsyncJobStep, "status">;

function formatActivityAge(ms: number): string {
	if (ms < 1000) return "now";
	if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
	return `${Math.floor(ms / 60000)}m`;
}

export function formatActivityLabel(lastActivityAt: number | undefined, activityState?: ActivityState, now = Date.now()): string | undefined {
	if (lastActivityAt === undefined) {
		if (activityState === "needs_attention") return "needs attention";
		if (activityState === "active_long_running") return "active but long-running";
		return undefined;
	}
	const age = formatActivityAge(Math.max(0, now - lastActivityAt));
	if (activityState === "needs_attention") return `no activity for ${age}`;
	if (activityState === "active_long_running") return `active but long-running · last activity ${age} ago`;
	return age === "now" ? "active now" : `active ${age} ago`;
}

function isCompletedStepStatus(status: AsyncJobStep["status"]): boolean {
	return status === "complete" || status === "completed";
}

export function aggregateStepStatus(steps: StepStatusLike[]): AsyncJobStep["status"] {
	if (steps.some((step) => step.status === "running")) return "running";
	if (steps.some((step) => step.status === "failed")) return "failed";
	if (steps.some((step) => step.status === "paused")) return "paused";
	if (steps.length > 0 && steps.every((step) => isCompletedStepStatus(step.status))) return "complete";
	return "pending";
}

export function formatAgentRunningLabel(count: number): string {
	return count === 1 ? "1 agent running" : `${count} agents running`;
}

export function formatAcceptanceStatusForDisplay(status: AcceptanceLedgerStatus | undefined): string | undefined {
	if (!status || status === "not-required") return undefined;
	if (status === "rejected") return "acceptance gate rejected after completion";
	return `acceptance: ${status}`;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function formatReviewFindingDetail(finding: NonNullable<AcceptanceLedger["reviewResult"]>["findings"][number] | undefined): string | undefined {
	if (!finding?.issue.trim()) return undefined;
	const location = finding.file ? `${finding.file}: ` : "";
	const rationale = finding.rationale.trim() ? ` (${finding.rationale.trim()})` : "";
	return oneLine(`${location}${finding.issue.trim()}${rationale}`);
}

function firstAcceptanceRejectedReason(ledger: AcceptanceLedger): string | undefined {
	const failedCheck = ledger.runtimeChecks.find((check) => check.status === "failed");
	if (failedCheck?.message) return oneLine(failedCheck.message);
	const failedVerify = ledger.verifyRuns.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `verification '${failedVerify.id}' ${failedVerify.status}`;
	if (ledger.reviewResult?.status === "needs-parent-decision") {
		const finding = formatReviewFindingDetail(ledger.reviewResult.findings.find((item) => item.issue.trim().length > 0));
		return `acceptance review is required and no automatic reviewer result is available${finding ? `: ${finding}` : ""}`;
	}
	if (ledger.reviewResult?.status === "blockers") {
		const blocker = ledger.reviewResult.findings.find((finding) => finding.severity === "blocker" && finding.issue.trim().length > 0)
			?? ledger.reviewResult.findings.find((finding) => finding.issue.trim().length > 0);
		const detail = formatReviewFindingDetail(blocker);
		return detail ? `acceptance review found blockers: ${detail}` : "acceptance review found blockers";
	}
	if (ledger.childReportParseError) return oneLine(ledger.childReportParseError);
	return undefined;
}

export function formatAcceptanceLedgerForDisplay(ledger: AcceptanceLedger | undefined): string | undefined {
	const statusText = formatAcceptanceStatusForDisplay(ledger?.status);
	if (!statusText || ledger?.status !== "rejected") return statusText;
	const reason = firstAcceptanceRejectedReason(ledger);
	return reason ? `${statusText}: ${reason}` : statusText;
}

export function formatParallelOutcome(steps: StepStatusLike[], total: number, options: { showRunning?: boolean } = {}): string {
	const running = steps.filter((step) => step.status === "running").length;
	const done = steps.filter((step) => isCompletedStepStatus(step.status)).length;
	const failed = steps.filter((step) => step.status === "failed").length;
	const paused = steps.filter((step) => step.status === "paused").length;
	const parts = [`${done}/${total} done`];
	if (options.showRunning !== false && running > 0) parts.unshift(formatAgentRunningLabel(running));
	if (failed > 0) parts.push(`${failed} failed`);
	if (paused > 0) parts.push(`${paused} paused`);
	return parts.join(" · ");
}
