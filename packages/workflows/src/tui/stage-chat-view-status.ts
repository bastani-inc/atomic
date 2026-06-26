const TERMINAL_OR_NON_STREAMING_STAGE_CHAT_STATUSES = new Set<string>([
  "success",
  "complete",
  "completed",
  "failure",
  "failed",
  "error",
  "cancellation",
  "cancelled",
  "canceled",
  "paused",
  "detached",
  "killed",
  "stopped",
  "no-longer-running",
  "skipped",
  "blocked",
]);

export function isTerminalOrNonStreamingStageChatStatus(
  status: string | undefined,
): boolean {
  return status !== undefined && TERMINAL_OR_NON_STREAMING_STAGE_CHAT_STATUSES.has(status);
}

export function isTerminalStageChatTransition(
  previousStatus: string | undefined,
  currentStatus: string | undefined,
): boolean {
  return !isTerminalOrNonStreamingStageChatStatus(previousStatus) &&
    isTerminalOrNonStreamingStageChatStatus(currentStatus);
}

export function isTerminalStageChatState(status: string | undefined): boolean {
  return isTerminalOrNonStreamingStageChatStatus(status);
}
