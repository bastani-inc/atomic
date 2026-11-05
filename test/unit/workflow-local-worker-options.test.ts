import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import * as publicEntry from "../../packages/workflows/src/index.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	findLocalWorkerPoolError,
	isLocalWorkerOptionsError,
	isLocalWorkerPoolError,
	LocalWorkerOptionsError,
	LocalWorkerPoolError,
} from "../../packages/workflows/src/workers/local-worker-pool-errors.js";
import { withWorkerSettings } from "../../packages/workflows/src/workers/public-pool.js";
import {
	DEFAULT_WORK_LEASE_MS,
	defaultWorkerHeartbeatMs,
	MAX_TIMER_DELAY_MS,
	MINIMUM_WORK_LEASE_MS,
	MINIMUM_WORKER_HEARTBEAT_MS,
	resolveWorkerTiming,
} from "../../packages/workflows/src/workers/worker-timing.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

function refused(action: () => unknown): LocalWorkerOptionsError {
	try {
		action();
	} catch (error) {
		assert.ok(error instanceof LocalWorkerOptionsError, `threw ${String(error)}`);
		return error;
	}
	assert.fail("the options were accepted");
}

test("the heartbeat interval is a quarter of the lease unless set (#4313)", () => {
	assert.deepEqual(resolveWorkerTiming({}, "sdk"), { leaseMs: DEFAULT_WORK_LEASE_MS, heartbeatMs: 7_500 });
	assert.deepEqual(resolveWorkerTiming({ leaseMs: 60_000 }, "sdk"), { leaseMs: 60_000, heartbeatMs: 15_000 });
	assert.deepEqual(resolveWorkerTiming({ leaseMs: MINIMUM_WORK_LEASE_MS }, "sdk"), {
		leaseMs: 2_000,
		heartbeatMs: 500,
	});
	assert.equal(defaultWorkerHeartbeatMs(30_001), 7_500, "rounded down to whole milliseconds");
	assert.deepEqual(resolveWorkerTiming({ leaseMs: MAX_TIMER_DELAY_MS }, "settings"), {
		leaseMs: MAX_TIMER_DELAY_MS,
		heartbeatMs: Math.floor(MAX_TIMER_DELAY_MS / 4),
	});
	assert.deepEqual(resolveWorkerTiming({ leaseMs: 30_000, heartbeatMs: MINIMUM_WORKER_HEARTBEAT_MS }, "sdk"), {
		leaseMs: 30_000,
		heartbeatMs: 100,
	});
	assert.deepEqual(resolveWorkerTiming({ leaseMs: 30_001, heartbeatMs: 15_000 }, "sdk"), {
		leaseMs: 30_001,
		heartbeatMs: 15_000,
	});
	assert.deepEqual(resolveWorkerTiming({ heartbeatMs: 15_000 }, "sdk").heartbeatMs, 15_000);
});

test("an out-of-range lease is refused with a typed error naming the SDK setting (#4313)", () => {
	const below = refused(() => resolveWorkerTiming({ leaseMs: 1_999 }, "sdk"));
	assert.equal(below.name, "LocalWorkerOptionsError");
	assert.equal(below.code, "invalid-lease");
	assert.equal(below.reason, "below-minimum");
	assert.equal(below.source, "sdk");
	assert.equal(below.field, "localWorkers.leaseMs");
	assert.equal(below.option, "leaseMs");
	assert.equal(below.received, "1999");
	assert.equal(below.minimum, MINIMUM_WORK_LEASE_MS);
	assert.equal(below.maximum, MAX_TIMER_DELAY_MS);
	assert.equal(below.retryable, false);
	assert.ok(below instanceof LocalWorkerPoolError);
	assert.equal(
		below.message,
		"Invalid local worker lease: localWorkers.leaseMs is 1999, below the minimum 2000 ms (invalid-lease). Set localWorkers.leaseMs to an integer from 2000 to 2147483647 ms, or omit it for the 30000 ms default.",
	);
	assert.equal(
		below.hint,
		"Set localWorkers.leaseMs to an integer from 2000 to 2147483647 ms, or omit it for the 30000 ms default.",
	);
	const fraction = refused(() => resolveWorkerTiming({ leaseMs: 2_500.5 }, "sdk"));
	assert.equal(fraction.reason, "not-an-integer");
	assert.equal(
		fraction.message,
		"Invalid local worker lease: localWorkers.leaseMs is 2500.5, not an integer number of milliseconds (invalid-lease). Set localWorkers.leaseMs to an integer from 2000 to 2147483647 ms, or omit it for the 30000 ms default.",
	);
	const above = refused(() => resolveWorkerTiming({ leaseMs: MAX_TIMER_DELAY_MS + 1 }, "sdk"));
	assert.equal(above.reason, "above-maximum");
	assert.equal(above.received, "2147483648");
	const notNumber = refused(() => resolveWorkerTiming({ leaseMs: Number.NaN }, "sdk"));
	assert.equal(notNumber.reason, "not-an-integer");
	assert.equal(notNumber.received, "NaN", "a number is shown as it is, not as JSON");
	assert.equal(
		refused(() => resolveWorkerTiming({ leaseMs: "60000" as unknown as number }, "sdk")).received,
		'"60000"',
		"a value of the wrong type is shown as JSON",
	);
});

