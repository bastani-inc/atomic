import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { withMandatoryResourceLoader } from "../src/core/mandatory-resource-loader.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { claimPaneReporting, releasePaneReporting, reportPaneActivity } from "../src/extensions/herdr/pane-owner.js";
import type { HerdrDiagnostic } from "../src/extensions/herdr/transport.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";
import { createFauxStreamFn, createHarnessWithExtensions, fauxModel } from "./test-harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

// Regression coverage for Herdr ownership fixes in PR #2925 (reporter RFC #2891).
// A supplied resource loader can expose the same loaded extension to multiple runners.
// Eligibility at session_start must not grant a child's later shutdown parent authority.
test("shared reporter ignores child shutdown and keeps reporting for its parent", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();
	const publisher = runtime.workflowActivityHub.registerWorkflowActivityPublisher();
	publisher.publishSnapshot({ availability: "ready", roots: [] });
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const parentSession = SessionManager.create(fake.dir, fake.dir);
	const parent = new ExtensionRunner([extension], runtime, fake.dir, parentSession, {} as never);
	parent.setUIContext({ ...noOpUIContext }, "tui");
	const child = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		fake.dir,
		SessionManager.inMemory(),
		{} as never,
		undefined,
		{ managementActions: "restricted", fanoutAuthorized: false, inheritProjectContext: true, inheritSkills: true },
	);
	child.setUIContext(undefined, "print");
	try {
		await parent.emit({ type: "session_start" });
		await fake.waitFor(1);
		await child.emit({ type: "session_start" });
		await child.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(
			(await fake.calls()).some((call) => call.args[1] === "release-agent"),
			false,
		);
		await parent.emit({ type: "agent_start" });
		const calls = await fake.waitFor(2);
		assert.equal(arg(calls[1].args, "--state"), "working");
		assert.equal(arg(calls[0].args, "--agent-session-id"), parentSession.getSessionId());
		assert.equal(arg(calls[0].args, "--agent-session-path"), parentSession.getSessionFile());
	} finally {
		await parent.emit({ type: "session_shutdown", reason: "quit" });
		parent.invalidate();
		child.invalidate();
		await fake.dispose();
	}
});

test("shared reporter accepts activity only from the first eligible session", async () => {
	const fake = await fakeHerdr();
	const runtime = createExtensionRuntime();
	const publisher = runtime.workflowActivityHub.registerWorkflowActivityPublisher();
	publisher.publishSnapshot({ availability: "ready", roots: [] });
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const session = SessionManager.inMemory();
	const parent = new ExtensionRunner([extension], runtime, fake.dir, session, {} as never);
	parent.setUIContext({ ...noOpUIContext }, "tui");
	const foreign = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		fake.dir,
		SessionManager.inMemory(),
		{} as never,
	);
	foreign.setUIContext({ ...noOpUIContext }, "tui");
	try {
		// Unstarted runners must not leave an approval contribution for the future owner.
		await foreign.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await parent.emit({ type: "session_start" });
		await fake.waitFor(1);
		await foreign.emit({ type: "session_start" });
		await foreign.emit({ type: "agent_start" });
		await foreign.emit({ type: "agent_settled" });
		await foreign.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await foreign.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await foreign.emit({ type: "session_shutdown", reason: "quit" });
		await parent.emit({ type: "agent_start" });
		await fake.waitFor(2);
		await parent.emit({ type: "session_shutdown", reason: "quit" });
		// Quit is terminal: late state/prompt events must not reclaim authority.
		await parent.emit({ type: "agent_start" });
		await parent.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "report-agent", "release-agent"],
		);
		assert.deepEqual(
			calls.map((call) => arg(call.args, "--state")),
			["idle", "working", undefined],
		);
		assert.equal(arg(calls[0].args, "--agent-session-id"), session.getSessionId());
	} finally {
		await parent.emit({ type: "session_shutdown", reason: "quit" });
		await foreign.emit({ type: "session_shutdown", reason: "quit" });
		parent.invalidate();
		foreign.invalidate();
		await fake.dispose();
	}
});

