import assert from "node:assert/strict";
import { test } from "vitest";
import { executeHerdr } from "../src/extensions/herdr/transport.js";
import { FAKE_HERDR_CHILD_TIMEOUT_MS, FAKE_HERDR_EXPLICIT_TIMEOUT_MS, fakeHerdr } from "./helpers/herdr.js";

// #2913: exercise the Windows fixture launcher even on POSIX; this is not Windows OS validation.
async function windowsFake(body: string) {
	const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	try {
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		return await fakeHerdr(body);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
}

test("fake CLI preserves exact argv and socket through delayed completion", async () => {
	const nodeOptions = process.env.NODE_OPTIONS;
	const fake = await windowsFake("setTimeout(finish, 40);");
	try {
		const args = ["pane", "report-agent", "", " space path ", 'quote"value', "a&b|c;$(echo no)", "C:\\pane\\"];
		assert.equal(await executeHerdr(fake.environment, args, FAKE_HERDR_CHILD_TIMEOUT_MS), undefined);
		assert.deepEqual(await fake.calls(), [
			{ phase: "start", args, socket: fake.environment.socketPath },
			{ phase: "end", args, socket: fake.environment.socketPath },
		]);
		assert.equal(process.env.NODE_OPTIONS, nodeOptions);
	} finally {
		await fake.dispose();
		// The old Windows fixture mutated this globally; keep the red run isolated too.
		if (nodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = nodeOptions;
	}
});

// #2913: the hang branch must actually start, not fail main-module resolution.
test("fake CLI keeps a literal hang alive until the transport kills it", async () => {
	const fake = await windowsFake('if (args[0] === "hang") setInterval(() => {}, 1000); else finish(1);');
	try {
		const pending = executeHerdr(fake.environment, ["hang"], FAKE_HERDR_EXPLICIT_TIMEOUT_MS);
		await fake.waitForStarted(1);
		fake.expireInFlight(FAKE_HERDR_EXPLICIT_TIMEOUT_MS);
		assert.deepEqual(await pending, { kind: "timeout" });
		assert.deepEqual(await fake.calls(), [{ phase: "start", args: ["hang"], socket: fake.environment.socketPath }]);
	} finally {
		await fake.dispose();
	}
});

// #2913: disposing one fixture must not redirect or disable another fixture.
test("fake CLI registrations are isolated and removed on disposal", async () => {
	const first = await fakeHerdr();
	const second = await fakeHerdr();
	try {
		assert.equal(await executeHerdr(first.environment, ["pane"], FAKE_HERDR_CHILD_TIMEOUT_MS), undefined);
		await first.dispose();
		assert.deepEqual(await executeHerdr(first.environment, ["pane"], FAKE_HERDR_CHILD_TIMEOUT_MS), {
			kind: "spawn_failed",
		});
		assert.equal(await executeHerdr(second.environment, ["other"], FAKE_HERDR_CHILD_TIMEOUT_MS), undefined);
		assert.deepEqual(
			(await second.calls()).map((call) => call.args),
			[["other"], ["other"]],
		);
	} finally {
		await first.dispose();
		await second.dispose();
	}
	assert.deepEqual(await executeHerdr(second.environment, ["other"], FAKE_HERDR_CHILD_TIMEOUT_MS), {
		kind: "spawn_failed",
	});
});
