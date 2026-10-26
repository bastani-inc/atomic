import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	openRunRejectionScope,
	type RunRejectionScope,
} from "../../packages/workflows/src/engine/run-rejection-boundary.js";

const EVENT = "unhandledRejection";
const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

const opened: RunRejectionScope[] = [];

afterEach(() => {
	for (const scope of opened.splice(0)) scope.close();
	vi.restoreAllMocks();
});

function boundaryListener(): RejectionListener {
	const bag = globalThis as typeof globalThis & Record<symbol, { listener?: RejectionListener } | undefined>;
	const listener = bag[Symbol.for("atomic-workflows/run-rejection-boundary@5")]?.listener;
	assert.ok(listener);
	return listener;
}

function deliverToBoundaryOnly(reason: Error): void {
	const listeners = process.listeners(EVENT) as RejectionListener[];
	for (const listener of listeners) process.removeListener(EVENT, listener);
	try {
		boundaryListener()(reason, Promise.resolve());
	} finally {
		for (const listener of listeners) process.on(EVENT, listener);
	}
}

test("a stale extension-ctx rejection left behind by a replaced fallback session does not become the run's error (#3981)", () => {
	const failures: object[] = [];
	const reported: unknown[][] = [];
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		reported.push(args);
	});
	const scope = openRunRejectionScope({ runId: "stale-ctx-run", fail: (error) => failures.push(error) });
	opened.push(scope);
	const stale = new Error(STALE_MESSAGE);
	stale.stack = `Error: ${STALE_MESSAGE}\n    at retiredExtensionCall (/atomic/extension.ts:1:1)`;

	scope.run(() => deliverToBoundaryOnly(stale));

	// The stage's own failure (here: the rate limit) stays the run's error.
	assert.deepEqual(failures, []);
	// The stale rejection is still reported with its stack, naming the call site for diagnosis.
	assert.equal(reported.length, 1);
	assert.match(String(reported[0]![0]), /stale-ctx-run/);
	assert.equal(reported[0]![1], stale);
});

test("any other unhandled rejection in the run still fails it (#3981)", () => {
	const failures: object[] = [];
	const scope = openRunRejectionScope({ runId: "other-run", fail: (error) => failures.push(error) });
	opened.push(scope);
	const error = new Error("real failure");

	scope.run(() => deliverToBoundaryOnly(error));

	assert.deepEqual(failures, [error]);
});
