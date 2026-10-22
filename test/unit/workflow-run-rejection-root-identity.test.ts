import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
	openRunRejectionScope,
	type RunRejectionScope,
} from "../../packages/workflows/src/engine/run-rejection-boundary.js";

const EVENT = "unhandledRejection";
const ROOT_SOURCE = "/workspace/workflows/root-workflow.ts";
const SHARED_SOURCE = "/workspace/workflows/middle-and-child.ts";

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;

const opened: RunRejectionScope[] = [];

afterEach(() => {
	for (const scope of opened.splice(0)) scope.close();
});

function open(runId: string, source: string, parentRunId: string | undefined, failures: object[]): RunRejectionScope {
	const scope = openRunRejectionScope({ runId, source, parentRunId, fail: (error) => failures.push(error) });
	opened.push(scope);
	return scope;
}

function authorErrorFrom(source: string): Error {
	const error = new Error("child author error");
	error.stack = `Error: child author error\n    at releaseLater (${source}:12:9)`;
	return error;
}

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

test("a detached child's author error fails that child after its finished parent is cleaned up (#3846)", async () => {
	const childFailures: object[] = [];
	const root = open("root-run", ROOT_SOURCE, undefined, []);
	const middle = open("middle-run", SHARED_SOURCE, "root-run", []);
	open("child-run", SHARED_SOURCE, "middle-run", childFailures);

	middle.close();
	await root.settle();

	const error = authorErrorFrom(SHARED_SOURCE);
	deliverToBoundaryOnly(error);

	assert.deepEqual(childFailures, [error]);
});
