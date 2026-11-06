import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { FixtureRemovalError, isFixtureRemovalError } from "../helpers/fixture-removal.js";
import {
	type FixtureResource,
	isResourceCloseError,
	isWorkerCloseTimeoutError,
	isWorkerTeardownError,
	ResourceCloseError,
	runThenTearDown,
	stopWorker,
	tearDownWorkerFixture,
	WORKER_CLOSE_TIMEOUT_MS,
	WorkerCloseTimeoutError,
	WorkerTeardownError,
	workerClosed,
} from "../helpers/worker-fixture-teardown.js";

const DIRECTORY = "C:\\a\\_temp\\local-worker-control-0";

/** A worker process that closes when killed, unless told it never closes, and logs what happens to it. */
class FakeWorker extends EventEmitter {
	readonly pid = 4506;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	constructor(
		private readonly log: string[],
		private readonly closesWhenKilled = true,
	) {
		super();
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.log.push(`kill ${String(signal)}`);
		if (this.closesWhenKilled) queueMicrotask(() => this.end(null, "SIGKILL"));
		return true;
	}

	end(code: number | null, signal: NodeJS.Signals | null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
		this.log.push("closed");
		this.emit("close", code, signal);
	}
}

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: rmdir '${DIRECTORY}'`), { code, syscall: "rmdir" });
}

function resource(log: string[], name: string, failure?: Error): FixtureResource {
	return {
		name,
		close: async () => {
			log.push(`close ${name}`);
			if (failure !== undefined) throw failure;
		},
	};
}

/** Removal options that record each attempt and fail with `failures` in turn. */
function removal(log: string[], failures: readonly unknown[] = []) {
	const warnings: string[] = [];
	let attempts = 0;
	return {
		warnings,
		options: {
			remove: (path: string) => {
				const failure = failures[attempts++];
				log.push(`remove ${path}`);
				if (failure !== undefined) throw failure;
			},
			sleep: () => {},
			warn: (message: string) => {
				warnings.push(message);
			},
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

test("a running worker is killed once with SIGKILL, and the stop ends when it has closed (#4506)", async () => {
	const log: string[] = [];
	const worker = new FakeWorker(log);
	await stopWorker(worker, workerClosed(worker));
	assert.deepEqual(log, ["kill SIGKILL", "closed"]);
});

for (const [label, exitCode, signalCode] of [
	["exited by itself", 1, null],
	["was ended by a signal", null, "SIGTERM"],
] as const) {
	test(`a worker that ${label} is not killed again, and the stop still waits for it to close (#4506)`, async () => {
		const log: string[] = [];
		const worker = new FakeWorker(log);
		const closed = workerClosed(worker);
		worker.exitCode = exitCode;
		worker.signalCode = signalCode;
		let stopped = false;
		const stopping = stopWorker(worker, closed).then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(stopped, false, "its stdio and IPC channel have not closed yet");
		worker.end(exitCode, signalCode);
		await stopping;
		assert.deepEqual(log, ["closed"]);
	});
}

test("workerClosed resolves on close, not on exit (#4506)", async () => {
	const worker = new EventEmitter();
	let closed = false;
	const closing = workerClosed(worker).then(() => {
		closed = true;
	});
	worker.emit("exit", 0, null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, false);
	worker.emit("close", 0, null);
	await closing;
	assert.equal(closed, true);
});

test("a killed worker that never closes is a worker-close-timeout WorkerCloseTimeoutError after the bound (#4506)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.advanceTimersByTime(1_000);
	const log: string[] = [];
	const worker = new FakeWorker(log, false);
	const outcome = stopWorker(worker, workerClosed(worker)).then(
		() => undefined,
		(error: unknown) => error,
	);
	await vi.advanceTimersByTimeAsync(WORKER_CLOSE_TIMEOUT_MS - 1);
	assert.equal(vi.getTimerCount(), 1, "the stop still waits one millisecond before its bound");
	await vi.advanceTimersByTimeAsync(1);
	const error = await outcome;
	assert.ok(error instanceof WorkerCloseTimeoutError);
	assert.ok(error instanceof WorkerTeardownError);
	assert.equal(error.name, "WorkerCloseTimeoutError");
	assert.equal(error.code, "worker-close-timeout");
	assert.equal(error.pid, 4506);
	assert.equal(error.timeoutMs, WORKER_CLOSE_TIMEOUT_MS);
	assert.equal(error.phase, "after-kill");
	assert.equal(error.elapsedMs, WORKER_CLOSE_TIMEOUT_MS, "measured from the stop's start on the monotonic clock");
	assert.match(error.hint, /keeps the worker or its stdio open/u);
	assert.deepEqual(log, ["kill SIGKILL"]);
	assert.equal(vi.getTimerCount(), 0);
});

