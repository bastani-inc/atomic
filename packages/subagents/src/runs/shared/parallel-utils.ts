import { isParentCancellation } from "./cancellation-recovery.js";

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(_workerIndex: number): Promise<void> {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)));
	return results;
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	status: import("../../shared/types.js").SubagentAttemptStatus;
	error?: string;
	cause?: string;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) => `=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.status === "skipped"
					? "SKIPPED"
					: r.status === "continued"
						? "CONTINUED"
						: r.status === "error"
							? `FAILED${r.error ? `: ${r.error}` : ""}`
							: r.status === "interrupted" && isParentCancellation(r.cause)
								? "CANCELLED"
								: r.error
									? `WARNING: ${r.error}`
									: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
										? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
										: !hasOutput && !r.outputTargetPath
											? "EMPTY OUTPUT (no textual response returned)"
											: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

export function formatParallelResultContent(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string,
): string {
	const ok = results.filter((result) => result.status === "ok").length;
	return `${ok}/${results.length} succeeded\n\n${aggregateParallelOutputs(results, headerFormat)}`;
}

export const MAX_PARALLEL_CONCURRENCY = 4;
