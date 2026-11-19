import {
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	type RunSyncOptions,
} from "../../shared/types.js";
import { IntercomDetachReservations } from "./execution-detach-reservations.js";
import { type IntercomDetachRoute, matchesIntercomDetachRoute } from "./execution-detach-route.js";

interface ExecutionIntercomDetachState {
	readonly isUnavailable: () => boolean;
	readonly isDetached: () => boolean;
	readonly detach: () => void;
}

/**
 * Registers exact-owner and group detach listeners for one live child attempt. A child no task host runs blocks its
 * launching call, which a detach releases. A task-hosted child runs in the background, so nothing waits on it: its
 * acknowledgement only lets its busy parent take the message at once, as it does for its first one.
 */
export function registerExecutionIntercomDetach(
	options: RunSyncOptions,
	state: ExecutionIntercomDetachState,
): () => void {
	const reservations = new IntercomDetachReservations();
	let acknowledged = false;
	const unsubscribe = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
		if (!options.allowIntercomDetach || state.isUnavailable() || acknowledged) return;
		if (!payload || typeof payload !== "object") return;
		const event = payload as IntercomDetachRoute;
		if (
			typeof event.requestId !== "string" ||
			!matchesIntercomDetachRoute(event, {
				childIntercomTarget: options.intercomSessionName,
			})
		)
			return;
		if (event.phase === "probe") {
			if (state.isDetached() || !reservations.reserve(event)) return;
			options.intercomEvents?.emit?.(INTERCOM_DETACH_RESPONSE_EVENT, { ...event, accepted: true });
			return;
		}
		if (event.phase !== "commit" || state.isDetached() || !reservations.commit(event)) return;
		if (options.taskExecution) {
			acknowledged = true;
			options.onIntercomDetachCommit?.();
		} else {
			options.onIntercomDetachCommit?.();
			state.detach();
		}
		options.intercomEvents?.emit?.(INTERCOM_DETACH_RESPONSE_EVENT, { ...event, accepted: true });
	});
	// Only a child no task host runs gets a group detach signal: its siblings' launching call blocks on it too.
	const detachSibling = () => state.detach();
	options.intercomDetachSignal?.addEventListener("abort", detachSibling, { once: true });
	if (options.intercomDetachSignal?.aborted) detachSibling();

	return () => {
		reservations.clear();
		unsubscribe?.();
		options.intercomDetachSignal?.removeEventListener("abort", detachSibling);
	};
}
