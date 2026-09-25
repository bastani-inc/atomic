import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createHerdrExtension } from "../src/extensions/herdr/index.js";
import { arg, fakeHerdr } from "./helpers/herdr.js";
import { createFauxStreamFn, fauxModel } from "./test-harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

type HerdrFixture = Awaited<ReturnType<typeof fakeHerdr>>;

async function closeSessionThenFixture(session: AgentSession, fake: HerdrFixture): Promise<void> {
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await session.dispose();
	} finally {
		await fake.dispose();
	}
}

test("herdr SDK cleanup removes the fixture only after disposal persists the session", async () => {
	const fake = await fakeHerdr();
	try {
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(fake.dir, "auth.json") });
		const faux = createFauxStreamFn([{ text: "Persisted before cleanup" }]);
		modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: fauxModel.api,
			models: [fauxModel],
			streamSimple: faux.streamFn,
		});
		const sessionManager = SessionManager.create(fake.dir, fake.dir);
		const { session } = await createAgentSession({
			cwd: fake.dir,
			agentDir: fake.dir,
			resourceLoader: createTestResourceLoader(),
			modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				sessionSummary: { enabled: false },
			}),
			model: fauxModel,
			noTools: "all",
		});
		await session.prompt("Write the session file");
		const sessionFile = sessionManager.getSessionFile()!;
		assert.ok(existsSync(sessionFile), "the prompt persisted a session file inside the fixture");
		const lifecycle: string[] = [];
		let persistenceReached!: () => void;
		let releasePersistence!: () => void;
		const reached = new Promise<void>((resolve) => {
			persistenceReached = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releasePersistence = resolve;
		});
		const flushSettings = session.settingsManager.flush.bind(session.settingsManager);
		vi.spyOn(session.settingsManager, "flush").mockImplementation(async () => {
			lifecycle.push("settings persistence");
			persistenceReached();
			await released;
			await flushSettings();
		});
		const flushSession = sessionManager.flush.bind(sessionManager);
		vi.spyOn(sessionManager, "flush").mockImplementation(() => {
			lifecycle.push("session persistence");
			flushSession();
		});
		const removeFixture = fake.dispose.bind(fake);
		vi.spyOn(fake, "dispose").mockImplementation(async () => {
			lifecycle.push("fixture removal");
			await removeFixture();
		});

		const closing = closeSessionThenFixture(session, fake);
		await reached;
		assert.deepEqual(
			lifecycle,
			["settings persistence"],
			"fixture removal must wait for disposal that is still persisting the session",
		);
		releasePersistence();
		await closing;

		assert.deepEqual(lifecycle, ["settings persistence", "session persistence", "fixture removal"]);
		assert.equal(existsSync(fake.dir), false, "cleanup removed the fixture after disposal settled");
	} finally {
		await fake.dispose();
	}
});

test.each([
	{ availability: "recovering" as const, shutdownFirst: false },
	{ availability: "unavailable" as const, shutdownFirst: false },
	{ availability: "recovering" as const, shutdownFirst: true },
	{ availability: "unavailable" as const, shutdownFirst: true },
])(
	"reload preserves registration with $availability activity (shutdown first: $shutdownFirst) without another prompt",
	async ({ availability, shutdownFirst }) => {
		const fake = await fakeHerdr();
		const loaded = await createTestExtensionsResult(
			[createHerdrExtension({ env: fake.env, enabled: () => true })],
			fake.dir,
		);
		const publisher = loaded.runtime.workflowActivityHub.registerWorkflowActivityPublisher();
		publisher.publishSnapshot({ availability: "ready", roots: [] });
		const manager = SessionManager.inMemory();
		const runners = [0, 1].map(() => {
			const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, fake.dir, manager, {} as never);
			runner.setUIContext({ ...noOpUIContext }, "tui");
			return runner;
		});
		try {
			await runners[0].emit({ type: "session_start" });
			await fake.waitFor(1);
			publisher.publishSnapshot({ availability });
			if (shutdownFirst) await runners[0].emit({ type: "session_shutdown", reason: "reload" });
			await runners[1].emit({ type: "session_start", reason: "reload" });
			await runners[0].emit({ type: "session_shutdown", reason: "reload" });
			assert.deepEqual(
				(await fake.calls()).filter((call) => call.phase === "start").map((call) => call.args[1]),
				["report-agent"],
				"unknown workflow activity must retain the registered agent, not release it",
			);
			await runners[1].emit({ type: "session_shutdown", reason: "quit" });
			assert.deepEqual(
				(await fake.calls()).filter((call) => call.phase === "start").map((call) => call.args[1]),
				["report-agent", "release-agent"],
				"quit releases the inherited registration even without a successor report",
			);
		} finally {
			for (const runner of runners) {
				await runner.emit({ type: "session_shutdown", reason: "quit" });
				runner.invalidate();
			}
			await fake.dispose();
		}
	},
);

