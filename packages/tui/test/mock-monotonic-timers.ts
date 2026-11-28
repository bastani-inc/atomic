import type { TestContext } from "node:test";

export function mockMonotonicTimers(t: TestContext): void {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
	// Node's mock timers advance Date and timeouts, but not performance.now().
	t.mock.method(performance, "now", Date.now.bind(Date));
}