test("a worker that exited by itself but never closes times out after-exit, within the bound it was given (#4506)", async () => {
	const worker = new FakeWorker([], false);
	worker.exitCode = 1;
	await assert.rejects(stopWorker(worker, workerClosed(worker), 5), (error) => {
		assert.ok(isWorkerCloseTimeoutError(error));
		assert.equal(error.phase, "after-exit");
		assert.equal(error.timeoutMs, 5);
		return true;
	});
});

test("a stop that ends by the close leaves no timer behind (#4506)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const worker = new FakeWorker([]);
	await stopWorker(worker, workerClosed(worker));
	assert.equal(vi.getTimerCount(), 0);
});

test("the teardown stops the worker, closes the resources in their order, then removes the directory (#4506)", async () => {
	const log: string[] = [];
	const worker = new FakeWorker(log);
	const removed = removal(log);
	await tearDownWorkerFixture(
		{
			worker: { process: worker, closed: workerClosed(worker) },
			resources: [resource(log, "backend"), resource(log, "journal"), resource(log, "database")],
			directory: DIRECTORY,
		},
		removed.options,
	);
	assert.deepEqual(log, [
		"kill SIGKILL",
		"closed",
		"close backend",
		"close journal",
		"close database",
		`remove ${DIRECTORY}`,
	]);
	assert.deepEqual(removed.warnings, []);
});

test("a fixture that failed before its worker started still closes what it opened and removes its directory (#4506)", async () => {
	const log: string[] = [];
	await tearDownWorkerFixture({ resources: [resource(log, "database")], directory: DIRECTORY }, removal(log).options);
	assert.deepEqual(log, ["close database", `remove ${DIRECTORY}`]);
});

test("a transient lock on the directory is retried, and the recovery is reported once (#4506)", async () => {
	const log: string[] = [];
	const removed = removal(log, [errno("EBUSY"), errno("EBUSY")]);
	await tearDownWorkerFixture({ resources: [], directory: DIRECTORY }, removed.options);
	assert.deepEqual(log, [`remove ${DIRECTORY}`, `remove ${DIRECTORY}`, `remove ${DIRECTORY}`]);
	assert.deepEqual(removed.warnings, [`Removed ${DIRECTORY} after 3 attempts; retried EBUSY, EBUSY.`]);
});

test("a resource that fails to close is a resource-close-failed ResourceCloseError, and the rest still runs (#4506)", async () => {
	const log: string[] = [];
	const cause = new Error("database is locked");
	await assert.rejects(
		tearDownWorkerFixture(
			{
				resources: [resource(log, "backend"), resource(log, "journal", cause), resource(log, "database")],
				directory: DIRECTORY,
			},
			removal(log).options,
		),
		(error) => {
			assert.ok(error instanceof ResourceCloseError);
			assert.ok(isWorkerTeardownError(error));
			assert.equal(error.name, "ResourceCloseError");
			assert.equal(error.code, "resource-close-failed");
			assert.equal(error.resource, "journal");
			assert.equal(error.cause, cause);
			assert.match(error.hint, /see the cause/u);
			assert.equal("cleanupCause" in error, false);
			return true;
		},
	);
	assert.deepEqual(log, ["close backend", "close journal", "close database", `remove ${DIRECTORY}`]);
});

test("every teardown failure is kept: the first is thrown, each later one attached to the one before (#4506)", async () => {
	const log: string[] = [];
	const worker = new FakeWorker(log, false);
	const refusal = errno("EACCES");
	await assert.rejects(
		tearDownWorkerFixture(
			{
				worker: { process: worker, closed: workerClosed(worker) },
				resources: [resource(log, "journal", new Error("journal")), resource(log, "database")],
				directory: DIRECTORY,
			},
			{ ...removal(log, [refusal]).options, closeTimeoutMs: 1 },
		),
		(error) => {
			assert.ok(isWorkerCloseTimeoutError(error));
			assert.equal(error.timeoutMs, 1);
			const closing = (error as { readonly cleanupCause?: unknown }).cleanupCause;
			assert.ok(isResourceCloseError(closing));
			assert.equal(closing.resource, "journal");
			const removing = (closing as { readonly cleanupCause?: unknown }).cleanupCause;
			assert.ok(removing instanceof FixtureRemovalError);
			assert.equal(removing.code, "removal-refused");
			assert.equal(removing.cause, refusal);
			assert.equal("cleanupCause" in removing, false);
			return true;
		},
	);
	assert.deepEqual(log, ["kill SIGKILL", "close journal", "close database", `remove ${DIRECTORY}`]);
});

test("a removal failure alone is thrown as the FixtureRemovalError it is (#4506)", async () => {
	const log: string[] = [];
	await assert.rejects(
		tearDownWorkerFixture({ resources: [], directory: DIRECTORY }, removal(log, [errno("EACCES")]).options),
		(error) => isFixtureRemovalError(error) && error.code === "removal-refused" && !("cleanupCause" in error),
	);
});

test("runThenTearDown returns the work's result after tearing down once (#4506)", async () => {
	const log: string[] = [];
	const result = await runThenTearDown(
		async () => {
			log.push("work");
			return 7;
		},
		async () => {
			log.push("teardown");
		},
	);
	assert.equal(result, 7);
	assert.deepEqual(log, ["work", "teardown"]);
});

