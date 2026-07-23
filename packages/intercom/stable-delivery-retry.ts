export interface StableDeliveryRetryOptions {
  deliver: () => Promise<void>;
  isCurrent: () => boolean;
  schedule?: (retry: () => void) => void;
}

/** Retries one stable-key delivery until it succeeds or its session generation retires. */
export function retryStableDelivery(options: StableDeliveryRetryOptions): Promise<void> {
  const schedule = options.schedule ?? ((retry) => { setTimeout(retry, 100); });
  return new Promise((resolve, reject) => {
    let retirementRetryUsed = false;
    let attempted = false;
    const attempt = (): void => {
      if (!options.isCurrent() && (!attempted || retirementRetryUsed)) {
        reject(new Error("Stable delivery owner retired before delivery succeeded"));
        return;
      }
      if (!options.isCurrent()) retirementRetryUsed = true;
      attempted = true;
      const failed = (error: unknown): void => {
        if (options.isCurrent() || !retirementRetryUsed) schedule(attempt);
        else reject(error);
      };
      try {
        void Promise.resolve(options.deliver()).then(resolve, failed);
      } catch (error) {
        failed(error);
      }
    };
    attempt();
  });
}