// PR #2925: a supplied transactional loader may retain the loaded reporter closure.
test("SDK transactional reload retains the new reporter through retiring shutdown and final quit", async () => {
	const fake = await fakeHerdr();
	try {
		let loaded = await createTestExtensionsResult(
			[createHerdrExtension({ env: fake.env, enabled: () => true, clock: () => 100 })],
			fake.dir,
		);
		loaded.runtime.workflowActivityHub
			.registerWorkflowActivityPublisher()
			.publishSnapshot({ availability: "ready", roots: [] });
		let committed = false;
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => loaded,
			prepareReload: async () => {
				const candidate = { ...loaded, runtime: createExtensionRuntime() };
				candidate.runtime.workflowActivityHub
					.registerWorkflowActivityPublisher()
					.publishSnapshot({ availability: "ready", roots: [] });
				return {
					loader: createTestResourceLoader({ extensionsResult: candidate }),
					activate: () => {},
					commit: () => {
						loaded = candidate;
						committed = true;
					},
				};
			},
		};
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(fake.dir, "auth.json") });
		const faux = createFauxStreamFn([
			{
				text: "Continued after reload",
				beforeEmit: async () => {
					await fake.waitFor(3);
				},
			},
		]);
		modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: fauxModel.api,
			models: [fauxModel],
			streamSimple: faux.streamFn,
		});
		const sessionManager = SessionManager.create(fake.dir, fake.dir);
		const { session } = await createAgentSession({
			// #3105: startup observers receive the host at factory creation, not by replaying startup.
			extensionBindings: { mode: "tui", uiContext: { ...noOpUIContext } },
			cwd: fake.dir,
			agentDir: fake.dir,
			resourceLoader,
			modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				sessionSummary: { enabled: false },
			}),
			model: fauxModel,
			noTools: "all",
		});
		try {
			await session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
			await fake.waitFor(1);
			const retiring = session.extensionRunner;
			const sessionId = sessionManager.getSessionId();
			const retiringContext = retiring.createContext();
			const retiringHost = session.getAgentTaskHost();
			await session.reload({ failOnExtensionErrors: true });
			assert.equal(committed, true, "the real SDK transaction committed");
			assert.notEqual(session.extensionRunner, retiring);
			assert.equal(session.extensionRunner.createContext().sessionManager, sessionManager);
			assert.equal(sessionManager.getSessionId(), sessionId, "reload preserves the public session identity");
			assert.notEqual(session.getAgentTaskHost(), retiringHost, "reload installs a fresh task owner");
			assert.throws(() => retiringContext.getAgentTaskHost!(), /stale|closed|invalid/i);
			await assert.rejects(
				retiringHost.startAgentTask(
					{ kind: "agent", agent: "retired", task: "must not launch" },
					"retired-reload-owner",
					() => {
						throw new Error("Retired owner dispatched work");
					},
				),
				/Task owner is closed/,
			);
			await fake.waitFor(2);
			assert.deepEqual(
				(await fake.calls()).filter((call) => call.phase === "start").map((call) => call.args[1]),
				["report-agent", "report-agent"],
				"retiring runner shutdown must not release the candidate's claim",
			);
			await session.prompt("Continue working after reload");
			await fake.waitFor(4);
			assert.equal(session.agent.state.errorMessage, undefined);
			assert.deepEqual(session.messages.at(-1)?.content, [{ type: "text", text: "Continued after reload" }]);
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await session.extensionRunner.emit({ type: "agent_start" });
			const records = await fake.calls();
			assert.deepEqual(
				records.map((call) => call.phase),
				Array.from({ length: 5 }, () => ["start", "end"]).flat(),
			);
			const states = ["idle", "idle", "working", "idle", undefined];
			const calls = records.filter((call) => call.phase === "start");
			for (const [index, call] of calls.entries()) {
				const seq = arg(call.args, "--seq")!;
				if (index) assert.ok(Number(seq) > Number(arg(calls[index - 1].args, "--seq")));
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
					...(index === 0 || index === 1
						? [
								"--agent-session-id",
								sessionManager.getSessionId(),
								"--agent-session-path",
								sessionManager.getSessionFile()!,
							]
						: []),
				]);
				assert.equal(call.socket, fake.environment.socketPath);
			}
		} finally {
			await closeSessionThenFixture(session, fake);
		}
	} finally {
		await fake.dispose();
	}
});

