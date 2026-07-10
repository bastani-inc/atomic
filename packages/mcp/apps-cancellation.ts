import type { UiSessionRuntime } from "./ui-session.js";
import { logger } from "./logger.js";

function formatCancellationReason(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : String(reason);
}

export async function notifyUiCancellation(
  uiSession: UiSessionRuntime | null,
  reason: string,
): Promise<void> {
  if (!uiSession) return;
  try {
    await uiSession.sendToolCancelled(reason);
  } catch (error) {
    logger.error(
      "Failed to notify MCP App about tool cancellation",
      error instanceof Error ? error : new Error(String(error)),
      { server: uiSession.serverName, tool: uiSession.toolName },
    );
  }
}

export async function rethrowHostAbortAfterUiCancellation(
  signal: AbortSignal | undefined,
  uiSession: UiSessionRuntime | null,
): Promise<void> {
  if (!signal?.aborted) return;
  await notifyUiCancellation(uiSession, formatCancellationReason(signal));
  signal.throwIfAborted();
}
