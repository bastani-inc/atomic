import { causeChain } from "./error-cause-chain.js";
import { familyOf, type SerializedError, serializeError } from "./error-codec.js";

/**
 * The typed error a failed stage or run carries across a worker or child-workflow boundary as `failureDetail` (#4309,
 * #4378): the IPC codec's envelope of the first error of a known family in `error`'s cause chain, outermost first,
 * with its own causes below it. Undefined when the chain holds no error of a known family, as for a plain error or a
 * cancellation.
 */
export function typedFailureDetail(error: unknown): SerializedError | undefined {
	const typed = causeChain(error).find((link) => familyOf(link) !== undefined);
	return typed === undefined ? undefined : serializeError(typed);
}
