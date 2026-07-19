import type {
  WorkflowLifecycleNotificationState,
  WorkflowLifecycleNoticeDetails,
} from "./lifecycle-notifications.js";

interface LifecycleNoticeDeliveryOptions {
  readonly state: WorkflowLifecycleNotificationState;
  readonly emit: (details: WorkflowLifecycleNoticeDetails) => boolean | Promise<boolean>;
  /** Whether this installation is configured to deliver the given notice kind. */
  readonly eligible: (details: WorkflowLifecycleNoticeDetails) => boolean;
}

/**
 * Owns terminal-notice admission with capped-backoff retry. Delivery state lives
 * on the shared notification state, so a pending admission started under one
 * configuration installation is not re-sent by a later reinstall: the shared
 * pending token remains authoritative until its original send settles. If that
 * send later fails, the failed payload is handed to whichever installation is
 * currently active through the shared retry-observer set, preserving exactly
 * once main-chat delivery across config reload and session-preserving reinstall.
 */
export function createLifecycleNoticeDelivery(options: LifecycleNoticeDeliveryOptions): {
  deliver(key: string, details: WorkflowLifecycleNoticeDetails): void;
  dispose(): void;
} {
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const attempts = new Map<string, number>();
  let active = true;

  const deliver = (key: string, details: WorkflowLifecycleNoticeDetails): void => {
    // A disposed installation never starts a new send; an active one refuses to
    // duplicate an already-delivered or still-pending admission.
    if (!active) return;
    if (options.state.deliveredTerminalRuns.has(key) || options.state.pendingTerminalRuns.has(key)) return;
    const token = Symbol(key);
    options.state.pendingTerminalRuns.set(key, token);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const settle = (delivered: boolean): void => {
      // Another installation may have superseded this pending admission.
      if (options.state.pendingTerminalRuns.get(key) !== token) return;
      options.state.pendingTerminalRuns.delete(key);
      if (delivered) {
        options.state.deliveredTerminalRuns.add(key);
        options.state.retryableTerminalRuns.delete(key);
        options.state.retryableTerminalNotices.delete(key);
        return;
      }
      options.state.retryableTerminalRuns.add(key);
      options.state.retryableTerminalNotices.set(key, details);
      if (active) {
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          if (active) deliver(key, details);
        }, Math.min(20 * (2 ** (attempt - 1)), 1_000));
        retryTimers.add(timer);
        return;
      }
      // This installation was disposed while its admission was in flight; hand
      // the failed payload to a currently-active installation, if any.
      for (const observer of options.state.retryObservers) observer(key, details);
    };
    const result = options.emit(details);
    if (typeof result === "boolean") settle(result);
    else void result.then(settle);
  };

  const retryObserver = (key: string, details: WorkflowLifecycleNoticeDetails): void => {
    if (active && options.eligible(details)) deliver(key, details);
  };
  options.state.retryObservers.add(retryObserver);

  return {
    deliver,
    dispose() {
      active = false;
      options.state.retryObservers.delete(retryObserver);
      for (const timer of retryTimers) clearTimeout(timer);
      // Do not clear pending tokens or mark them retryable: an in-flight
      // admission remains authoritative and settles into the shared state.
    },
  };
}