test("an out-of-range heartbeat is refused with a typed error naming the settings path (#4313)", () => {
	const above = refused(() => resolveWorkerTiming({ leaseMs: 30_000, heartbeatMs: 15_001 }, "settings"));
	assert.equal(above.code, "invalid-heartbeat");
	assert.equal(above.reason, "above-maximum");
	assert.equal(above.source, "settings");
	assert.equal(above.field, "workflows.localWorkers.heartbeatMs");
	assert.equal(above.option, "heartbeatMs");
	assert.equal(above.received, "15001");
	assert.equal(above.minimum, MINIMUM_WORKER_HEARTBEAT_MS);
	assert.equal(above.maximum, 15_000);
	assert.equal(
		above.message,
		"Invalid local worker heartbeat: workflows.localWorkers.heartbeatMs is 15001, above the maximum 15000 ms (invalid-heartbeat). Set workflows.localWorkers.heartbeatMs to an integer from 100 to 15000 ms, or omit it to send 4 heartbeats per lease.",
	);
	assert.equal(
		refused(() => resolveWorkerTiming({ heartbeatMs: 99 }, "sdk")).reason,
		"below-minimum",
		"the default lease bounds an explicit heartbeat too",
	);
	assert.equal(refused(() => resolveWorkerTiming({ heartbeatMs: 15_001 }, "sdk")).maximum, 15_000);
	assert.equal(refused(() => resolveWorkerTiming({ heartbeatMs: 250.5 }, "sdk")).reason, "not-an-integer");
	assert.equal(
		refused(() => resolveWorkerTiming({ leaseMs: 1_000, heartbeatMs: 1 }, "sdk")).code,
		"invalid-lease",
		"the lease is checked first",
	);
});

test("local worker pool errors are recognized across realms and through their cause chain (#4313)", () => {
	const error = refused(() => resolveWorkerTiming({ heartbeatMs: 99 }, "sdk"));
	assert.ok(isLocalWorkerOptionsError(error));
	assert.ok(isLocalWorkerPoolError(error));
	const crossed = JSON.parse(
		JSON.stringify({ name: error.name, code: error.code, message: error.message }),
	) as unknown;
	assert.ok(isLocalWorkerOptionsError(crossed), "a serialized copy keeps its name and code");
	assert.ok(isLocalWorkerPoolError(crossed));
	assert.equal(isLocalWorkerOptionsError({ name: "LocalWorkerOptionsError", code: "other" }), false);
	assert.equal(isLocalWorkerOptionsError({ name: "LocalWorkerPoolError", code: "invalid-lease" }), false);
	assert.equal(isLocalWorkerPoolError({ name: "LocalWorkerPoolError", code: "invalid-lease" }), true);
	assert.equal(isLocalWorkerPoolError({ name: "LocalWorkerPoolError" }), false, "a family error has a code");
	assert.equal(isLocalWorkerPoolError({ name: "Error", code: "invalid-lease" }), false);
	assert.equal(isLocalWorkerPoolError(new Error("Invalid local worker lease")), false, "never by its message");
	assert.equal(isLocalWorkerPoolError("LocalWorkerOptionsError"), false);
	assert.equal(isLocalWorkerPoolError(null), false);
	assert.equal(isLocalWorkerPoolError(undefined), false);
	assert.equal(isLocalWorkerOptionsError(null), false);
	assert.equal(isLocalWorkerOptionsError(undefined), false);
	assert.equal(isLocalWorkerOptionsError({ code: "invalid-lease" }), false, "a code needs its error's name");

	let wrapped: Error = error;
	for (let depth = 1; depth < 8; depth++) wrapped = new Error(`wrapper ${depth}`, { cause: wrapped });
	assert.equal(findLocalWorkerPoolError(wrapped), error, "found seven causes deep");
	assert.equal(
		findLocalWorkerPoolError(new Error("wrapper 8", { cause: wrapped })),
		undefined,
		"the chain is read eight errors deep at most",
	);
	assert.equal(findLocalWorkerPoolError(new Error("unrelated")), undefined);
	assert.equal(findLocalWorkerPoolError(new Error("no cause", { cause: null })), undefined);
	assert.equal(findLocalWorkerPoolError(undefined), undefined);
	assert.equal(findLocalWorkerPoolError(null), undefined);
	assert.equal(findLocalWorkerPoolError({ cause: crossed }), crossed, "a serialized chain is read as well");

	const family = new LocalWorkerPoolError("invalid-lease", "Invalid local worker lease (invalid-lease).", "Fix it.");
	assert.equal(family.name, "LocalWorkerPoolError");
	assert.equal(family.retryable, false);
	assert.equal(family.hint, "Fix it.");
	assert.ok(isLocalWorkerPoolError(family));
	assert.equal(isLocalWorkerOptionsError(family), false, "the family is not every one of its errors");
	const cause = new Error("cause");
	assert.equal(new LocalWorkerPoolError("invalid-heartbeat", "m", "h", { cause }).cause, cause);
});

