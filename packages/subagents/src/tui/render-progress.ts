import { isParentCancellation } from "../runs/shared/cancellation-recovery.js";
import { formatAgentRunningLabel } from "../shared/status-format.js";
import type { Details } from "../shared/types.js";

export function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached || result.status !== "ok") return false;
	return true;
}

export interface MultiProgressLabel {
	headerLabel: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	groupStartIndex: number;
	groupEndIndex: number;
	showActiveGroupOnly: boolean;
}

export function buildMultiProgressLabel(
	details: Pick<Details, "mode" | "results" | "progress" | "totalSteps">,
	hasRunning: boolean,
): MultiProgressLabel {
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" ? "Agent" : "Step";
	const totalCount = details.totalSteps ?? details.results.length;

	if (details.mode === "parallel") {
		const statuses = new Array(totalCount).fill("pending") as Array<
			"pending" | "running" | "completed" | "failed" | "interrupted" | "detached"
		>;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray =
				details.progress?.find((progress) => progress.index === i) ||
				details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			const status =
				result.progress?.status ??
				(result.interrupted || result.status === "interrupted"
					? "interrupted"
					: result.detached || result.status === "continued"
						? "detached"
						: result.status === "ok"
							? "completed"
							: "failed");
			statuses[index] = status;
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const cancelled = details.results.filter(
			(result) => isParentCancellation(result.cause) && (result.interrupted || result.status === "interrupted"),
		).length;
		const headerLabel = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: cancelled > 0
				? `${done}/${totalCount} done · ${cancelled} cancelled`
				: `${done}/${totalCount} done`;
		return {
			headerLabel,
			itemTitle,
			totalCount,
			groupStartIndex: 0,
			groupEndIndex: totalCount,
			showActiveGroupOnly: false,
		};
	}

	const done = details.results.filter(isDoneResult).length;
	const currentStep = Math.min(totalCount, done + (hasRunning ? 1 : 0));
	const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return {
		headerLabel,
		itemTitle,
		totalCount,
		groupStartIndex: 0,
		groupEndIndex: details.results.length,
		showActiveGroupOnly: false,
	};
}

export function resultRowLabel(
	details: Pick<Details, "mode">,
	label: MultiProgressLabel,
	_resultIndex: number,
	stepNumber: number,
): string {
	if (label.itemTitle === "Agent") return `Agent ${stepNumber}/${label.totalCount}`;
	return details.mode === "parallel" ? `Agent ${stepNumber}` : `Step ${stepNumber}`;
}
