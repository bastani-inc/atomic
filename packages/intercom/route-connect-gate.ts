/**
 * Route clients that open sockets to a saturated broker at once only deepen its backlog. The gate lets
 * a bounded number of attempts run and queues the rest in arrival order.
 */
export const ROUTE_CLIENT_CONNECT_CONCURRENCY = 4;

export interface ConcurrencyGate {
	run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createConcurrencyGate(limit: number): ConcurrencyGate {
	let active = 0;
	const waiting: Array<() => void> = [];
	const release = (): void => {
		const next = waiting.shift();
		if (next === undefined) active -= 1;
		else next();
	};
	return {
		async run<T>(operation: () => Promise<T>): Promise<T> {
			if (active < limit) active += 1;
			else await new Promise<void>((resolve) => waiting.push(resolve));
			try {
				return await operation();
			} finally {
				release();
			}
		},
	};
}
