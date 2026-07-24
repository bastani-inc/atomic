import type { StageSessionRuntime } from "./stage-runner-types.js";

export interface StageSessionPauseResumeResult {
  readonly releasedQueuedMessages: boolean;
  /** True when a runner-admitted public delivery owns the first resumed turn. */
  readonly runnerOwnedDeliveryPending: boolean;
}

interface PauseResumeResolution extends StageSessionPauseResumeResult {
  readonly message?: string;
  /** Lets the interrupted objective settle only after accepted public turns. */
  readonly runnerOwnedDeliverySettlement: Promise<void>;
}

interface NativeQueuePauseControl {
  readonly queuedMessagesPaused?: boolean;
  pauseQueuedMessages(): void;
  resumeQueuedMessages(): boolean | Promise<boolean>;
}

function nativeQueuePauseControl(session: StageSessionRuntime | undefined): NativeQueuePauseControl | undefined {
  if (
    typeof session?.pauseQueuedMessages !== "function"
    || typeof session.resumeQueuedMessages !== "function"
  ) return undefined;
  return session as StageSessionRuntime & NativeQueuePauseControl;
}

interface PauseRequest {
  readonly deferred: PromiseWithResolvers<PauseResumeResolution>;
  readonly abortBoundary: PromiseWithResolvers<void>;
  readonly runnerOwnedDeliveries: Set<Promise<void>>;
  readonly nativeQueuePause?: NativeQueuePauseControl;
  resumePromise?: Promise<StageSessionPauseResumeResult>;
}

type PauseRejection = Error | DOMException | string;

/** Serializes controlled pause, abort settlement, and one explicit resume. */
export class StageSessionPause {
  private request: PauseRequest | null = null;

  constructor(private readonly getSession: () => StageSessionRuntime | undefined) {}

  currentResume(): Promise<PauseResumeResolution> | undefined {
    return this.request?.deferred.promise;
  }

  isPaused(): boolean {
    return this.request !== null;
  }

  async requestPause(): Promise<void> {
    if (this.request) return this.request.abortBoundary.promise;
    const session = this.getSession();
    const nativeQueuePause = nativeQueuePauseControl(session);
    const request: PauseRequest = {
      deferred: Promise.withResolvers<PauseResumeResolution>(),
      abortBoundary: Promise.withResolvers<void>(),
      runnerOwnedDeliveries: new Set(),
      ...(nativeQueuePause === undefined ? {} : { nativeQueuePause }),
    };
    void request.deferred.promise.catch(() => {});
    void request.abortBoundary.promise.catch(() => {});
    this.request = request;
    let failed = false;
    try {
      request.nativeQueuePause?.pauseQueuedMessages();
      await session?.abort();
      request.abortBoundary.resolve();
      await request.abortBoundary.promise;
    } catch (error) {
      failed = true;
      request.abortBoundary.reject(error);
      request.deferred.reject(error);
      await this.rollbackNativePause(request.nativeQueuePause);
      throw error;
    } finally {
      if (failed && this.request === request) this.request = null;
    }
  }

  private async rollbackNativePause(control: NativeQueuePauseControl | undefined): Promise<void> {
    if (control === undefined) return;
    try {
      await control.resumeQueuedMessages();
    } catch {
      // AgentSession keeps a failed abort boundary closed until one release
      // attempt observes it. Retry only when its public gate is still paused.
      if (control.queuedMessagesPaused !== true) return;
      try { await control.resumeQueuedMessages(); } catch { /* Preserve the pause/abort error. */ }
    }
  }

  /**
   * Capture a public delivery accepted while this pause generation owns the
   * stage. It starts only after resume and stays visible to the interrupted
   * objective, so readiness continuation cannot race it.
   */
  deferRunnerOwnedDelivery<T>(operation: () => Promise<T>): Promise<T> | undefined {
    const request = this.request;
    if (!request) return undefined;
    const delivery = request.deferred.promise.then(operation);
    const settlement = delivery.then(() => undefined, () => undefined);
    request.runnerOwnedDeliveries.add(settlement);
    void settlement.finally(() => request.runnerOwnedDeliveries.delete(settlement));
    return delivery;
  }

  resume(
    message?: string,
    beforeResolve?: (result: StageSessionPauseResumeResult) => void,
  ): Promise<StageSessionPauseResumeResult> {
    const request = this.request;
    if (!request) return Promise.resolve({ releasedQueuedMessages: false, runnerOwnedDeliveryPending: false });
    if (request.resumePromise) return request.resumePromise;
    request.resumePromise = this.completeResume(request, message, beforeResolve);
    return request.resumePromise;
  }

  reject(reason: PauseRejection): void {
    const request = this.request;
    if (!request) return;
    this.request = null;
    request.abortBoundary.reject(reason);
    request.deferred.reject(reason);
  }

  private async completeResume(
    request: PauseRequest,
    message: string | undefined,
    beforeResolve: ((result: StageSessionPauseResumeResult) => void) | undefined,
  ): Promise<StageSessionPauseResumeResult> {
    try {
      await request.abortBoundary.promise;
    } catch (error) {
      request.deferred.reject(error);
      if (this.request === request) this.request = null;
      throw error;
    }

    let releasedQueuedMessages: boolean;
    try {
      releasedQueuedMessages = await request.nativeQueuePause?.resumeQueuedMessages() ?? false;
    } catch (error) {
      // Native release can fail transiently. Preserve this pause generation and
      // its waiter/deliveries; only retire the failed attempt so explicit resume
      // can retry the same native hold.
      if (this.request === request) request.resumePromise = undefined;
      throw error;
    }

    try {
      const runnerOwnedDeliveries = [...request.runnerOwnedDeliveries];
      const runnerOwnedDeliverySettlement = Promise.all(runnerOwnedDeliveries).then(() => undefined);
      const result = {
        releasedQueuedMessages,
        runnerOwnedDeliveryPending: runnerOwnedDeliveries.length > 0,
      };
      beforeResolve?.(result);
      request.deferred.resolve({
        ...result,
        runnerOwnedDeliverySettlement,
        ...(message === undefined ? {} : { message }),
      });
      if (this.request === request) this.request = null;
      return result;
    } catch (error) {
      request.deferred.reject(error);
      if (this.request === request) this.request = null;
      throw error;
    }
  }
}