// PR #2925: exercise stale events before runner invalidation can reject their contexts.
test("same-session retiring runner cannot cancel a pending claim or reclaim the active successor", async () => {
	const fake = await fakeHerdr(`
if (args.includes("working")) {
	const timer = setInterval(() => {
		if (fs.existsSync(require("node:path").join(args[2], "allow-release"))) {
			clearInterval(timer);
			finish();
		}
	}, 5);
} else finish();`);
	const loaded = await createTestExtensionsResult(
		[createHerdrExtension({ env: fake.env, enabled: () => true, clock: () => 100 })],
		fake.dir,
	);
	loaded.runtime.workflowActivityHub
		.registerWorkflowActivityPublisher()
		.publishSnapshot({ availability: "ready", roots: [] });
	const sessionManager = SessionManager.create(fake.dir, fake.dir);
	const [retiring, successor] = [0, 1].map(() => {
		const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, fake.dir, sessionManager, {} as never);
		runner.setUIContext({ ...noOpUIContext }, "tui");
		return runner;
	});
	let starting: Promise<undefined> | undefined;
	let stopping: Promise<undefined> | undefined;
	try {
		await retiring.emit({ type: "session_start" });
		await fake.waitFor(1);
		await retiring.emit({ type: "agent_start" });
		// The "working" report is held open until allow-release, so wait for it to start.
		await fake.waitForStarted(2);
		starting = successor.emit({ type: "session_start", reason: "reload" });
		await Promise.resolve();
		await retiring.emit({ type: "agent_start" });
		await retiring.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		stopping = retiring.emit({ type: "session_shutdown", reason: "reload" });
		assert.equal((await fake.calls()).length, 3, "candidate transport waits for predecessor report");
		await writeFile(join(fake.dir, "allow-release"), "");
		await Promise.all([starting, stopping]);
		await fake.waitFor(3);
		assert.deepEqual(
			(await fake.calls()).filter((call) => call.phase === "start").map((call) => call.args[1]),
			["report-agent", "report-agent", "report-agent"],
		);
		await successor.emit({ type: "agent_start" });
		await fake.waitFor(4);
		await successor.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await fake.waitFor(5);
		await retiring.emit({ type: "session_start", reason: "reload" });
		await retiring.emit({ type: "agent_start" });
		await retiring.emit({ type: "agent_settled" });
		await retiring.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
		await retiring.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await retiring.emit({ type: "session_shutdown", reason: "quit" });
		await successor.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
		await fake.waitFor(6);
		await successor.emit({ type: "agent_settled" });
		await fake.waitFor(7);
		await successor.emit({ type: "session_shutdown", reason: "quit" });
		// Neither retired runner can start again even after the successor's final release.
		for (const runner of [retiring, successor]) {
			await runner.emit({ type: "session_start", reason: "reload" });
			await runner.emit({ type: "agent_start" });
			await runner.emit({ type: "session_shutdown", reason: "quit" });
		}
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
				...(index === 0 || index === 2
					? [
							"--agent-session-id",
							sessionManager.getSessionId(),
							"--agent-session-path",
							sessionManager.getSessionFile()!,
						]
					: []),
			]);
			assert.equal(call.socket, fake.environment.socketPath);
		}
	} finally {
		await writeFile(join(fake.dir, "allow-release"), "");
		await Promise.all([starting, stopping]);
		for (const runner of [retiring, successor]) await runner.emit({ type: "session_shutdown", reason: "quit" });
		for (const runner of [retiring, successor]) runner.invalidate();
		await fake.dispose();
	}
});

