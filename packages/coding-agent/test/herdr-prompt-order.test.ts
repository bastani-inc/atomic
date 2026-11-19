import assert from "node:assert/strict";
import { test } from "vitest";
import { registerSlashCommands } from "../../subagents/src/slash/slash-commands.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("a slow prompt observer cannot leave Herdr blocked after the user answers", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();

	const observerEntered = deferred<void>();
	const observer = deferred<void>();
	const answer = deferred<boolean>();
	const slow = await loadExtensionFromFactory(
		(pi) => {
			pi.on("ui_prompt_start", () => {
				observerEntered.resolve();
				return observer.promise;
			});
		},
		fake.dir,
		createEventBus(),
		runtime,
		"slow-observer",
	);
	const herdr = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const runner = new ExtensionRunner([slow, herdr], runtime, fake.dir, SessionManager.inMemory(), {} as never);
	runner.setUIContext({ ...noOpUIContext, confirm: () => answer.promise }, "tui");
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		const decision = runner.getUIContext().confirm("Private decision", "Continue?");
		await observerEntered.promise;
		assert.equal(
			arg((await fake.waitFor(2))[1].args, "--state"),
			"blocked",
			"the open decision is visible despite a slow observer",
		);
		answer.resolve(true);
		assert.equal(await decision, true, "the answer must not wait for notification observers");
		assert.deepEqual(await runner.flushUIPromptNotifications(10), { timedOut: true });
		observer.resolve();
		assert.deepEqual(await runner.flushUIPromptNotifications(1_000), { timedOut: false });
		await fake.waitFor(3);
		const reports = (await fake.calls()).filter((call) => call.phase === "start" && call.args[1] === "report-agent");
		assert.equal(arg(reports.at(-1)!.args, "--state"), "idle", "no user decision remains outstanding");
		assert.equal(JSON.stringify(reports).includes("Private decision"), false);
	} finally {
		observer.resolve();
		answer.resolve(false);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});

test("the shipped /agents browser is navigation, not a user-decision wait", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();

	const herdr = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const catalog = await loadExtensionFromFactory(
		(pi) => registerSlashCommands(pi, {} as never),
		fake.dir,
		createEventBus(),
		runtime,
		"subagents",
	);
	const runner = new ExtensionRunner([herdr, catalog], runtime, fake.dir, SessionManager.inMemory(), {} as never);
	const mounted = deferred<void>();
	const close = deferred<void>();
	runner.setUIContext(
		{
			...noOpUIContext,
			custom: async (factory, options) => {
				mounted.resolve();
				await close.promise;
				return noOpUIContext.custom(factory, options);
			},
		},
		"tui",
	);
	try {
		await runner.emit({ type: "session_start" });
		await fake.waitFor(1);
		const viewing = runner.getCommand("agents")!.handler("debugger", runner.createCommandContext());
		await mounted.promise;
		await runner.flushUIPromptNotifications(1_000);
		// A fresh active-work event while the browser remains open must stay working.
		await runner.emit({ type: "agent_start" });
		assert.equal(arg((await fake.waitFor(2)).at(-1)!.args, "--state"), "working");
		await runner.emit({ type: "agent_settled" });
		assert.equal(arg((await fake.waitFor(3)).at(-1)!.args, "--state"), "idle");
		close.resolve();
		await viewing;
		await runner.flushUIPromptNotifications(1_000);
	} finally {
		close.resolve();
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		runner.invalidate();
		await fake.dispose();
	}
});
