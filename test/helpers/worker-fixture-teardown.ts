import type { ChildProcess } from "node:child_process";
import { type FixtureRemovalOptions, removeFixtureTree } from "./fixture-removal.js";

/** How long a worker process gets to close once it was killed, or once it exited by itself. */
export const WORKER_CLOSE_TIMEOUT_MS = 10_000;

/**
 * - `worker-close-timeout`: the worker process had not closed (exited, with its stdio and IPC channel closed) within
 *   the bound, so it, or a process holding its stdio, may still hold files under the fixture's directory.
 * - `resource-close-failed`: closing one of the fixture's resources (a backend, journal or database) threw; the
 *   resources after it were still closed and the directory was still removed.
 */
export type WorkerTeardownErrorCode = "worker-close-timeout" | "resource-close-failed";

/** Whether the worker was killed by the teardown, or had already exited by itself when the teardown began. */
export type WorkerClosePhase = "after-kill" | "after-exit";

const HINTS: Readonly<Record<WorkerTeardownErrorCode, string>> = {
	"worker-close-timeout":
		"Find what keeps the worker or its stdio open (a process it started, for example with Get-Process or ps) and rerun",
	"resource-close-failed": "Closing the resource failed; see the cause",
};

/** A worker fixture that could not be torn down; the family of every teardown failure but the directory's removal. */
export abstract class WorkerTeardownError extends Error {
	abstract override readonly name: "WorkerCloseTimeoutError" | "ResourceCloseError";
	readonly code: WorkerTeardownErrorCode;
	readonly hint: string;

	protected constructor(code: WorkerTeardownErrorCode, subject: string, options?: { readonly cause: unknown }) {
		const hint = HINTS[code];
		super(`Worker fixture teardown failed: ${subject} (${code}). ${hint}.`, options);
		this.code = code;
		this.hint = hint;
	}
}

export interface WorkerCloseTimeoutFields {
	readonly pid: number | undefined;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: WorkerClosePhase;
}

/** The worker process did not close within {@link WorkerCloseTimeoutFields.timeoutMs}. */
export class WorkerCloseTimeoutError extends WorkerTeardownError {
	override readonly name = "WorkerCloseTimeoutError" as const;
	declare readonly code: "worker-close-timeout";
	readonly pid: number | undefined;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	readonly phase: WorkerClosePhase;

	constructor(fields: WorkerCloseTimeoutFields) {
		super(
			"worker-close-timeout",
			`worker ${fields.pid ?? "without a pid"} still open ${fields.elapsedMs} ms ${fields.phase} (bound ${fields.timeoutMs} ms)`,
		);
		this.pid = fields.pid;
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
		this.phase = fields.phase;
	}
}

/** Closing the fixture resource named `resource` threw; that failure is `cause`. */
export class ResourceCloseError extends WorkerTeardownError {
	override readonly name = "ResourceCloseError" as const;
	declare readonly code: "resource-close-failed";
	readonly resource: string;

	constructor(resource: string, options: { readonly cause: unknown }) {
		super("resource-close-failed", `closing the ${resource}`, options);
		this.resource = resource;
	}
}

function hasNameAndCode(error: unknown, name: string, code: WorkerTeardownErrorCode): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: string; readonly code?: string };
	return candidate.name === name && candidate.code === code;
}

export function isWorkerCloseTimeoutError(error: unknown): error is WorkerCloseTimeoutError {
	return (
		error instanceof WorkerCloseTimeoutError ||
		hasNameAndCode(error, "WorkerCloseTimeoutError", "worker-close-timeout")
	);
}

export function isResourceCloseError(error: unknown): error is ResourceCloseError {
	return error instanceof ResourceCloseError || hasNameAndCode(error, "ResourceCloseError", "resource-close-failed");
}

export function isWorkerTeardownError(error: unknown): error is WorkerTeardownError {
	return isWorkerCloseTimeoutError(error) || isResourceCloseError(error);
}

/** What the teardown needs of a worker process: a `ChildProcess`, or a test's stand-in for one. */
export type StoppableWorker = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">;

