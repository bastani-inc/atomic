import { setTimeout as delay } from "node:timers/promises";
import { IntercomBrokerSuccessorTimeoutError } from "@bastani/atomic";
import { BROKER_RETIRING_RETRY_WINDOW_MS, brokerRetiringRetryDelayMs } from "./reconnect-backoff.js";
import { isIntercomBrokerRetiring } from "./recoverable-disconnect.js";

/** Clock and wait of {@link registerWithBrokerSuccessor}; tests replace them to count attempts without waiting. */
export interface BrokerSuccessorRetryTiming {
	/** Monotonic milliseconds. */
	readonly now: () => number;
	readonly wait: (ms: number) => Promise<void>;
}

const REAL_TIMING: BrokerSuccessorRetryTiming = { now: performance.now.bind(performance), wait: delay };

/**
 * Run `attempt`, which spawns the broker when none is running and registers a new client with it, until a broker
 * accepts the registration. A broker that retires while the registration is in flight (idle retirement, a restart, a
 * replacement) ends it with an `IntercomBrokerRetiringError`; the attempt then runs again after
 * {@link brokerRetiringRetryDelayMs}, so it spawns and registers with the replacement. Retries stop
 * {@link BROKER_RETIRING_RETRY_WINDOW_MS} after the first such failure with an
 * {@link IntercomBrokerSuccessorTimeoutError} whose cause is the last one. Any other failure is thrown as it is, and
 * `attempt` checks that its connection is still wanted, so a retry after the connection closed ends with its own error.
 */
export async function registerWithBrokerSuccessor<T>(
	attempt: () => Promise<T>,
	timing: BrokerSuccessorRetryTiming = REAL_TIMING,
): Promise<T> {
	let firstLossAt: number | undefined;
	let losses = 0;
	for (;;) {
		try {
			return await attempt();
		} catch (error) {
			if (!isIntercomBrokerRetiring(error)) throw error;
			const lostAt = timing.now();
			firstLossAt ??= lostAt;
			losses += 1;
			const elapsedMs = lostAt - firstLossAt;
			if (elapsedMs >= BROKER_RETIRING_RETRY_WINDOW_MS) {
				throw new IntercomBrokerSuccessorTimeoutError(
					{ timeoutMs: BROKER_RETIRING_RETRY_WINDOW_MS, elapsedMs: Math.round(elapsedMs), attempts: losses },
					{ cause: error },
				);
			}
			await timing.wait(brokerRetiringRetryDelayMs(losses - 1));
		}
	}
}
