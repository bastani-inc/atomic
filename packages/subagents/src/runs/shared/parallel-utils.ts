import { isParentCancellation } from "./cancellation-recovery.js";

export type ExecutionTicket = ((dispatch: () => Promise<void>) => void) & {
	readonly limit?: number;
	readonly scheduler: ExecutionScheduler;
	readonly admitted: Promise<void>;
	readonly onObserved: () => void;
	readonly onEntered: () => void;
	readonly release: () => void;
};

/** Dispatches at most `limit` at a time, in order; `limit` lets a child record its run's limit as plain data (#4856). */
export type ExecutionScheduler = ((dispatch: () => Promise<void>) => void) & {
	readonly limit?: number;
	readonly reserve?: () => ExecutionTicket;
};

export function isExecutionTicket(
	schedule: ((dispatch: () => Promise<void>) => void) | undefined,
): schedule is ExecutionTicket {
	return typeof schedule === "function" && "admitted" in schedule && "release" in schedule && "scheduler" in schedule;
}

interface SchedulerEntry {
	state: "reserved" | "ready" | "released" | "dispatched";
	observed: boolean;
	entered: boolean;
	dispatch?: () => Promise<void>;
	resolveAdmission: () => void;
}

/** A slot belongs to the dispatch lifetime, not its caller's observation. */
export function createExecutionScheduler(limit: number): ExecutionScheduler {
	let active = 0;
	const queued: SchedulerEntry[] = [];
	const unsettledAdmissions = new Set<Promise<void>>();

	const pump = (): void => {
		while (queued.length > 0 && queued[0]!.state === "released") {
			queued.shift();
		}
		while (active < limit && queued.length > 0) {
			const head = queued[0]!;
			if (head.state === "released") {
				queued.shift();
				continue;
			}
			if (head.state === "reserved") {
				break;
			}
			queued.shift();
			head.state = "dispatched";
			if (head.entered) head.resolveAdmission();
			const dispatch = head.dispatch!;
			head.dispatch = undefined;
			active++;
			const releaseSlot = () => {
				active--;
				pump();
			};
			void dispatch().then(releaseSlot, releaseSlot);
		}
		for (const entry of queued) {
			if (entry.state === "reserved") break;
			if (entry.state === "ready" && entry.observed) {
				entry.resolveAdmission();
			}
		}
	};

	const schedule = (dispatch: () => Promise<void>): void => {
		queued.push({
			state: "ready",
			observed: true,
			entered: true,
			dispatch,
			resolveAdmission: () => {},
		});
		pump();
	};

	const reserve = (): ExecutionTicket => {
		const ownAdmission = Promise.withResolvers<void>();
		let admissionSettled = false;
		const resolveAdmission = (): void => {
			if (admissionSettled) return;
			admissionSettled = true;
			unsettledAdmissions.delete(ownAdmission.promise);
			ownAdmission.resolve();
		};
		unsettledAdmissions.add(ownAdmission.promise);
		const snapshot = [...unsettledAdmissions];
		const admitted = Promise.all(snapshot).then(() => undefined);

		const entry: SchedulerEntry = {
			state: "reserved",
			observed: false,
			entered: false,
			resolveAdmission,
		};
		queued.push(entry);

		const onObserved = (): void => {
			if (entry.observed) return;
			entry.observed = true;
			if (entry.state === "released" || (entry.state === "dispatched" && entry.entered)) {
				entry.resolveAdmission();
				return;
			}
			pump();
		};
		const onEntered = (): void => {
			if (entry.entered) return;
			entry.entered = true;
			if (entry.state === "dispatched" || entry.state === "released") {
				entry.resolveAdmission();
			}
		};
		const release = (): void => {
			if (entry.state === "reserved") {
				entry.state = "released";
				entry.resolveAdmission();
				pump();
				return;
			}
			if (entry.state === "ready") {
				onObserved();
				return;
			}
			onEntered();
		};
		const ticket = (dispatch: () => Promise<void>): void => {
			if (entry.state === "reserved") {
				entry.state = "ready";
				entry.dispatch = dispatch;
				pump();
				return;
			}
			schedule(dispatch);
		};
		return Object.assign(ticket, {
			limit,
			scheduler,
			admitted,
			onObserved,
			onEntered,
			release,
		});
	};

	const scheduler: ExecutionScheduler = Object.assign(schedule, { limit, reserve });
	return scheduler;
}

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
