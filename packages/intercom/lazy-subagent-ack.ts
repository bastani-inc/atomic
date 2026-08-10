import { isStaleExtensionContextError, type ExtensionAPI } from "@bastani/atomic";

const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

export function rejectLazyResultRelay(
  pi: ExtensionAPI,
  eventName: string,
  payload: unknown,
  error: unknown,
): void {
  if (eventName !== SUBAGENT_RESULT_INTERCOM_EVENT || !payload || typeof payload !== "object") return;
  const requestId = (payload as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string") return;
  try {
    pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
      requestId,
      delivered: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (emitError) {
    if (!isStaleExtensionContextError(emitError)) throw emitError;
    // The failed relay can race extension invalidation; no acknowledgement is possible.
  }
}
