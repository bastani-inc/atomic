export interface AdmittedToolFailure {
	readonly admissionOrder: number;
	readonly error: unknown;
	readonly nodeId?: string;
}

export type AdmittedToolExecutionAdmission =
	| { readonly accepted: true; bindNode(nodeId: string): void; noteCancelled(): void }
	| { readonly accepted: false; readonly error: Error; bindNode(nodeId: string): void; noteCancelled(): void };

export interface AdmittedToolExecutionTracker {
	track<T>(execution: Promise<T>): AdmittedToolExecutionAdmission;
	observeFailure(error: unknown, nodeId: string): void;
	closeAndDrain(): Promise<void>;
	abandonNonFailed(): readonly string[];
	firstFailure(): AdmittedToolFailure | undefined;
	uniqueFailureFor(error: unknown): AdmittedToolFailure | undefined;
}

export interface AdmittedToolExecutionTrackerOptions {
	/** Cancellation closes admission immediately, even while an ancestor drains. */
	readonly signal?: AbortSignal;
	readonly onFailureObserved?: (failure: AdmittedToolFailure) => void;
	readonly onFailureDuringDrain?: (failure: AdmittedToolFailure) => void;
}

/** Tracks each logical ctx.tool promise without changing the promise returned to authors. */
export function createAdmittedToolExecutionTracker(
	options: AdmittedToolExecutionTrackerOptions = {},
): AdmittedToolExecutionTracker {
	const inFlight = new Set<Promise<void>>();
	const admissions: Array<{
		readonly admissionOrder: number;
		nodeId?: string;
		failure?: AdmittedToolFailure;
		cancelled: boolean;
		settled: boolean;
		observed?: Promise<void>;
	}> = [];
	const failures: AdmittedToolFailure[] = [];
	const cancellations: AdmittedToolFailure[] = [];
	let nextAdmissionOrder = 0;
	let state: "OPEN" | "DRAINING" | "CLOSED" = "OPEN";
	let closing: Promise<void> | undefined;
	const abandonment = Promise.withResolvers<void>();
	let abandoned = false;
	let drainFailureReported = false;

	const recordFailure = (admission: (typeof admissions)[number], error: unknown, nodeId?: string): void => {
		if (admission.failure !== undefined) return;
		const failure = { admissionOrder: admission.admissionOrder, error, ...(nodeId === undefined ? {} : { nodeId }) };
		admission.failure = failure;
		failures.push(failure);
		options.onFailureObserved?.(failure);
	};

	const reportDrainFailure = (): void => {
		const failure = failures[0];
		if (state !== "DRAINING" || failure === undefined || drainFailureReported) return;
		drainFailureReported = true;
		options.onFailureDuringDrain?.(failure);
	};

	const drainRecordedFailures = (): Promise<unknown[]> =>
		Promise.all(
			admissions.flatMap((admission) =>
				admission.failure !== undefined && admission.observed !== undefined ? [admission.observed] : [],
			),
		);

	const closeAtFixedPoint = async (): Promise<void> => {
		while (!abandoned) {
			const current = [...inFlight];
			if (current.length > 0) {
				const drained = await Promise.race([
					Promise.all(current).then(() => true),
					abandonment.promise.then(() => false),
				]);
				if (!drained) break;
			}
			// Let author settlement continuations admit follow-up tools before the
			// fixed-point check. The tracker observer is attached before return.
			await Promise.resolve();
			if (inFlight.size === 0) {
				state = "CLOSED";
				return;
			}
		}
		await drainRecordedFailures();
	};

	return {
		track<T>(execution: Promise<T>): AdmittedToolExecutionAdmission {
			if (state === "CLOSED" || options.signal?.aborted) {
				const error = new Error("atomic-workflows: ctx.tool admission is closed for this run");
				void execution.catch(() => undefined);
				return { accepted: false, error, bindNode(): void {}, noteCancelled(): void {} };
			}
			const admission: (typeof admissions)[number] = {
				admissionOrder: ++nextAdmissionOrder,
				nodeId: undefined,
				failure: undefined,
				cancelled: false,
				settled: false,
			};
			admissions.push(admission);
			const observed = execution.then(
				() => undefined,
				(error: unknown) => {
					// Retain rejection identity for an uncaught outer failure, but do not
					// select a run failure or abort siblings when authors catch cancellation.
					if (admission.cancelled) {
						cancellations.push({ admissionOrder: admission.admissionOrder, error, nodeId: admission.nodeId });
						return;
					}
					recordFailure(admission, error, admission.nodeId);
					reportDrainFailure();
				},
			);
			admission.observed = observed;
			inFlight.add(observed);
			void observed.then(() => {
				admission.settled = true;
				inFlight.delete(observed);
			});
			return {
				accepted: true,
				bindNode(id: string): void {
					admission.nodeId = id;
				},
				noteCancelled(): void {
					admission.cancelled = true;
				},
			};
		},
		observeFailure(error: unknown, nodeId: string): void {
			const admission = admissions.find((candidate) => candidate.nodeId === nodeId);
			if (admission !== undefined) {
				recordFailure(admission, error, nodeId);
				reportDrainFailure();
			}
		},
		closeAndDrain(): Promise<void> {
			if (closing !== undefined) return closing;
			state = "DRAINING";
			reportDrainFailure();
			closing = closeAtFixedPoint();
			return closing;
		},
		abandonNonFailed(): readonly string[] {
			if (!abandoned) {
				abandoned = true;
				state = "CLOSED";
				abandonment.resolve();
			}
			return admissions.flatMap((admission) =>
				!admission.settled && admission.failure === undefined && admission.nodeId !== undefined
					? [admission.nodeId]
					: [],
			);
		},
		firstFailure(): AdmittedToolFailure | undefined {
			return failures[0];
		},
		uniqueFailureFor(error: unknown): AdmittedToolFailure | undefined {
			const matching = [...failures, ...cancellations].filter((failure) => Object.is(failure.error, error));
			return matching.length === 1 ? matching[0] : undefined;
		},
	};
}
