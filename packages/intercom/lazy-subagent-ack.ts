import type { ExtensionAPI } from "@bastani/atomic";

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
  pi.events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId,
    delivered: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
