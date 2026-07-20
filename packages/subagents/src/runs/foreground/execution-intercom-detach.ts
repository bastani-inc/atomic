import {
  INTERCOM_DETACH_REQUEST_EVENT,
  INTERCOM_DETACH_RESPONSE_EVENT,
  type RunSyncOptions,
} from "../../shared/types.ts";
import { matchesIntercomDetachRoute, type IntercomDetachRoute } from "./execution-detach-route.ts";
import { IntercomDetachReservations } from "./execution-detach-reservations.ts";

interface ExecutionIntercomDetachState {
  readonly isUnavailable: () => boolean;
  readonly isDetached: () => boolean;
  readonly detach: () => void;
}

/** Registers exact-owner and foreground-group detach listeners for one live child attempt. */
export function registerExecutionIntercomDetach(
  options: RunSyncOptions,
  state: ExecutionIntercomDetachState,
): () => void {
  const reservations = new IntercomDetachReservations();
  const unsubscribe = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
    if (!options.allowIntercomDetach || state.isUnavailable()) return;
    if (!payload || typeof payload !== "object") return;
    const event = payload as IntercomDetachRoute;
    if (typeof event.requestId !== "string" || !matchesIntercomDetachRoute(event, {
      childIntercomTarget: options.intercomSessionName,
    })) return;
    if (event.phase === "probe") {
      if (state.isDetached() || !reservations.reserve(event)) return;
      options.intercomEvents?.emit?.(INTERCOM_DETACH_RESPONSE_EVENT, { ...event, accepted: true });
      return;
    }
    if (event.phase !== "commit" || state.isDetached() || !reservations.commit(event)) return;
    options.onIntercomDetachCommit?.();
    state.detach();
    options.intercomEvents?.emit?.(INTERCOM_DETACH_RESPONSE_EVENT, { ...event, accepted: true });
  });
  const detachSibling = () => state.detach();
  options.intercomDetachSignal?.addEventListener("abort", detachSibling, { once: true });
  if (options.intercomDetachSignal?.aborted) detachSibling();

  return () => {
    reservations.clear();
    unsubscribe?.();
    options.intercomDetachSignal?.removeEventListener("abort", detachSibling);
  };
}