test("the public entry exports the local worker pool errors and their guards (#4313)", () => {
	assert.equal(publicEntry.LocalWorkerPoolError, LocalWorkerPoolError);
	assert.equal(publicEntry.LocalWorkerOptionsError, LocalWorkerOptionsError);
	assert.equal(publicEntry.isLocalWorkerPoolError, isLocalWorkerPoolError);
	assert.equal(publicEntry.isLocalWorkerOptionsError, isLocalWorkerOptionsError);
	assert.equal(publicEntry.findLocalWorkerPoolError, findLocalWorkerPoolError);
});

const definition = workflow({
	name: "local-worker-options-root",
	description: "",
	inputs: {},
	outputs: {},
	async run() {
		return {};
	},
});

test("run refuses an invalid heartbeat before it opens or writes anything for the run (#4313)", async () => {
	const directory = makeTempDirectory("local-worker-options-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		await assert.rejects(
			run(
				definition,
				{},
				{
					runId: "root",
					durableBackend: backend,
					store: createStore(),
					localWorkers: { count: 1, definitions: [], leaseMs: 8_000, heartbeatMs: 4_001 },
				},
			),
			(error: unknown) =>
				isLocalWorkerOptionsError(error) &&
				error.code === "invalid-heartbeat" &&
				error.source === "sdk" &&
				error.field === "localWorkers.heartbeatMs" &&
				error.maximum === 4_000,
		);
		assert.deepEqual(await journal.listRuns(), [], "no run was registered");
		const unopened = join(directory, "unopened");
		await assert.rejects(
			run(
				definition,
				{},
				{
					journal: { path: join(unopened, "journal.sqlite") },
					store: createStore(),
					localWorkers: { count: 1, definitions: [], leaseMs: 1_000 },
				},
			),
			(error: unknown) => isLocalWorkerOptionsError(error) && error.code === "invalid-lease",
		);
		assert.equal(existsSync(unopened), false, "the run's journal was not opened");
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("merging host worker settings into run options only merges (#4313)", () => {
	const invalid = { count: 1, definitions: [], leaseMs: 1_000 };
	assert.equal(
		withWorkerSettings({}, { workflows: { localWorkers: invalid } }).localWorkers,
		invalid,
		"an out-of-range setting is refused by the run or resume that takes it, not by the merge",
	);
	const own = { count: 2, definitions: [] };
	assert.equal(withWorkerSettings({ localWorkers: own }, { workflows: { localWorkers: invalid } }).localWorkers, own);
	assert.equal(withWorkerSettings({}, { workflows: {} }).localWorkers, undefined);
	assert.equal(withWorkerSettings({}, { workflows: ["workflows"] }).localWorkers, undefined);
	assert.equal(withWorkerSettings({}, undefined).localWorkers, undefined);
});
