const WORKFLOW_STAGE_CLOSE_REASON = Symbol.for("@bastani/atomic/workflow-stage-close");

export type StageBoundOperationResult<T> =
	| { readonly status: "completed"; readonly value: T }
	| { readonly status: "stage-closed" };

/** Lets stage closure win only while the transport operation is still pending. */
export async function awaitOperationOrStageClose<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<StageBoundOperationResult<T>> {
	if (signal === undefined) return { status: "completed", value: await operation };
	if (signal.aborted) {
		return signal.reason === WORKFLOW_STAGE_CLOSE_REASON
			? { status: "stage-closed" }
			: { status: "completed", value: await operation };
	}

	let cancel: (() => void) | undefined;
	const stageClosed = new Promise<StageBoundOperationResult<T>>((resolve) => {
		cancel = () => {
			if (signal.reason === WORKFLOW_STAGE_CLOSE_REASON) resolve({ status: "stage-closed" });
		};
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([
			operation.then((value): StageBoundOperationResult<T> => ({ status: "completed", value })),
			stageClosed,
		]);
	} finally {
		if (cancel !== undefined) signal.removeEventListener("abort", cancel);
	}
}