test("real compaction and continued prompts retain pane authority until quit", async () => {
	const fake = await fakeHerdr();
	const lifecycle: string[] = [];
	const harness = await createHarnessWithExtensions({
		settings: { compaction: { enabled: false }, sessionSummary: { enabled: false } },
		responses: [
			{
				text: "First answer\nKeep this context",
				beforeEmit: async () => {
					await fake.waitFor(2);
				},
			},
			{
				text: "Continued after compaction",
				beforeEmit: async () => {
					await fake.waitFor(4);
				},
			},
		],
		extensionFactories: [
			createHerdrExtension({ env: fake.env, enabled: () => true }),
			(pi) => {
				const publisher = pi.registerWorkflowActivityPublisher();
				publisher.publishSnapshot({ availability: "ready", roots: [] });
				pi.on("session_start", () => {
					lifecycle.push("start");
				});
				pi.on("session_shutdown", () => {
					lifecycle.push("shutdown");
				});
				pi.on("session_before_compact", (event) => ({ compactedText: event.preparation.region.lines.join("\n") }));
				pi.on("session_compact", () => {
					lifecycle.push("compact");
				});
			},
		],
	});
	try {
		await harness.session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
		await fake.waitFor(1);
		// Manual compaction requires at least twenty compactable transcript lines.
		await harness.session.prompt(Array.from({ length: 25 }, (_, index) => `Task detail ${index}`).join("\n"));
		await fake.waitFor(3);
		const identity = harness.sessionManager.getSessionId();
		const result = await harness.session.compact({ preserve_recent: 0 });
		assert.equal(result.rung, "extension");
		assert.equal(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length, 1);
		assert.deepEqual(lifecycle, ["start", "compact"]);
		assert.equal((await fake.calls()).filter((call) => call.phase === "start").length, 3);
		await harness.session.prompt("Continue working");
		await fake.waitFor(5);
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => arg(call.args, "--state")),
			["idle", "working", "idle", "working", "idle", undefined],
		);
		assert.equal(calls.at(-1)?.args[1], "release-agent");
		assert.equal(arg(calls[0].args, "--agent-session-id"), identity);
		assert.equal(calls.filter((call) => call.args.includes("--agent-session-id")).length, 1);
		assert.deepEqual(lifecycle, ["start", "compact", "shutdown"]);
	} finally {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
		await fake.dispose();
	}
});

test("child shutdown cannot cancel a parent claim waiting for a timed-out predecessor", async () => {
	const fake = await fakeHerdr('if (args.includes("predecessor")) setInterval(() => {}, 1000); else finish();');
	const diagnostics: HerdrDiagnostic[] = [];
	const previous = await claimPaneReporting(
		fake.environment,
		{ id: "predecessor" },
		{
			timeoutMs: 1500,
			diagnostic: (value) => diagnostics.push(value),
		},
	);
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const parent = new ExtensionRunner([extension], runtime, fake.dir, SessionManager.inMemory(), {} as never);
	parent.setUIContext({ ...noOpUIContext }, "tui");
	const child = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		fake.dir,
		SessionManager.inMemory(),
		{} as never,
	);
	try {
		reportPaneActivity(previous, { state: "working", reason: "executing" });
		const starting = parent.emit({ type: "session_start" });
		await child.emit({ type: "session_shutdown", reason: "quit" });
		await starting;
		await parent.emit({ type: "agent_start" });
		await fake.waitFor(1); // parent working (hung predecessor report has no end)
		await parent.emit({ type: "session_shutdown", reason: "quit" });
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "report-agent", "release-agent"],
		);
		assert.deepEqual(diagnostics, [{ kind: "timeout" }]);
		for (let index = 0; index < calls.length; index++) {
			const args = calls[index].args;
			const seq = arg(args, "--seq")!;
			if (index) assert.ok(Number(seq) > Number(arg(calls[index - 1].args, "--seq")));
			assert.deepEqual(args, [
				"pane",
				index === 2 ? "release-agent" : "report-agent",
				fake.environment.paneId,
				"--source",
				"custom:atomic",
				"--agent",
				"atomic",
				"--seq",
				seq,
				...(index === 2
					? []
					: [
							"--state",
							"working",
							"--agent-session-id",
							index === 0 ? "predecessor" : parent.createContext().sessionManager.getSessionId(),
						]),
			]);
			assert.equal(calls[index].socket, fake.environment.socketPath);
		}
	} finally {
		await parent.emit({ type: "session_shutdown", reason: "quit" });
		await releasePaneReporting(previous);
		parent.invalidate();
		child.invalidate();
		await fake.dispose();
	}
});

