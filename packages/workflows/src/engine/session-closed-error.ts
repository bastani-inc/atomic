import { isStaleExtensionContextError } from "@bastani/atomic";

const MAX_CAUSE_DEPTH = 8;

function reportsClosedSession(error: Error): boolean {
	return ("code" in error && error.code === "SessionClosed") || isStaleExtensionContextError(error);
}

/**
 * True when an error, or anything in its cause chain, reports that the host
 * session that owns the run was closed (`SessionClosed`, or an extension
 * context that went stale on disposal). Depth-bounded so a self-referential
 * cause cannot spin, and every property read is guarded so a throwing accessor
 * on a foreign error never escapes into run finalization.
 */
export function isSessionClosedError(error: Error): boolean {
	let current: Error | undefined = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth++) {
		try {
			if (reportsClosedSession(current)) return true;
			current = current.cause instanceof Error ? current.cause : undefined;
		} catch {
			return false;
		}
	}
	return false;
}
