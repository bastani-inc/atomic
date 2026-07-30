/**
 * Stable marker for "the transport never accepted this frame".
 *
 * A submission that failed on the wire is still the user's text, so the host
 * puts it back in the editor. Deciding that from error messages cannot work:
 * the writer forwards whatever the stream callback produced — `write EPIPE`,
 * `Cannot call write after a stream was destroyed`, `ERR_STREAM_WRITE_AFTER_END`
 * — and Node documents `error.message` as free to change in any release. The
 * transport boundary already knows the answer, so it says so here.
 *
 * The marker is additive on purpose. Native errors keep their identity, their
 * `instanceof`, and their `code`/`errno`/`syscall` fields, because `RpcClient`
 * rejections are public and callers already inspect them.
 */

const RPC_TRANSPORT_FAILURE = "rpcFailureKind";

export interface RpcTransportFailure extends Error {
	readonly rpcFailureKind: "transport";
}

export function isRpcTransportFailure(error: unknown): error is RpcTransportFailure {
	return error instanceof Error
		&& (error as { rpcFailureKind?: unknown }).rpcFailureKind === "transport";
}

/**
 * Mark a failure as a transport failure, preserving the original error.
 *
 * Idempotent, so every boundary on the way out can call it. A value that is not
 * an extensible `Error` — a frozen error, a thrown string — is wrapped, with the
 * original kept as `cause` and a string `code` copied across so callers that
 * branch on `code` still work.
 */
export function markRpcTransportFailure(error: unknown): RpcTransportFailure {
	if (isRpcTransportFailure(error)) return error;
	if (error instanceof Error && Object.isExtensible(error)) {
		Object.defineProperty(error, RPC_TRANSPORT_FAILURE, {
			value: "transport",
			enumerable: false,
			configurable: true,
			writable: false,
		});
		return error as RpcTransportFailure;
	}
	const message = error instanceof Error ? error.message : String(error);
	const wrapper = new Error(message, { cause: error });
	const code = (error as { code?: unknown } | undefined)?.code;
	if (typeof code === "string") Object.assign(wrapper, { code });
	return markRpcTransportFailure(wrapper);
}

/** Build an already-classified transport failure. */
export function rpcTransportError(message: string): RpcTransportFailure {
	return markRpcTransportFailure(new Error(message));
}
