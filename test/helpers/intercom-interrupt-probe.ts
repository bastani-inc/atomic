import type { FauxResponseFactory, FauxResponseStep } from "@bastani/atomic-ai/compat";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";

/**
 * A priority interrupt aborts the receiver's native run. The faux provider still
 * consumes one queued step for that aborted dispatch, so probes script only the
 * valid (non-aborted) responses and count cancelled dispatches separately.
 */
export function createDispatchCounter(valid: FauxResponseFactory[]) {
	const counts = { valid: 0, aborted: 0 };
	const queue = [...valid];
	const factory: FauxResponseStep = (context, options, state, model) => {
		if (options?.signal?.aborted) {
			counts.aborted += 1;
			return fauxAssistantMessage("cancelled dispatch");
		}
		counts.valid += 1;
		const next = queue.shift();
		if (!next) throw new Error(`No valid faux response scripted for dispatch ${counts.valid}`);
		return next(context, options, state, model);
	};
	return { counts, steps: (slots: number) => Array.from({ length: slots }, () => factory) };
}
