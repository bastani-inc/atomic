/**
 * Session-scoped notification fired right as a provider request reaches the
 * `before-provider-request` dispatch boundary (after deferred startup, hooks,
 * OAuth refresh, model discovery, and lazy API loading have completed).
 */
const listenersBySession = new WeakMap<object, Set<() => void>>();

/** Subscribes to provider-request dispatch notifications for `session`; returns an unsubscribe function. */
export function onSessionProviderRequestDispatched(session: object, listener: () => void): () => void {
	let listeners = listenersBySession.get(session);
	if (!listeners) {
		listeners = new Set();
		listenersBySession.set(session, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && listenersBySession.get(session) === listeners) {
			listenersBySession.delete(session);
		}
	};
}

/** Notifies listeners registered for `session` that a provider request has reached dispatch. */
export function notifySessionProviderRequestDispatched(session: object | undefined): void {
	if (!session) return;
	const listeners = listenersBySession.get(session);
	if (!listeners || listeners.size === 0) return;
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// Best-effort notification; never interrupt provider request dispatch.
		}
	}
}
