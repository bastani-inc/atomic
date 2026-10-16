/** Equality is still live; takeover requires a renewal strictly older than the window. */
export function isWorkflowLeaseExpired(renewedAt: number, staleAfterMs: number, now = Date.now()): boolean {
	return now - renewedAt > staleAfterMs;
}