// SDK callers may retain an already-loaded ResourceLoader across session replacement.
test("SDK successor reuses the loaded reporter after owning shutdown and continues prompting", async () => {
	const fake = await fakeHerdr();
	try {
		const extensionsResult = await createTestExtensionsResult(
			[createHerdrExtension({ env: fake.env, enabled: () => true })],
			fake.dir,
		);
		const resourceLoader = await withMandatoryResourceLoader(
			createTestResourceLoader({ extensionsResult }),
			fake.dir,
		);
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(fake.dir, "auth.json") });
		const faux = createFauxStreamFn(["First answer", "Successor answer"]);
		modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: fauxModel.api,
			models: [fauxModel],
			streamSimple: faux.streamFn,
		});
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			sessionSummary: { enabled: false },
		});
		const managers = [SessionManager.create(fake.dir, fake.dir), SessionManager.create(fake.dir, fake.dir)];
		for (const [index, sessionManager] of managers.entries()) {
			const { session } = await createAgentSession({
				cwd: fake.dir,
				agentDir: fake.dir,
				resourceLoader,
				modelRuntime,
				settingsManager,
				sessionManager,
				model: fauxModel,
				noTools: "all",
				sessionStartEvent: { type: "session_start", reason: index === 0 ? "startup" : "new" },
				// #3105: the reporter needs presentation capability during factory startup.
				extensionBindings: { mode: "tui", uiContext: { ...noOpUIContext } },
			});
			try {
				await session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
				await session.prompt(index === 0 ? "First turn" : "Continue working in the successor");
				assert.equal(session.agent.state.errorMessage, undefined);
				assert.deepEqual(session.messages.at(-1)?.content, [
					{ type: "text", text: index === 0 ? "First answer" : "Successor answer" },
				]);
			} finally {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: index === 0 ? "new" : "quit" });
				await session.dispose();
			}
		}
		assert.equal(faux.state.callCount, 2, "two successful deterministic prompts, without network or retries");
		const calls = (await fake.calls()).filter((call) => call.phase === "start");
		assert.deepEqual(
			calls.map((call) => call.args[1]),
			["report-agent", "report-agent", "release-agent"],
		);
		for (const [index, call] of calls.entries()) {
			const seq = arg(call.args, "--seq")!;
			if (index) assert.ok(Number(seq) > Number(arg(calls[index - 1].args, "--seq")));
			const manager = managers[Math.min(index, 1)];
			assert.deepEqual(call.args, [
				"pane",
				index === 2 ? "release-agent" : "report-agent",
				fake.environment.paneId,
				"--source",
				"custom:atomic",
				"--agent",
				"atomic",
				"--seq",
				seq,
				...(index === 2
					? []
					: [
							"--state",
							"working",
							"--agent-session-id",
							manager.getSessionId(),
							"--agent-session-path",
							manager.getSessionFile()!,
						]),
			]);
			assert.equal(call.socket, fake.environment.socketPath);
		}
	} finally {
		await fake.dispose();
	}
});

