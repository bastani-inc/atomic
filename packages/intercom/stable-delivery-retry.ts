export interface StableDeliveryRetryOptions {
  deliver: () => Promise<void>;
  isCurrent: () => boolean;
  schedule?: (retry: () => void) => void;
}

/** Retries one stable-key delivery until it succeeds or its session generation retires. */
export function retryStableDelivery(options: StableDeliveryRetryOptions): Promise<void> {
  const schedule = options.schedule ?? ((retry) => { setTimeout(retry, 100); });
  return new Promise((resolve) => {
    const attempt = (): void => {
      if (!options.isCurrent()) { resolve(); return; }
      const failed = (): void => {
        if (options.isCurrent()) schedule(attempt);
        else resolve();
      };
      try {
        void Promise.resolve(options.deliver()).then(resolve, failed);
      } catch {
        failed();
      }
    };
    attempt();
  });
}
