import assert from "node:assert/strict";
import { test } from "vitest";
import { claimPaneReporting, releasePaneReporting, reportPaneActivity } from "../src/extensions/herdr/pane-owner.js";
import { executeHerdr, HERDR_TIMEOUT_MS, type HerdrDiagnostic } from "../src/extensions/herdr/transport.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";

// #2891: all subprocess tests use disposable executables, never Herdr.
test("pane ownership serializes and coalesces reports across replacement and clock rollback", async () => {
	const fake = await fakeHerdr("setTimeout(finish, 40);");
	const environment = { ...fake.environment, paneId: "w1:p1; rm -rf /" };
	const diagnostics: HerdrDiagnostic[] = [];
	let clock = 1000;
	const options = { clock: () => clock, diagnostic: (value: HerdrDiagnostic) => diagnostics.push(value) };
	const owner = await claimPaneReporting(environment, { id: "parent", path: `${fake.dir}/parent.jsonl` }, options);
	try {
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		reportPaneActivity(owner, { state: "blocked", reason: "awaiting_input", message: "Waiting for approval" });
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		await owner.flush();
		clock = 1;
		const successor = await claimPaneReporting(environment, { id: "parent2", path: "relative.jsonl" }, options);
		try {
			reportPaneActivity(owner, { state: "working", reason: "executing" });
			await releasePaneReporting(owner);
			reportPaneActivity(successor, { state: "working", reason: "executing" });
			reportPaneActivity(successor, { state: "blocked", reason: "awaiting_input" });
			// Retirement discards the pending blocked report but drains working first.
			await releasePaneReporting(successor);
		} finally {
			await releasePaneReporting(successor);
		}
		const lifetime = await fake.calls();
		assert.deepEqual(
			lifetime.map((call) => call.phase),
			Array.from({ length: 4 }, () => ["start", "end"]).flat(),
		);
		const calls = lifetime.filter((call) => call.phase === "start").map((call) => call.args);
		assert.deepEqual(
			calls.map((args) => args[1]),
			["report-agent", "report-agent", "report-agent", "release-agent"],
		);
		assert.deepEqual(
			calls.filter((args) => args[1] === "report-agent").map((args) => arg(args, "--state")),
			["working", "idle", "working"],
		);

		for (const args of calls) {
			assert.equal(args[2], "w1:p1; rm -rf /");
			assert.equal(arg(args, "--source"), "custom:atomic");
			assert.equal(arg(args, "--agent"), "atomic");
		}
		const seq = calls.map((args) => Number(arg(args, "--seq")));
		// Release carries its own sequence: Herdr 0.8.2 ignores an equal or older `--seq`, so a release that
		// reused the last report's sequence would leave the pane claimed after quit.
		for (let index = 1; index < seq.length; index += 1) assert.ok(seq[index]! > seq[index - 1]!);
		assert.equal(calls.filter((args) => args.includes("--agent-session-id")).length, 2);
		assert.equal(arg(calls[2], "--agent-session-path"), undefined);
		assert.ok(diagnostics.some((value) => value.kind === "stale_owner"));
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

test("skipping a delivered snapshot does not discard the next explicit activity report (#3468)", async () => {
	const fake = await fakeHerdr();
	const owner = await claimPaneReporting(fake.environment, { id: "parent" });
	try {
		const idle = { state: "idle", reason: "quiescent" } as const;
		reportPaneActivity(owner, idle);
		await owner.flush();
		reportPaneActivity(owner, idle, true);
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await owner.flush();
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["idle", "working"],
		);
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

test("an identical snapshot preserves an explicit refresh queued during delivery (#3468)", async () => {
	const fake = await fakeHerdr();
	const owner = await claimPaneReporting(fake.environment, { id: "parent" });
	try {
		const working = { state: "working", reason: "executing" } as const;
		reportPaneActivity(owner, working);
		reportPaneActivity(owner, working);
		reportPaneActivity(owner, working, true);
		await owner.flush();
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
			["working", "working"],
		);
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

for (const queuedDuringFlight of [false, true]) {
	test(`returning to an earlier snapshot retries after lost delivery ${queuedDuringFlight ? "during" : "after"} the flight (#3468)`, async () => {
		const fake = await fakeHerdr('if (args.includes("working")) setInterval(() => {}, 1000); else finish();');
		const diagnostics: HerdrDiagnostic[] = [];
		const owner = await claimPaneReporting(
			fake.environment,
			{ id: "parent" },
			{
				timeoutMs: 1000,
				diagnostic: (value) => diagnostics.push(value),
			},
		);
		try {
			const idle = { state: "idle", reason: "quiescent" } as const;
			reportPaneActivity(owner, idle, true);
			await owner.flush();
			reportPaneActivity(owner, { state: "working", reason: "executing" }, true);
			await fake.waitForStarted(2);
			if (!queuedDuringFlight) await owner.flush();
			reportPaneActivity(owner, idle, true);
			await owner.flush();
			assert.deepEqual(diagnostics, [{ kind: "timeout" }]);
			assert.deepEqual(
				(await fake.calls()).filter((call) => call.phase === "start").map((call) => arg(call.args, "--state")),
				["idle", "working", "idle"],
			);
		} finally {
			await releasePaneReporting(owner);
			await fake.dispose();
		}
	});
}

// #2891: failed delivery must not consume the claim's parent identity.
test("pane reporting retries identity until success", async () => {
	const fake = await fakeHerdr('finish(args.includes("working") ? 1 : 0);');
	const diagnostics: HerdrDiagnostic[] = [];
	const identity = { id: "parent", path: `${fake.dir}/parent.jsonl` };
	const owner = await claimPaneReporting(fake.environment, identity, {
		diagnostic: (value) => diagnostics.push(value),
	});
	try {
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await owner.flush();
		reportPaneActivity(owner, { state: "idle", reason: "quiescent" });
		await owner.flush();
		reportPaneActivity(owner, { state: "blocked", reason: "awaiting_input" });
		await owner.flush();
		await releasePaneReporting(owner);
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => arg(call.args, "--agent-session-id")),
			["parent", "parent", undefined, undefined],
		);
		assert.deepEqual(
			calls.map((call) => arg(call.args, "--agent-session-path")),
			[identity.path, identity.path, undefined, undefined],
		);
		assert.deepEqual(diagnostics, [{ kind: "protocol_rejected" }]);
		assert.equal(calls.at(-1)?.args[1], "release-agent");
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

// #2891: a failed response does not prove that Herdr never accepted authority.
test("pane reporting releases after a failed report even without confirmed identity", async () => {
	const fake = await fakeHerdr("finish(1);");
	const owner = await claimPaneReporting(fake.environment, { id: "parent" });
	try {
		reportPaneActivity(owner, { state: "working", reason: "executing" });
		await owner.flush();
		await releasePaneReporting(owner);
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "release-agent"],
		);
		assert.ok(Number(arg(calls[1].args, "--seq")) > Number(arg(calls[0].args, "--seq")));
	} finally {
		await releasePaneReporting(owner);
		await fake.dispose();
	}
});

// #2891: raw child output never becomes a diagnostic body.
test("transport distinguishes spawn, timeout and protocol failures without exposing output", async () => {
	assert.equal(HERDR_TIMEOUT_MS, 5_000);
	const fake = await fakeHerdr(
		'if (args.includes("hang")) setInterval(() => {}, 1000); else { process.stderr.write("secret error body"); finish(1); }',
	);
	try {
		assert.deepEqual(await executeHerdr({ ...fake.environment, bin: `${fake.dir}/missing` }, [], 50), {
			kind: "spawn_failed",
		});
		assert.deepEqual(await executeHerdr(fake.environment, [], 1000), { kind: "protocol_rejected" });
		assert.deepEqual(await executeHerdr(fake.environment, ["hang"], 50), { kind: "timeout" });
		assert.deepEqual(await executeHerdr({ ...fake.environment, bin: "invalid\0path" }, []), { kind: "spawn_failed" });
	} finally {
		await fake.dispose();
	}
});