/**
 * Resolves once `worker` has closed: it exited and its stdio streams and IPC channel closed. Call it as the worker
 * starts, since a close that happened before anyone listened is not reported again.
 */
export function workerClosed(worker: { once(event: "close", listener: () => void): unknown }): Promise<void> {
	return new Promise((resolve) => {
		worker.once("close", () => resolve());
	});
}

/**
 * Kills `worker` with SIGKILL unless it already exited, then waits for `closed` (from {@link workerClosed}).
 *
 * @throws {WorkerCloseTimeoutError} when it has not closed within `timeoutMs`.
 */
export async function stopWorker(
	worker: StoppableWorker,
	closed: Promise<void>,
	timeoutMs = WORKER_CLOSE_TIMEOUT_MS,
): Promise<void> {
	const phase: WorkerClosePhase = worker.exitCode === null && worker.signalCode === null ? "after-kill" : "after-exit";
	if (phase === "after-kill") worker.kill("SIGKILL");
	const started = performance.now();
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), timeoutMs);
	});
	try {
		if ((await Promise.race([closed, expired])) !== "expired") return;
	} finally {
		clearTimeout(timer);
	}
	throw new WorkerCloseTimeoutError({
		pid: worker.pid,
		timeoutMs,
		elapsedMs: Math.round(performance.now() - started),
		phase,
	});
}

/** One thing a worker fixture opened in the test's own process, named for its teardown error. */
export interface FixtureResource {
	readonly name: string;
	close(): Promise<void>;
}

export interface WorkerFixture {
	/** The worker process and its {@link workerClosed}; absent when the fixture failed before it started one. */
	readonly worker?: { readonly process: StoppableWorker; readonly closed: Promise<void> };
	/** Closed in this order once the worker is gone, each one also when one before it failed. */
	readonly resources: readonly FixtureResource[];
	/** Removed last, with {@link removeFixtureTree}. */
	readonly directory: string;
}

export interface WorkerTeardownOptions extends FixtureRemovalOptions {
	readonly closeTimeoutMs?: number;
}

/**
 * Tears a worker fixture down in the order Windows needs: the worker is stopped and closed, so no handle of its
 * remains; then the test's own resources close; then the directory is removed, retrying a transient lock. Every step
 * runs whatever happened before it.
 *
 * @throws the first step's failure ({@link WorkerTeardownError} or `FixtureRemovalError`), each later failure attached
 * to the one before it as `cleanupCause`.
 */
export async function tearDownWorkerFixture(
	fixture: WorkerFixture,
	options: WorkerTeardownOptions = {},
): Promise<void> {
	const failures: unknown[] = [];
	if (fixture.worker !== undefined) {
		try {
			await stopWorker(fixture.worker.process, fixture.worker.closed, options.closeTimeoutMs);
		} catch (error) {
			failures.push(error);
		}
	}
	for (const resource of fixture.resources) {
		try {
			await resource.close();
		} catch (cause) {
			failures.push(new ResourceCloseError(resource.name, { cause }));
		}
	}
	try {
		removeFixtureTree(fixture.directory, options);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) throw failures.reduceRight((later, earlier) => withCleanupCause(earlier, later));
}

/**
 * Runs `work`, then `tearDown`, also when `work` throws. A failure of `work` stays the thrown error: when the teardown
 * fails as well, its failure is attached as `cleanupCause`.
 */
export async function runThenTearDown<T>(work: () => Promise<T>, tearDown: () => Promise<void>): Promise<T> {
	let result: T;
	try {
		result = await work();
	} catch (primary) {
		try {
			await tearDown();
		} catch (cleanup) {
			throw withCleanupCause(primary, cleanup);
		}
		throw primary;
	}
	await tearDown();
	return result;
}

function withCleanupCause(primary: unknown, cleanupCause: unknown): unknown {
	if (primary instanceof Error) return Object.assign(primary, { cleanupCause });
	return new AggregateError([primary, cleanupCause], "A worker fixture failed and so did its teardown.");
}
