import type { AsyncParallelGroupStatus, Details, WorkflowNodeStatus } from "../shared/types.ts";
import { formatAgentRunningLabel } from "../shared/status-format.ts";

export function parseParallelGroupAgentCount(label: string | undefined): number | undefined {
	if (!label || !label.startsWith("[") || !label.endsWith("]")) return undefined;
	const inner = label.slice(1, -1).trim();
	if (!inner) return 0;
	return inner.split("+").map((part) => part.trim()).filter(Boolean).length;
}

export interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
	status?: WorkflowNodeStatus;
	label?: string;
	error?: string;
}

export function buildChainStepSpans(details: Pick<Details, "chainAgents" | "workflowGraph">): ChainStepSpan[] {
	if (details.workflowGraph?.nodes?.length) {
		const spans: ChainStepSpan[] = [];
		let flatCursor = 0;
		for (const node of details.workflowGraph.nodes) {
			if (node.stepIndex === undefined) continue;
			if (node.kind === "parallel-group" || node.kind === "dynamic-parallel-group") {
				const childFlatIndexes = (node.children ?? [])
					.map((child) => child.flatIndex)
					.filter((value): value is number => typeof value === "number");
				const start = childFlatIndexes.length ? Math.min(...childFlatIndexes) : flatCursor;
				const count = node.children?.length ?? 0;
				spans.push({ stepIndex: node.stepIndex, start, count, isParallel: true, status: node.status, label: node.label, error: node.error });
				flatCursor = Math.max(flatCursor, start + count);
				continue;
			}
			const start = node.flatIndex ?? flatCursor;
			spans.push({ stepIndex: node.stepIndex, start, count: 1, isParallel: false, status: node.status, label: node.label, error: node.error });
			flatCursor = Math.max(flatCursor, start + 1);
		}
		if (spans.length) return spans.sort((left, right) => left.stepIndex - right.stepIndex);
	}

	if (!details.chainAgents?.length) return [];
	const spans: ChainStepSpan[] = [];
	let start = 0;
	for (let stepIndex = 0; stepIndex < details.chainAgents.length; stepIndex++) {
		const label = details.chainAgents[stepIndex]!;
		const parsedCount = parseParallelGroupAgentCount(label);
		const count = parsedCount ?? 1;
		spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
		start += count;
	}
	return spans;
}

export function isChainParallelGroupActive(details: Pick<Details, "mode" | "chainAgents" | "currentStepIndex" | "workflowGraph">): boolean {
	if (details.mode !== "chain") return false;
	if (details.currentStepIndex === undefined) return false;
	return buildChainStepSpans(details).some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
}

export function buildAsyncChainStepSpans(total: number, stepCount: number, parallelGroups: AsyncParallelGroupStatus[] = []): ChainStepSpan[] {
	const spans: ChainStepSpan[] = [];
	let flatIndex = 0;
	for (let stepIndex = 0; stepIndex < total; stepIndex++) {
		const group = parallelGroups.find((candidate) => candidate.stepIndex === stepIndex);
		if (group) {
			spans.push({ stepIndex, start: group.start, count: group.count, isParallel: true });
			flatIndex = Math.max(flatIndex, group.start + group.count);
			continue;
		}
		spans.push({ stepIndex, start: flatIndex, count: flatIndex < stepCount ? 1 : 0, isParallel: false });
		flatIndex++;
	}
	return spans;
}

export function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted || result.detached) return false;
	return result.exitCode === 0;
}

export function workflowGraphHasStatus(details: Pick<Details, "workflowGraph">, statuses: WorkflowNodeStatus[]): boolean {
	return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}

export interface ChainRenderResultEntry {
	kind: "result";
	resultIndex: number;
	rowNumber: number;
	agentName: string;
}

export interface ChainRenderPlaceholderEntry {
	kind: "placeholder";
	rowNumber: number;
	stepLabel: string;
	agentName: string;
	status: WorkflowNodeStatus;
	error?: string;
}

export type ChainRenderEntry = ChainRenderResultEntry | ChainRenderPlaceholderEntry;