test("a failed work stays the thrown error after its teardown ran (#4506)", async () => {
	const log: string[] = [];
	const primary = new Error("assertion failed");
	await assert.rejects(
		runThenTearDown(
			async () => {
				throw primary;
			},
			async () => {
				log.push("teardown");
			},
		),
		(error) => error === primary && !("cleanupCause" in error),
	);
	assert.deepEqual(log, ["teardown"]);
});

test("a teardown failure after a failed work is attached to it as cleanupCause, never in its place (#4506)", async () => {
	const primary = new Error("assertion failed");
	const cleanup = new ResourceCloseError("database", { cause: new Error("locked") });
	await assert.rejects(
		runThenTearDown(
			async () => {
				throw primary;
			},
			async () => {
				throw cleanup;
			},
		),
		(error) => error === primary && (error as { readonly cleanupCause?: unknown }).cleanupCause === cleanup,
	);
});

test("a thrown non-Error and a failed teardown are both kept in an AggregateError (#4506)", async () => {
	const cleanup = new ResourceCloseError("database", { cause: new Error("locked") });
	await assert.rejects(
		runThenTearDown(
			async () => {
				throw "gone";
			},
			async () => {
				throw cleanup;
			},
		),
		(error) => {
			assert.ok(error instanceof AggregateError);
			assert.deepEqual(error.errors, ["gone", cleanup]);
			assert.equal(error.message, "A worker fixture failed and so did its teardown.");
			return true;
		},
	);
});

test("a teardown that fails after a passing work fails the test with the teardown's error (#4506)", async () => {
	const cleanup = new ResourceCloseError("database", { cause: new Error("locked") });
	await assert.rejects(
		runThenTearDown(
			async () => 7,
			async () => {
				throw cleanup;
			},
		),
		(error) => error === cleanup,
	);
});

test("the teardown errors' messages name the subject, code and next step (#4506)", () => {
	assert.equal(
		new WorkerCloseTimeoutError({ pid: 4506, timeoutMs: 10_000, elapsedMs: 10_003, phase: "after-kill" }).message,
		"Worker fixture teardown failed: worker 4506 still open 10003 ms after-kill (bound 10000 ms) (worker-close-timeout). Find what keeps the worker or its stdio open (a process it started, for example with Get-Process or ps) and rerun.",
	);
	assert.match(
		new WorkerCloseTimeoutError({ pid: undefined, timeoutMs: 1, elapsedMs: 1, phase: "after-exit" }).message,
		/worker without a pid still open 1 ms after-exit/u,
	);
	assert.equal(
		new ResourceCloseError("journal", { cause: new Error("locked") }).message,
		"Worker fixture teardown failed: closing the journal (resource-close-failed). Closing the resource failed; see the cause.",
	);
});

test("the guards match the teardown errors by name and code after they crossed a boundary (#4506)", () => {
	const timeout = { name: "WorkerCloseTimeoutError", code: "worker-close-timeout" };
	const close = { name: "ResourceCloseError", code: "resource-close-failed" };
	assert.equal(isWorkerCloseTimeoutError(timeout), true);
	assert.equal(isResourceCloseError(close), true);
	assert.equal(isWorkerTeardownError(timeout), true);
	assert.equal(isWorkerTeardownError(close), true);
	assert.equal(isWorkerCloseTimeoutError(close), false);
	assert.equal(isResourceCloseError(timeout), false);
	assert.equal(isWorkerCloseTimeoutError({ name: "WorkerCloseTimeoutError", code: "resource-close-failed" }), false);
	assert.equal(isResourceCloseError({ name: "ResourceCloseError", code: "worker-close-timeout" }), false);
	assert.equal(isWorkerTeardownError({ name: "Error", code: "worker-close-timeout" }), false);
	assert.equal(isWorkerTeardownError(new Error("plain")), false);
	assert.equal(isWorkerTeardownError(null), false);
	assert.equal(isWorkerTeardownError("WorkerCloseTimeoutError"), false);
	assert.equal(isWorkerTeardownError(undefined), false);
});

test("a real worker holding its SQLite journal open is stopped and closed before the directory is removed (#4506)", async () => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-worker-teardown-"));
	const child = spawn(
		process.execPath,
		[
			"-e",
			"const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE held(x)'); console.log('held'); setInterval(() => {}, 1000);",
			join(directory, "journal.sqlite"),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const closed = workerClosed(child);
	await new Promise<void>((resolve, reject) => {
		child.stdout.once("data", () => resolve());
		child.once("exit", (code) => reject(new Error(`the holder exited with ${code} before it opened the journal`)));
	});
	await tearDownWorkerFixture({ worker: { process: child, closed }, resources: [], directory });
	assert.equal(child.signalCode, "SIGKILL");
	assert.equal(existsSync(directory), false);
});
