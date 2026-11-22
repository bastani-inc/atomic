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
			// and the chained .finally() settlement handler.
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

test("synchronous throw before transport preserves promise ownership for flush, release, and superseding claim", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const fake = await fakeHerdr();
	try {
		// P1: throwing clock() + flush() rejects with the exact Error, clears owner.flight, and allows follow-ups.
		{
			const boom = new Error("clock unavailable");
			let failOnce = true;
			const owner = await claimPaneReporting(
				{ ...fake.environment, paneId: `${fake.dir}-p1` },
				{ id: "p1" },
				{
					timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
					clock: () => {
						if (failOnce) {
							failOnce = false;
							throw boom;
						}
						return 1000;
					},
				},
			);
			reportPaneActivity(owner, { state: "working", reason: "executing" });
			assert.notEqual(owner.flight, undefined);
			await assert.rejects(
				() => owner.flush(),
				(err: unknown) => err === boom,
			);
			assert.equal(owner.flight, undefined);
			reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
			await owner.flush();
			assert.deepEqual(
				(await fake.calls())
					.filter((call) => call.phase === "start" && call.args[2] === `${fake.dir}-p1`)
					.map((call) => arg(call.args, "--state")),
				["idle"],
			);
			await releasePaneReporting(owner);
		}

		// P2: throwing clock() + immediate releasePaneReporting() rejects with the exact Error.
		{
			const boom = new Error("clock unavailable on release");
			const owner = await claimPaneReporting(
				{ ...fake.environment, paneId: `${fake.dir}-p2` },
				{ id: "p2" },
				{
					timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
					clock: () => {
						throw boom;
					},
				},
			);
			reportPaneActivity(owner, { state: "working", reason: "executing" });
			assert.notEqual(owner.flight, undefined);
			await assert.rejects(
				() => releasePaneReporting(owner),
				(err: unknown) => err === boom,
			);
			assert.equal(owner.flight, undefined);
		}

		// P3: throwing identity getter before transport + flush() rejects with the exact Error.
		{
			const boom = new Error("resume getter boom");
			const identity = {
				id: "p3",
				get resume(): string[] {
					throw boom;
				},
			};
			const owner = await claimPaneReporting({ ...fake.environment, paneId: `${fake.dir}-p3` }, identity, {
				timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
			});
			reportPaneActivity(owner, { state: "working", reason: "executing" });
			assert.notEqual(owner.flight, undefined);
			await assert.rejects(
				() => owner.flush(),
				(err: unknown) => err === boom,
			);
			assert.equal(owner.flight, undefined);
			await releasePaneReporting(owner);
		}

		// P6: throwing clock() + superseding claimPaneReporting() rejects with the exact Error.
		{
			const boom = new Error("clock unavailable on supersede");
			const paneEnv = { ...fake.environment, paneId: `${fake.dir}-p6` };
			const owner1 = await claimPaneReporting(
				paneEnv,
				{ id: "p6-1" },
				{
					timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
					clock: () => {
						throw boom;
					},
				},
			);
			reportPaneActivity(owner1, { state: "working", reason: "executing" });
			assert.notEqual(owner1.flight, undefined);
			await assert.rejects(
				() => claimPaneReporting(paneEnv, { id: "p6-2" }),
				(err: unknown) => err === boom,
			);
			assert.equal(owner1.flight, undefined);
		}

		// Sync throw with a second synchronously queued report does not spawn an unawaited rejecting successor.
		{
			const boom = new Error("persistent clock failure");
			const owner = await claimPaneReporting(
				{ ...fake.environment, paneId: `${fake.dir}-p7` },
				{ id: "p7" },
				{
					timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
					clock: () => {
						throw boom;
					},
				},
			);
			reportPaneActivity(owner, { state: "working", reason: "executing" });
			reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
			await assert.rejects(
				() => owner.flush(),
				(err: unknown) => err === boom,
			);
			assert.equal(owner.flight, undefined);
			assert.equal(owner.pending, undefined);
		}

		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await fake.dispose();
	}
});

test("intervening microtask flush after a throwing diagnostic rejects with the thrown error", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const fake = await fakeHerdr('finish(args.includes("working") ? 1 : 0);');
	try {
		const boom = new Error("diag boom");
		let threw = false;
		let flushOutcome: Promise<{ outcome: "resolved" } | { outcome: "rejected"; sameIdentity: boolean }> | undefined;
		let owner!: Awaited<ReturnType<typeof claimPaneReporting>>;
		owner = await claimPaneReporting(
			fake.environment,
			{ id: "p4b" },
			{
				timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
				diagnostic: () => {
					if (!threw) {
						threw = true;
						queueMicrotask(() => {
							flushOutcome = owner.flush().then(
								() => ({ outcome: "resolved" as const }),
								(err: unknown) => ({ outcome: "rejected" as const, sameIdentity: err === boom }),
							);
						});
						throw boom;
					}
				},
			},
		);
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await vi.waitFor(() => assert.notEqual(flushOutcome, undefined), { timeout: FAKE_HERDR_CHILD_TIMEOUT_MS });
		assert.deepEqual(await flushOutcome, { outcome: "rejected", sameIdentity: true });
		assert.equal(owner.flight, undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(unhandled, []);
		await releasePaneReporting(owner);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await fake.dispose();
	}
});