export function buildChainRenderEntries(details: Details, label: MultiProgressLabel): ChainRenderEntry[] | undefined {
	if (details.mode !== "chain" || !label.hasParallelInChain || label.showActiveGroupOnly) return undefined;
	const entries: ChainRenderEntry[] = [];
	for (const span of buildChainStepSpans(details)) {
		if (span.isParallel && span.count === 0) {
			entries.push({
				kind: "placeholder",
				rowNumber: span.stepIndex + 1,
				stepLabel: `Step ${span.stepIndex + 1}`,
				agentName: span.label ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
				status: span.status ?? "pending",
				error: span.error,
			});
			continue;
		}
		for (let index = span.start; index < span.start + span.count; index++) {
			entries.push({
				kind: "result",
				resultIndex: index,
				rowNumber: index + 1,
				agentName: details.results[index]?.agent ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
			});
		}
	}
	return entries;
}

export interface MultiProgressLabel {
	headerLabel: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	hasParallelInChain: boolean;
	activeParallelGroup: boolean;
	groupStartIndex: number;
	groupEndIndex: number;
	showActiveGroupOnly: boolean;
}

export function buildMultiProgressLabel(details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents" | "workflowGraph">, hasRunning: boolean): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = isChainParallelGroupActive(details);
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<"pending" | "running" | "completed" | "failed" | "detached">;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray = details.progress?.find((progress) => progress.index === i)
				|| details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			const status = result.progress?.status
				?? (result.interrupted || result.detached
					? "detached"
					: result.exitCode === 0
						? "completed"
						: "failed");
			statuses[index] = status;
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const headerLabel = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: `${done}/${totalCount} done`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: totalCount, showActiveGroupOnly: false };
	}

	if (activeParallelGroup) {
		const currentStepIndex = details.currentStepIndex!;
		const span = stepSpans[currentStepIndex];
		const groupSize = span?.count ?? 1;
		const groupStart = span?.start ?? 0;
		const groupEnd = groupStart + groupSize;
		let running = 0;
		let done = 0;
		for (let index = groupStart; index < groupEnd; index++) {
			const progressEntry = details.progress?.find((progress) => progress.index === index);
			const resultEntry = details.results.find((result) => result.progress?.index === index);
			if (progressEntry?.status === "running") {
				running++;
				continue;
			}
			if (progressEntry?.status === "completed") {
				done++;
				continue;
			}
			if (resultEntry && isDoneResult(resultEntry)) done++;
		}
		const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
		const headerLabel = hasRunning
			? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
			: `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
		return { headerLabel, itemTitle, totalCount: groupSize, hasParallelInChain, activeParallelGroup, groupStartIndex: groupStart, groupEndIndex: groupEnd, showActiveGroupOnly: true };
	}

	if (details.mode === "chain" && details.chainAgents?.length) {
		const totalCount = details.totalSteps ?? details.chainAgents.length;
		const doneLogical = stepSpans.filter((span) => {
			if (span.status && span.status !== "completed") return false;
			if (span.count === 0) return span.status === "completed";
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (progressEntry?.status === "running" || progressEntry?.status === "pending" || progressEntry?.status === "failed") return false;
				if (!resultEntry || !isDoneResult(resultEntry)) return false;
			}
			return true;
		}).length;
		const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
		const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${doneLogical}/${totalCount}`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
	}

	const totalCount = details.totalSteps ?? details.results.length;
	const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
	const done = details.results.filter(isDoneResult).length;
	const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
}

export function resultRowLabel(details: Pick<Details, "mode" | "chainAgents" | "workflowGraph">, label: MultiProgressLabel, resultIndex: number, stepNumber: number): string {
	if (details.mode === "chain" && label.hasParallelInChain) {
		const span = buildChainStepSpans(details).find((candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count);
		if (span?.isParallel) return `Agent ${resultIndex - span.start + 1}/${span.count}`;
		if (span) return `Step ${span.stepIndex + 1}`;
	}
	if (label.itemTitle === "Agent") {
		const localStepNumber = label.activeParallelGroup
			? Math.max(1, stepNumber - label.groupStartIndex)
			: stepNumber;
		return `Agent ${localStepNumber}/${label.totalCount}`;
	}
	return `Step ${stepNumber}`;
}
