import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test, vi } from "vitest";
import { claimPaneReporting, releasePaneReporting, reportPaneActivity } from "../src/extensions/herdr/pane-owner.js";
import { arg, FAKE_HERDR_CHILD_TIMEOUT_MS, fakeHerdr } from "./helpers/herdr.js";

test("report arriving in the microtask after a successful flight exits is not stranded and flush drains it", async () => {
	const fake = await fakeHerdr();
	const spy = vi.spyOn(childProcess, "execFile");
	const previous = spy.getMockImplementation()!;
	let queuedFollowUp = false;
	let owner!: Awaited<ReturnType<typeof claimPaneReporting>>;
	spy.mockImplementation((...args: Parameters<typeof childProcess.execFile>) => {
		const child = previous(...args);
		if (!queuedFollowUp) {
			queuedFollowUp = true;
			// execFile registers its own close handler before returning child, so this listener
			// runs right after resolve(undefined) queues the flight IIFE resumption microtask.
			// Queueing a microtask here places reportPaneActivity right between the IIFE exit
			// and any chained .finally() handler.
			child.once("close", () => {
				queueMicrotask(() => {
					reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
				});
			});
		}
		return child;
	});
	syncBuiltinESMExports();
	try {
		owner = await claimPaneReporting(fake.environment, { id: "parent" }, { timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS });
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await owner.flush();
		assert.equal(owner.pending, undefined);
		assert.equal(owner.flight, undefined);
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["working", "idle"],
		);
	} finally {
		spy.mockImplementation(previous);
		syncBuiltinESMExports();
		if (owner) await releasePaneReporting(owner);
		await fake.dispose();
	}
});

test("report queued from a microtask inside a failure diagnostic is delivered and drained by flush", async () => {
	const fake = await fakeHerdr('finish(args.includes("working") ? 1 : 0);');
	let owner!: Awaited<ReturnType<typeof claimPaneReporting>>;
	owner = await claimPaneReporting(
		fake.environment,
		{ id: "parent" },
		{
			timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
			diagnostic: () => {
				queueMicrotask(() => {
					reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
				});
			},
		},
	);
	try {
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await owner.flush();
		assert.equal(owner.pending, undefined);
		assert.equal(owner.flight, undefined);
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["working", "idle"],
		);
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

test("synchronous clock failure before transport does not leave owner.flight stuck", async () => {
	const fake = await fakeHerdr();
	let failOnce = true;
	const owner = await claimPaneReporting(
		fake.environment,
		{ id: "parent" },
		{
			timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
			clock: () => {
				if (failOnce) {
					failOnce = false;
					throw new Error("clock unavailable");
				}
				return 1000;
			},
		},
	);
	try {
		const rejected = new Promise<unknown>((resolve) => {
			const onUnhandled = (reason: unknown) => {
				process.off("unhandledRejection", onUnhandled);
				resolve(reason);
			};
			process.on("unhandledRejection", onUnhandled);
		});
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		const error = await rejected;
		assert.ok(error instanceof Error && error.message === "clock unavailable");
		assert.equal(owner.flight, undefined);
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		await owner.flush();
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["idle"],
		);
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});