test("shared reporter admits a successor during shutdown drain without stale predecessor interference", async () => {
	const fake = await fakeHerdr(`
if (args.includes("working")) {
	const timer = setInterval(() => {
		if (fs.existsSync(require("node:path").join(args[2], "allow-release"))) {
			clearInterval(timer);
			finish();
		}
	}, 5);
} else finish();`);
	const runtime = createExtensionRuntime();
	const publisher = runtime.workflowActivityHub.registerWorkflowActivityPublisher();
	publisher.publishSnapshot({ availability: "ready", roots: [] });
	const extension = await loadExtensionFromFactory(
		createHerdrExtension({ env: fake.env, enabled: () => true, clock: () => 100 }),
		fake.dir,
		createEventBus(),
		runtime,
		"herdr",
	);
	const managers = [SessionManager.create(fake.dir, fake.dir), SessionManager.create(fake.dir, fake.dir)];
	const [previous, successor] = managers.map((manager) => {
		const runner = new ExtensionRunner([extension], runtime, fake.dir, manager, {} as never);
		runner.setUIContext({ ...noOpUIContext }, "tui");
		return runner;
	});
	const foreign = new ExtensionRunner([extension], runtime, fake.dir, SessionManager.inMemory(), {} as never);
	foreign.setUIContext({ ...noOpUIContext }, "tui");
	let stopping: Promise<void> | undefined;
	let starting: Promise<undefined> | undefined;
	try {
		await previous.emit({ type: "session_start" });
		await fake.waitFor(1);
		// An eligible foreign session still cannot take over before owning shutdown.
		await successor.emit({ type: "session_start", reason: "new" });
		await successor.emit({ type: "agent_start" });
		await successor.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await successor.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal((await fake.calls()).length, 2);
		await previous.emit({ type: "agent_start" });
		// The "working" report is held open until allow-release, so wait for it to start.
		await fake.waitForStarted(2);
		let stopped = false;
		stopping = previous.emit({ type: "session_shutdown", reason: "new" }).then(() => {
			stopped = true;
		});
		await Promise.resolve();
		starting = successor.emit({ type: "session_start", reason: "new" });
		// The new binding must already be reserved while its claim waits for the old report.
		await foreign.emit({ type: "session_start" });
		await foreign.emit({ type: "session_shutdown", reason: "quit" });
		await previous.emit({ type: "agent_start" });
		await previous.emit({ type: "session_shutdown", reason: "reload" });
		assert.equal(stopped, false, "owning shutdown must await the in-flight report");
		assert.equal((await fake.calls()).length, 3, "successor transport must wait for the predecessor report");
		await writeFile(join(fake.dir, "allow-release"), "");
		await Promise.all([stopping, starting]);
		await fake.waitFor(3);
		await successor.emit({ type: "agent_start" });
		await fake.waitFor(4);
		await successor.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await fake.waitFor(5);
		// Delayed predecessor events, including another start/shutdown, remain foreign.
		await previous.emit({ type: "session_start", reason: "reload" });
		await previous.emit({ type: "agent_settled" });
		await previous.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await previous.emit({ type: "session_shutdown", reason: "quit" });
		await successor.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await fake.waitFor(6);
		await successor.emit({ type: "agent_settled" });
		await fake.waitFor(7);
		await successor.emit({ type: "session_shutdown", reason: "quit" });
		await successor.emit({ type: "agent_start" });
		const records = await fake.calls();
		assert.deepEqual(
			records.map((call) => call.phase),
			Array.from({ length: 8 }, () => ["start", "end"]).flat(),
		);
		const calls = records.filter((call) => call.phase === "start");
		const states = ["idle", "working", "idle", "working", "blocked", "working", "idle", undefined];
		for (const [index, call] of calls.entries()) {
			const seq = arg(call.args, "--seq")!;
			if (index) assert.ok(Number(seq) > Number(arg(calls[index - 1].args, "--seq")));
			const manager = index === 0 ? managers[0] : index === 2 ? managers[1] : undefined;
			assert.deepEqual(call.args, [
				"pane",
				states[index] ? "report-agent" : "release-agent",
				fake.environment.paneId,
				"--source",
				"custom:atomic",
				"--agent",
				"atomic",
				"--seq",
				seq,
				...(states[index] ? ["--state", states[index]] : []),
				...(index === 4 ? ["--message", "Waiting for approval"] : []),
				...(manager
					? ["--agent-session-id", manager.getSessionId(), "--agent-session-path", manager.getSessionFile()!]
					: []),
			]);
			assert.equal(call.socket, fake.environment.socketPath);
		}
	} finally {
		await writeFile(join(fake.dir, "allow-release"), "");
		await Promise.all([stopping, starting]);
		for (const runner of [previous, successor, foreign]) {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			runner.invalidate();
		}
		await fake.dispose();
	}
});
