/**
 * The issue #2078 CLI fixture publishes its state by renaming a complete temporary file over the
 * file its drivers poll. Windows refuses that rename while a driver has the file open, and the
 * refusal used to escape the fixture's abort listener and crash the CLI (#4442).
 *
 * These tests run the fixture workflow in this process with a controllable abort signal and a
 * `renameSync` that refuses on demand, so each retry and the listener's failure path are counted.
 */

import assert from "node:assert/strict";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { WorkflowSerializableValue, WorkflowToolContext } from "../../packages/workflows/src/authoring.js";
import { fileExistsSync, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import issue2078ToolQuit from "../integration/fixtures/issue-2078-tool-quit-workflow.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

/** The fixture's pauses between rename attempts, in order. */
const RENAME_BACKOFF_MS = [10, 20, 40, 80, 160, 320];

interface FixtureState {
	readonly siblingExecutions: number;
	readonly hangExecutions: number;
	readonly hangRunning: boolean;
	readonly hangObservedAbort: boolean;
}

let stateDir: string;

beforeEach(() => {
	stateDir = makeTempDirectory("atomic-issue-4442-");
	vi.stubEnv("ISSUE_2078_STATE_DIR", stateDir);
});

afterEach(() => {
	vi.mocked(renameSync).mockReset();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(stateDir);
});

const statePath = (): string => join(stateDir, "issue-2078-state.json");

function publishedState(): FixtureState {
	return JSON.parse(readFileSync(statePath(), "utf8")) as FixtureState;
}

function renameRefusal(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: rename refused`), { code, syscall: "rename" });
}

interface ParkedRun {
	readonly run: Promise<unknown>;
}

type FixtureRunContext = Parameters<typeof issue2078ToolQuit.run>[0];

/** Start the workflow with a context that only offers `ctx.tool`, the one primitive the fixture calls. */
async function parkHangTool(signal: AbortSignal): Promise<ParkedRun> {
	const tool = async <T extends WorkflowSerializableValue>(
		_name: string,
		_args: Readonly<Record<string, WorkflowSerializableValue>>,
		fn: (toolCtx: WorkflowToolContext) => Promise<T>,
	): Promise<T> => fn({ signal });
	const context: Partial<FixtureRunContext> = { tool };
	const run = Promise.resolve(issue2078ToolQuit.run(context as FixtureRunContext));
	await vi.waitFor(() => assert.equal(publishedState().hangRunning, true));
	return { run };
}

const STILL_PENDING = Symbol("still pending");

/**
 * How the run ended. The abort listener publishes synchronously and then rejects, so the run has
 * settled once the microtasks queued by `abort()` drain; a listener that threw leaves it pending.
 */
async function settlement(run: Promise<unknown>): Promise<Error | typeof STILL_PENDING> {
	const ended = run.then(
		() => assert.fail("the run cannot complete while hang-tool is aborted"),
		(error: Error) => error,
	);
	return Promise.race([ended, new Promise<typeof STILL_PENDING>((resolve) => setImmediate(resolve, STILL_PENDING))]);
}

function pausesTaken(wait: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }): unknown[] {
	return wait.mock.calls.map((call) => call[3]);
}

test("a rename refused with EPERM or EBUSY is retried until the reader lets go (#4442)", async () => {
	const controller = new AbortController();
	const { run } = await parkHangTool(controller.signal);
	const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
	vi.mocked(renameSync).mockClear();
	vi.mocked(renameSync)
		.mockImplementationOnce(() => {
			throw renameRefusal("EPERM");
		})
		.mockImplementationOnce(() => {
			throw renameRefusal("EBUSY");
		});

	controller.abort();

	const ended = await settlement(run);
	assert.ok(ended instanceof Error);
	assert.equal(ended.cause, undefined);
	assert.equal(vi.mocked(renameSync).mock.calls.length, 3);
	assert.deepEqual(pausesTaken(wait), RENAME_BACKOFF_MS.slice(0, 2));
	assert.deepEqual(publishedState(), {
		siblingExecutions: 1,
		hangExecutions: 1,
		hangRunning: false,
		hangObservedAbort: true,
	});
	assert.equal(fileExistsSync(`${statePath()}.tmp`), false);
});

test("a rename that stays refused settles the aborted call with the failure instead of crashing (#4442)", async () => {
	const controller = new AbortController();
	const { run } = await parkHangTool(controller.signal);
	const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
	const report = vi.spyOn(console, "error").mockReturnValue(undefined);
	const refusals: NodeJS.ErrnoException[] = [];
	vi.mocked(renameSync).mockClear();
	vi.mocked(renameSync).mockImplementation(() => {
		const refusal = renameRefusal("EPERM");
		refusals.push(refusal);
		throw refusal;
	});

	controller.abort();

	const ended = await settlement(run);
	assert.ok(ended instanceof Error, "the abort listener must settle hang-tool even when publishing fails");
	assert.equal(ended.message, "hang-tool observed its abort signal but could not publish it");
	assert.equal(refusals.length, RENAME_BACKOFF_MS.length + 1);
	assert.equal(ended.cause, refusals.at(-1));
	assert.deepEqual(pausesTaken(wait), RENAME_BACKOFF_MS);
	assert.deepEqual(report.mock.calls, [[ended]]);
	assert.deepEqual(publishedState(), {
		siblingExecutions: 1,
		hangExecutions: 1,
		hangRunning: true,
		hangObservedAbort: false,
	});
});

test("a rename failure other than EPERM or EBUSY is not retried (#4442)", async () => {
	const controller = new AbortController();
	const { run } = await parkHangTool(controller.signal);
	const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
	vi.spyOn(console, "error").mockReturnValue(undefined);
	const crossDevice = renameRefusal("EXDEV");
	vi.mocked(renameSync).mockClear();
	vi.mocked(renameSync).mockImplementationOnce(() => {
		throw crossDevice;
	});

	controller.abort();

	const ended = await settlement(run);
	assert.ok(ended instanceof Error);
	assert.equal(ended.cause, crossDevice);
	assert.equal(vi.mocked(renameSync).mock.calls.length, 1);
	assert.deepEqual(pausesTaken(wait), []);
});