// PR #2925: a rejected candidate must not retire the runner that reload keeps alive.
test.each(["prepareCommit", "extendResources", "publishProviders"] as const)(
	"SDK rejected %s preserves live reporting, approval state and owning quit",
	async (failure) => {
		const fake = await fakeHerdr();
		try {
			let candidateContext: ExtensionContext | undefined;
			const loaded = await createTestExtensionsResult(
				[
					createHerdrExtension({ env: fake.env, enabled: () => true, clock: () => 100 }),
					(pi) => {
						pi.on("session_start", (event, ctx) => {
							if (event.reason === "reload") candidateContext = ctx;
						});
						pi.on("resources_discover", (event) =>
							event.reason === "reload" && failure === "extendResources"
								? { skillPaths: [join(fake.dir, "rejected-skill")] }
								: {},
						);
					},
				],
				fake.dir,
			);
			loaded.runtime.workflowActivityHub
				.registerWorkflowActivityPublisher()
				.publishSnapshot({ availability: "ready", roots: [] });
			const resourceLoader = {
				...createTestResourceLoader({ extensionsResult: loaded }),
				prepareReload: async () => {
					const candidate = { ...loaded, runtime: createExtensionRuntime() };
					candidate.runtime.workflowActivityHub
						.registerWorkflowActivityPublisher()
						.publishSnapshot({ availability: "ready", roots: [] });
					return {
						loader: {
							...createTestResourceLoader({ extensionsResult: candidate }),
							extendResources: async () => {
								throw new Error("Herdr regression: extendResources rejected");
							},
						},
						activate: () => assert.fail("rejected resources must not activate"),
						prepareCommit: () => {
							assert.ok(candidateContext, "candidate session_start ran before rejected preparation");
							if (failure === "prepareCommit") throw new Error("Herdr regression: prepareCommit rejected");
							return { commit: () => assert.fail("rejected preparation must not commit"), rollback: () => {} };
						},
						commit: () => assert.fail("rejected resources must not commit"),
					};
				},
			};
			const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(fake.dir, "auth.json") });
			const faux = createFauxStreamFn([
				{
					text: "Continued after rejection",
					beforeEmit: async () => {
						await fake.waitFor(5);
					},
				},
			]);
			modelRuntime.registerProvider(fauxModel.provider, {
				baseUrl: fauxModel.baseUrl,
				apiKey: "faux-key",
				api: fauxModel.api,
				models: [fauxModel],
				streamSimple: faux.streamFn,
			});
			const sessionManager = SessionManager.create(fake.dir, fake.dir);
			const { session } = await createAgentSession({
				extensionBindings: { mode: "tui", uiContext: { ...noOpUIContext } },
				cwd: fake.dir,
				agentDir: fake.dir,
				resourceLoader,
				modelRuntime,
				sessionManager,
				settingsManager: SettingsManager.inMemory({
					compaction: { enabled: false },
					sessionSummary: { enabled: false },
				}),
				model: fauxModel,
				noTools: "all",
			});
			const providerTransaction = modelRuntime.createExtensionProviderTransaction.bind(modelRuntime);
			// Fault injection at the supplied model service's fallible publication boundary.
			const providerFailure =
				failure === "publishProviders"
					? vi.spyOn(modelRuntime, "createExtensionProviderTransaction").mockImplementation((ids) => ({
							...providerTransaction(ids),
							commit: async () => {
								throw new Error("Herdr regression: publishProviders rejected");
							},
						}))
					: undefined;
			try {
				await session.bindExtensions({ mode: "tui", uiContext: { ...noOpUIContext } });
				const live = session.extensionRunner;
				await fake.waitFor(1);
				await live.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
				await fake.waitFor(2);
				await assert.rejects(
					() => session.reload({ failOnExtensionErrors: true }),
					new RegExp(`${failure} rejected`),
				);
				assert.equal(session.extensionRunner, live);
				assert.deepEqual(
					(await fake.calls()).filter((call) => call.phase === "start").map((call) => call.args[1]),
					["report-agent", "report-agent"],
					"rejected preparation must leave the live pane claim untouched",
				);
				assert.ok(candidateContext);
				assert.equal(live.createContext().sessionManager, sessionManager);
				assert.throws(() => candidateContext!.sessionManager, /ctx is stale/);
				const reporter = loaded.extensions[0];
				// Replay captured callbacks directly, bypassing the invalid runner's event guards.
				for (const type of [
					"session_start",
					"agent_start",
					"agent_settled",
					"ui_prompt_start",
					"ui_prompt_end",
					"session_shutdown",
				] as const) {
					for (const handler of reporter.handlers.get(type) ?? []) {
						await handler(
							{ type, reason: type === "session_shutdown" ? "quit" : "reload" } as never,
							candidateContext,
						);
					}
				}
				await live.emit({ type: "agent_settled" });
				await fake.waitFor(3);
				assert.equal(
					arg((await fake.calls()).at(-1)!.args, "--state"),
					"blocked",
					"live approval survives rejection",
				);
				await live.emit({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });
				await fake.waitFor(4);
				await session.prompt("Continue after rejected reload");
				await fake.waitFor(6);
				assert.equal(session.agent.state.errorMessage, undefined);
				assert.deepEqual(session.messages.at(-1)?.content, [{ type: "text", text: "Continued after rejection" }]);
				await live.emit({ type: "session_shutdown", reason: "quit" });
				await live.emit({ type: "session_shutdown", reason: "quit" });
				await live.emit({ type: "session_start", reason: "reload" });
				const records = await fake.calls();
				assert.deepEqual(
					records.map((call) => call.phase),
					Array.from({ length: 7 }, () => ["start", "end"]).flat(),
				);
				const calls = records.filter((call) => call.phase === "start");
				const states = ["idle", "blocked", "blocked", "idle", "working", "idle", undefined];
				for (const [index, call] of calls.entries()) {
					const seq = arg(call.args, "--seq")!;
					if (index) assert.ok(Number(seq) > Number(arg(calls[index - 1].args, "--seq")));
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
						...(index === 1 || index === 2 ? ["--message", "Waiting for approval"] : []),
						...(index === 0
							? [
									"--agent-session-id",
									sessionManager.getSessionId(),
									"--agent-session-path",
									sessionManager.getSessionFile()!,
								]
							: []),
					]);
					assert.equal(call.socket, fake.environment.socketPath);
				}
			} finally {
				try {
					await closeSessionThenFixture(session, fake);
				} finally {
					providerFailure?.mockRestore();
				}
			}
		} finally {
			await fake.dispose();
		}
	},
);