test("flush stops after its handoff chain and does not spin on external owner.flight.then chains", async () => {
	const fake = await fakeHerdr();
	try {
		// L1e: infinite chain attached via owner.flight.then() before flush() must not trap flush().
		{
			const owner = await claimPaneReporting(
				{ ...fake.environment, paneId: `${fake.dir}-l1e` },
				{ id: "l1e" },
				{ timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS },
			);
			let stopped = false;
			let chained = 0;
			try {
				reportPaneActivity(owner, { state: "working", reason: "executing" });
				const chain = () => {
					if (stopped) return;
					chained++;
					reportPaneActivity(
						owner,
						chained % 2 ? { state: "idle", reason: "quiescent" } : { state: "working", reason: "executing" },
					);
					owner.flight?.then(chain);
				};
				owner.flight!.then(chain);
				const outcome = await Promise.race([
					owner.flush().then(() => "flushed"),
					new Promise<string>((resolve) => setTimeout(() => resolve("spinning"), 500)),
				]);
				stopped = true;
				assert.equal(outcome, "flushed");
				assert.equal(chained, 1);
			} finally {
				stopped = true;
				await releasePaneReporting(owner);
			}
		}

		// L1d: two concurrent flushers where f1.then() starts a new report do not trap f2.
		{
			const owner = await claimPaneReporting(
				{ ...fake.environment, paneId: `${fake.dir}-l1d` },
				{ id: "l1d" },
				{ timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS },
			);
			try {
				reportPaneActivity(owner, { state: "working", reason: "executing" });
				const f1 = owner.flush();
				const f2 = owner.flush();
				let f2SettledWhileFlight2Active = false;
				const p1 = f1.then(() => {
					reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
				});
				const p2 = f2.then(() => {
					f2SettledWhileFlight2Active = owner.flight !== undefined;
				});
				await Promise.all([p1, p2]);
				assert.equal(f2SettledWhileFlight2Active, true);
				await owner.flush();
			} finally {
				await releasePaneReporting(owner);
			}
		}
	} finally {
		await fake.dispose();
	}
});

test("redundant skipUnchanged report arriving in the handoff microtask is cleared without an extra flight or transport call", async () => {
	const fake = await fakeHerdr();
	const spy = vi.spyOn(childProcess, "execFile");
	const previous = spy.getMockImplementation()!;
	let queuedFollowUp = false;
	let owner!: Awaited<ReturnType<typeof claimPaneReporting>>;
	spy.mockImplementation((...args: Parameters<typeof childProcess.execFile>) => {
		const child = previous(...args);
		if (!queuedFollowUp) {
			queuedFollowUp = true;
			child.once("close", () => {
				queueMicrotask(() => {
					reportPaneActivity(owner, { state: "working", reason: "executing" }, true);
				});
			});
		}
		return child;
	});
	syncBuiltinESMExports();
	try {
		owner = await claimPaneReporting(fake.environment, { id: "parent" }, { timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS });
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		let flightAtSettlement: Promise<void> | undefined;
		await owner.flight!.then(() => {
			flightAtSettlement = owner.flight;
		});
		assert.equal(flightAtSettlement, undefined);
		assert.equal(owner.pending, undefined);
		assert.equal(owner.flight, undefined);
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["working"],
		);
	} finally {
		spy.mockImplementation(previous);
		syncBuiltinESMExports();
		if (owner) await releasePaneReporting(owner);
		await fake.dispose();
	}
});

test("pending report queued during a failing flight drains within the same flight before it settles", async () => {
	const fake = await fakeHerdr('finish(args.includes("working") ? 1 : 0);');
	const spy = vi.spyOn(childProcess, "execFile");
	const previous = spy.getMockImplementation()!;
	let callIndex = 0;
	let flightDuringSecondCall: Promise<void> | undefined;
	let owner!: Awaited<ReturnType<typeof claimPaneReporting>>;
	spy.mockImplementation((...args: Parameters<typeof childProcess.execFile>) => {
		callIndex++;
		if (callIndex === 2) flightDuringSecondCall = owner.flight;
		return previous(...args);
	});
	syncBuiltinESMExports();
	try {
		owner = await claimPaneReporting(fake.environment, { id: "parent" }, { timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS });
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		const firstFlight = owner.flight!;
		await firstFlight;
		assert.equal(flightDuringSecondCall, firstFlight);
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

test("synchronous throw inside a handoff successor flight rejects flush with exact error and no unhandled rejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const fake = await fakeHerdr('finish(args.includes("working") ? 1 : 0);');
	try {
		const boom = new Error("clock boom on handoff");
		let clockCalls = 0;
		let owner!: Awaited<ReturnType<typeof claimPaneReporting>>;
		owner = await claimPaneReporting(
			fake.environment,
			{ id: "p8" },
			{
				timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
				clock: () => {
					clockCalls++;
					if (clockCalls === 2) throw boom;
					return 1000 + clockCalls;
				},
				diagnostic: () => {
					queueMicrotask(() => {
						reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
					});
				},
			},
		);
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await assert.rejects(
			() => owner.flush(),
			(err: unknown) => err === boom,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(clockCalls, 2);
		assert.equal(owner.flight, undefined);
		assert.equal(owner.pending, undefined);
		assert.deepEqual(unhandled, []);
		await releasePaneReporting(owner);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await fake.dispose();
	}
});

test("diagnostic throw while a pending report is queued surfaces the error and does not strand owner.pending", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	const fake = await fakeHerdr('finish(args.includes("working") ? 1 : 0);');
	try {
		const boom = new Error("diag boom with pending");
		let threw = false;
		const owner = await claimPaneReporting(
			fake.environment,
			{ id: "diag-pending" },
			{
				timeoutMs: FAKE_HERDR_CHILD_TIMEOUT_MS,
				diagnostic: () => {
					if (!threw) {
						threw = true;
						throw boom;
					}
				},
			},
		);
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		await assert.rejects(
			() => owner.flush(),
			(err: unknown) => err === boom,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(owner.flight, undefined);
		assert.equal(owner.pending, undefined);
		assert.deepEqual(unhandled, []);
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		await owner.flush();
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["working", "idle"],
		);
		await releasePaneReporting(owner);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await fake.dispose();
	}
});
