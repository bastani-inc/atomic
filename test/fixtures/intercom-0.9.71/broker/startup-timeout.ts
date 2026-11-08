/**
 * How long one spawn attempt waits for a new broker to answer on its socket, unless `brokerStartupTimeoutMs` in the
 * Intercom config says otherwise.
 *
 * A Node install starts the broker from `broker/broker.ts` through jiti, so the wait is the broker's own start-up,
 * which scales with the CPU share it gets. Measured from spawn to the first answered connection (Linux, one broker,
 * pinned to a core shared with busy loops):
 *
 * | jiti cache | idle   | 5 processes per core | 9 per core | 17 per core |
 * | ---------- | ------ | -------------------- | ---------- | ----------- |
 * | warm       | 0.49 s | 2.6 s                | 4.6 s      |             |
 * | cold       | 1.57 s | 8.7 s                | 15.0 s     | 27.7 s      |
 *
 * jiti's cache lives in the temporary directory, so a cold cache is the first start after a reboot or on a
 * throwaway CI machine. The previous 5 s covered only a warm cache on a busy host, so a loaded or freshly started
 * machine failed Intercom start-up with a broker that was still starting. 30 s covers a cold cache at 17 processes
 * per core. A broker that exits ends the wait at once (except behind the Windows launcher, which hides its pid), so a
 * long budget delays only the report of a broker that stays alive without listening.
 */
export const BROKER_READY_TIMEOUT_MS = 30_000;

/** The smallest `brokerStartupTimeoutMs` the config accepts: below this a broker cannot listen on any host. */
export const MIN_BROKER_STARTUP_TIMEOUT_MS = 1_000;
