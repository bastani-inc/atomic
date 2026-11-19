/**
 * The in-process interactive host reports an extension whose `session_start` throws and keeps its session: the error
 * is shown once, it stays on screen after deferred startup rebuilds the transcript, and the session still answers
 * prompts. Before, the bind rejected with `ExtensionStartupError`, the session was closed and every prompt answered
 * "Session is closed" (#5501).
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@bastani/atomic-ai/compat";
import type { Terminal } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionFactory, InlineExtension, LoadExtensionsResult } from "../src/core/extensions/types.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { DefaultResourceLoader, type ResourceExtensionPaths } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { AgentSession, AgentSessionRuntime, InteractiveMode } from "../src/index.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { normalizeRenderedOutput } from "./interactive-mode-status-helpers.js";
import { createHarness } from "./suite/harness.js";

/** Each case builds a real interactive host over a real session, which is slow on loaded Windows runners. */
const INTERACTIVE_HOST_TIMEOUT_MS = 90_000;
const NO_BUILTINS = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;

class FakeTerminal implements Terminal {
	columns = 160;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

const cleanup: Array<() => Promise<void>> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

/**
 * An interactive host over an unstarted session, as the CLI builds it: the host's bind starts the extensions. With
 * `settlesStartupTrust`, the first session finishes startup in place once trust is settled, as a CLI startup that asks
 * the project trust question or loads `-e` extensions does.
 */
async function createMode(
	extension: ExtensionFactory | InlineExtension[],
	options: {
		settlesStartupTrust?: boolean;
		additionalExtensionPaths?: string[];
		extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
		loaderClass?: typeof DefaultResourceLoader;
	} = {},
) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-5501-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-5501-agent-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const loaderOptions = {
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			builtinPackagePaths: [],
			additionalExtensionPaths: options.additionalExtensionPaths,
			extensionsOverride: options.extensionsOverride,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		};
		const extensionFactories = Array.isArray(extension) ? extension : [extension];
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			modelRuntime,
			resourceLoaderOptions: { ...loaderOptions, extensionFactories: options.loaderClass ? [] : extensionFactories },
		});
		if (options.loaderClass) {
			const loader = new options.loaderClass({
				...loaderOptions,
				settingsManager: services.settingsManager,
				extensionFactories,
			});
			await loader.reload();
			services.resourceLoader = loader;
		}
		const created = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model: faux.getModel(),
			builtins: NO_BUILTINS,
		});
		if (options.settlesStartupTrust && runtimeOptions.sessionStartEvent === undefined) {
			services.completeStartup = () => created.session.completeStartupResources(services.resourceLoader);
		}
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const mode = new InteractiveMode(runtime, { terminal: new FakeTerminal() });
	cleanup.push(async () => {
		mode.stop();
		await runtime.dispose();
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});
	return { mode, faux };
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

test("a failed SDK startup releases resources owned by the session's dispose override before rejecting (#5697)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-dispose-"));
	cleanup.push(async () => rmSync(cwd, { recursive: true, force: true }));
	const { resourceLoader, settingsManager, modelRuntime } = await createAgentSessionServices({
		cwd,
		agentDir: cwd,
		resourceLoaderOptions: {
			builtinPackagePaths: [],
			extensionFactories: [
				(pi) =>
					pi.on("session_start", () => {
						throw new Error("failed to start");
					}),
			],
		},
	});
	const log = await open(join(cwd, "session.log"), "w");
	cleanup.push(() => log.close());
	class LoggingSession extends AgentSession {
		override async dispose(): Promise<void> {
			await log.close();
			await super.dispose();
		}
	}
	const session = new LoggingSession({
		agent: new Agent({ streamFn: streamSimple }),
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader,
		settingsManager,
		modelRuntime,
	});
	cleanup.push(() => session.dispose());

	await assert.rejects(session.bindExtensions({}), { name: "ExtensionStartupError", message: /failed to start/ });
	await assert.rejects(log.write("after rollback"), { code: "EBADF" });
});

test.each(["bindExtensions", "run"] as const)(
	"%s rejects with SessionClosed when disposal revokes the SDK session's runner before discovery (#5697)",
	async (entry) => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-sdk-discovery-"));
		cleanup.push(async () => rmSync(cwd, { recursive: true, force: true }));
		const entered = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			resourceLoaderOptions: {
				builtinPackagePaths: [],
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async (_event, ctx) => {
							signal = ctx.sessionSignal;
							entered.resolve();
							await once(signal, "abort");
						});
						pi.on("resources_discover", () => ({}));
					},
				],
			},
		});
		class GuardedSession extends AgentSession {
			override get extensionRunner() {
				signal?.throwIfAborted();
				return super.extensionRunner;
			}
		}
		const session = new GuardedSession({
			...services,
			agent: new Agent({ streamFn: streamSimple }),
			sessionManager: SessionManager.inMemory(cwd),
		});
		cleanup.push(() => session.dispose());
		let mode: InteractiveMode | undefined;
		if (entry === "run") {
			const runtime = new AgentSessionRuntime(session, services, async () => {
				throw new Error("unexpected session replacement");
			});
			cleanup.push(() => runtime.dispose());
			mode = new InteractiveMode(runtime, { terminal: new FakeTerminal() });
		}
		try {
			const startup = mode ? mode.run() : session.bindExtensions({});
			await Promise.race([entered.promise, startup]);
			await Promise.all([
				assert.rejects(startup, { name: "Error", code: "SessionClosed", message: "SessionClosed" }),
				session.dispose(),
			]);
		} finally {
			mode?.stop();
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["bindExtensions", "run", "quitting run"] as const)(
	"%s preserves the diagnostic from a decorated discovery method after the session closes (#5697)",
	async (entry) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { mode } = await createMode((pi) => {
			pi.on("session_start", async () => {
				entered.resolve();
				await release.promise;
			});
			pi.on("resources_discover", () => ({}));
		});
		const runner = mode.session.extensionRunner;
		const discover = runner.emitResourcesDiscover.bind(runner);
		let diagnostic: Error | undefined;
		runner.emitResourcesDiscover = async (...args) => {
			try {
				return await discover(...args);
			} catch (cause) {
				diagnostic = new Error("catalog discovery failed", { cause });
				throw diagnostic;
			}
		};

		const startup = entry === "bindExtensions" ? mode.session.bindExtensions({}) : mode.run();
		try {
			await Promise.race([entered.promise, startup]);
			const closed = entry === "quitting run" ? mode.runtimeHost.dispose() : mode.session.dispose();
			release.resolve();
			await Promise.all([
				assert.rejects(startup, (error) => diagnostic !== undefined && error === diagnostic),
				closed,
			]);
			assert.ok(diagnostic?.cause instanceof Error && diagnostic.cause.message === "SessionClosed");
		} finally {
			release.resolve();
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup propagates a separate reload's error when a discovery decorator refreshes the catalog (#5697)",
	async () => {
		const { mode } = await createMode((pi) => pi.on("resources_discover", () => ({})));
		const session = mode.session;
		const runner = session.extensionRunner;
		const discover = runner.emitResourcesDiscover.bind(runner);
		const refreshing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let reloadError: unknown;
		runner.emitResourcesDiscover = async (...args) => {
			if (args[1] === "reload") {
				refreshing.resolve();
				await release.promise;
				return discover(...args);
			}
			const paths = await discover(...args);
			try {
				await session.extendResourcesFromExtensions("reload");
			} catch (error) {
				reloadError = error;
				throw error;
			}
			return paths;
		};
		try {
			const run = mode.run();
			await Promise.race([refreshing.promise, run]);
			const closed = mode.runtimeHost.dispose();
			release.resolve();
			await Promise.all([
				assert.rejects(run, (error) => reloadError !== undefined && error === reloadError),
				closed,
			]);
		} finally {
			release.resolve();
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["before run", "during session_start", "before a later runtime quit"] as const)(
	"disposing the SDK session %s rejects interactive startup with the original error (#5697)",
	async (timing) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const {
			session,
			tempDir,
			cleanup: disposeHarness,
		} = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.on("session_start", async () => {
						entered.resolve();
						await release.promise;
					}),
			],
		});
		cleanup.push(disposeHarness);
		const runtime = new AgentSessionRuntime(
			session,
			{
				cwd: tempDir,
				agentDir: tempDir,
				modelRuntime: session.modelRuntime,
				settingsManager: session.settingsManager,
				resourceLoader: session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("unexpected session replacement");
			},
		);
		cleanup.push(() => runtime.dispose());
		if (timing !== "during session_start") await runtime.session.dispose();
		const mode = new InteractiveMode(runtime, { initialMessage: "probe", terminal: new FakeTerminal() });
		const bindExtensions = session.bindExtensions.bind(session);
		const bind = vi.spyOn(session, "bindExtensions");
		if (timing === "before a later runtime quit") {
			bind.mockImplementation((bindings) =>
				bindExtensions(bindings).catch(async (error: unknown) => {
					await runtime.dispose();
					throw error;
				}),
			);
		}
		const prompt = vi.spyOn(session, "prompt");
		vi.spyOn(mode, "getUserInput").mockRejectedValue(new Error("startup entered the input loop"));
		try {
			const run = mode.run();
			await Promise.all([
				assert.rejects(run, (error) => {
					assert.ok(error instanceof Error && "code" in error && error.code === "SessionClosed", String(error));
					assert.equal(error, bind.mock.settledResults[0]?.value);
					return true;
				}),
				timing === "during session_start" &&
					Promise.race([entered.promise, run]).then(() => {
						const disposed = runtime.session.dispose();
						release.resolve();
						return disposed;
					}),
			]);
			assert.equal(prompt.mock.calls.length, 0);
		} finally {
			release.resolve();
			mode.stop();
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"interactive startup returns the loader's original error after rollback revokes its proxy (#5697)",
	async () => {
		const { proxy, revoke } = Proxy.revocable(new Error("catalog unavailable"), {});
		class CatalogLoader extends DefaultResourceLoader {
			override async extendResources(paths: ResourceExtensionPaths): Promise<void> {
				if (paths.skillPaths?.length) throw proxy;
				await super.extendResources(paths);
			}
		}
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => ({ skillPaths: ["./catalog"] }));
				pi.on("session_shutdown", revoke);
			},
			{ loaderClass: CatalogLoader },
		);

		const sameError = await mode.run().then(
			() => false,
			(error: unknown) => error === proxy,
		);
		assert.throws(() => Object.getPrototypeOf(proxy), TypeError);
		assert.equal(sameError, true);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"eager startup propagates the error from a resource loader using a closed session (#5697)",
	async () => {
		const { mode: catalog } = await createMode(() => {});
		await catalog.runtimeHost.dispose();
		let catalogError: unknown;
		class CatalogLoader extends DefaultResourceLoader {
			override async extendResources(paths: ResourceExtensionPaths): Promise<void> {
				if (paths.skillPaths?.length) {
					try {
						await catalog.session.prompt("refresh skill catalog");
					} catch (error) {
						catalogError = error;
						throw error;
					}
				}
				await super.extendResources(paths);
			}
		}
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => ({ skillPaths: ["./catalog"] }));
			},
			{ loaderClass: CatalogLoader },
		);

		await assert.rejects(mode.init(), (error) => error === catalogError);
		assert.ok(catalogError instanceof Error && "code" in catalogError && catalogError.code === "SessionClosed");
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each([false, true])(
	"run preserves its bind rejection when the host quits during session_start (resource discovery: %s) (#5697)",
	async (discoversResources) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { mode } = await createMode((pi) => {
			pi.on("session_start", async () => {
				entered.resolve();
				await release.promise;
			});
			if (discoversResources) pi.on("resources_discover", () => ({}));
		});
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		try {
			const bind = vi.spyOn(mode.session, "bindExtensions");
			const run = mode.run();
			await Promise.race([entered.promise, run]);
			const quit = assert.rejects(mode.shutdown({ fromSignal: true }), /process\.exit\(0\)/);
			release.resolve();
			await Promise.all([
				assert.rejects(run, (error) => {
					assert.ok(error instanceof Error && "code" in error && error.code === "SessionClosed");
					return error === bind.mock.settledResults[0]?.value;
				}),
				quit,
			]);
		} finally {
			release.resolve();
			exit.mockRestore();
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a live event can initialize a host that renews its session access in init (#5697)",
	async () => {
		const { mode } = await createMode(() => {});
		const session = mode.session;
		let available = false;
		const lease = vi.spyOn(mode.runtimeHost, "session", "get").mockImplementation(() => {
			if (!available) throw new Error("session unavailable until init");
			return session;
		});
		const init = mode.init.bind(mode);
		vi.spyOn(mode, "init").mockImplementation(() => {
			available = true;
			return init();
		});
		try {
			await mode.handleEvent({ type: "agent_start" });
			assert.ok(mode.workingRunMeter.snapshot());
		} finally {
			lease.mockRestore();
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["mirror", "catalog"] as const)(
	"a detached interactive subscriber reports a closed %s session's own error (#5697)",
	async (peer) => {
		const { mode: remote } = await createMode(() => {});
		const closedSession = remote.session;
		await remote.runtimeHost.dispose();
		const { mode } = await createMode((pi) => pi.on("resources_discover", () => ({})));
		const failure = Promise.withResolvers<unknown>();
		const reported: unknown[] = [];
		const record = (error: unknown) => reported.push(error);
		process.on("unhandledRejection", record);
		try {
			if (peer === "mirror") {
				await mode.init();
				const handle = mode.handleEvent.bind(mode);
				mode.handleEvent = async (event) => {
					await handle(event);
					if (event.type !== "session_info_changed") return;
					try {
						await closedSession.sendCustomMessage({
							customType: "title",
							content: event.name ?? "",
							display: false,
						});
					} catch (error) {
						failure.resolve(error);
						throw error;
					}
				};
				await mode.session.setSessionName("renamed after startup");
			} else {
				const runner = mode.session.extensionRunner;
				const discover = runner.emitResourcesDiscover.bind(runner);
				runner.emitResourcesDiscover = async (...args) => {
					const paths = await discover(...args);
					try {
						await closedSession.extendResourcesFromExtensions("reload");
					} catch (error) {
						failure.resolve(error);
						throw error;
					}
					return paths;
				};
				const handle = vi.spyOn(mode, "handleEvent");
				mode.subscribeToAgent();
				mode.session.clearQueue();
				// The event settles after startup rollback. Its caller is separate from the detached listener.
				await assert.rejects(handle.mock.results[0].value, { code: "SessionClosed" });
			}
			const original = await failure.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(reported.length, 1);
			assert.equal(reported[0], original);
		} finally {
			process.off("unhandledRejection", record);
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"an independent UI rebind during startup discovery still reports its own closed-session error (#5697)",
	async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { mode } = await createMode((pi) => {
			pi.on("session_start", async () => {
				entered.resolve();
				await release.promise;
			});
			pi.on("resources_discover", () => ({}));
		});
		const session = mode.session;
		const discover = session.extensionRunner.emitResourcesDiscover.bind(session.extensionRunner);
		let independent: unknown;
		session.extensionRunner.emitResourcesDiscover = async (...args) => {
			try {
				return await discover(...args);
			} catch {
				try {
					await mode.bindCurrentSessionExtensions();
				} catch (error) {
					independent = error;
					throw error;
				}
				throw new Error("expected the separate rebind to reject");
			}
		};
		const unhandled: unknown[] = [];
		const record = (error: unknown) => unhandled.push(error);
		process.on("unhandledRejection", record);
		try {
			const handle = vi.spyOn(mode, "handleEvent");
			mode.subscribeToAgent();
			session.clearQueue();
			const event = handle.mock.results[0].value;
			await Promise.race([entered.promise, event]);
			const closed = session.dispose();
			release.resolve();
			await Promise.all([assert.rejects(event, { code: "SessionClosed" }), closed]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.ok(independent);
			assert.equal(unhandled.length, 1);
			assert.equal(unhandled[0], independent);
		} finally {
			release.resolve();
			process.off("unhandledRejection", record);
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"an SDK host awaiting event startup can read the original catalog response (#5697)",
	async () => {
		const { mode } = await createMode((pi) => pi.on("resources_discover", () => ({})));
		const response = new Response("Service unavailable", { status: 503 });
		const failure = new (class extends Error {
			get code() {
				return response.json();
			}
		})("Catalog responded 503");
		mode.session.extensionRunner.emitResourcesDiscover = async () => {
			throw failure;
		};
		const subscribe = vi.spyOn(mode.session, "subscribe");
		mode.subscribeToAgent();
		const listener = subscribe.mock.calls[0][0];
		assert.ok(typeof listener === "function");
		const original = await Promise.resolve(listener({ type: "agent_start" })).then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.equal(original, failure);
		assert.equal(await response.text(), "Service unavailable");
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"an SDK host awaiting its interactive subscriber receives the original rejection (#5697)",
	async () => {
		const { mode } = await createMode(() => {});
		const subscribe = vi.spyOn(mode.session, "subscribe");
		mode.subscribeToAgent();
		const listener = subscribe.mock.calls[0][0];
		assert.ok(typeof listener === "function");
		const revoked = Proxy.revocable(new Error("discovery failed"), {});
		revoked.revoke();
		for (const reason of [Object.assign(new Error("closed"), { code: "SessionClosed" }), revoked.proxy]) {
			mode.handleEvent = () => {
				throw reason;
			};
			const same = await Promise.resolve(listener({ type: "agent_start" })).then(
				() => false,
				(error: unknown) => error === reason,
			);
			assert.ok(same);
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each([false, true])(
	"closing during an event's startup rejects the event without an unhandled subscriber rejection (resource discovery: %s) (#5697)",
	async (discoversResources) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { mode } = await createMode((pi) => {
			pi.on("session_start", async () => {
				entered.resolve();
				await release.promise;
			});
			if (discoversResources) pi.on("resources_discover", () => ({}));
		});
		const handle = vi.spyOn(mode, "handleEvent");
		const unhandled: unknown[] = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		try {
			mode.subscribeToAgent();
			mode.session.clearQueue(); // Publishes a queue_update; the session does not await its subscribers.
			const event = handle.mock.results[0].value;
			await Promise.race([entered.promise, event]);
			const closed = mode.runtimeHost.dispose();
			release.resolve();
			await Promise.all([assert.rejects(event, { code: "SessionClosed" }), closed]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			release.resolve();
			process.off("unhandledRejection", record);
		}
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"the in-process interactive host keeps its session when an extension throws in session_start and shows the error once (#5501)",
	async () => {
		const { mode, faux } = await createMode((pi) => {
			pi.on("session_start", () => {
				throw new Error("boom in session_start");
			});
		});

		await mode.bindCurrentSessionExtensions();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in session_start'), 1, chat);
		assert.equal(occurrences(chat, "Extension startup failed"), 0, chat);
		faux.setResponses([fauxAssistantMessage("still working")]);
		await mode.session.prompt("hello");
		const last = mode.session.messages.at(-1);
		assert.deepEqual(last?.role === "assistant" ? last.content : undefined, [
			{ type: "text", text: "still working" },
		]);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"an extension error reported during deferred interactive startup stays on screen after the transcript is rebuilt (#5501)",
	async () => {
		let starts = 0;
		const { mode } = await createMode((pi) => {
			pi.on("session_start", () => {
				// Only the first start throws, so the startup reload that follows reports nothing more.
				if (starts++ === 0) throw new Error("boom in session_start");
			});
		});
		mode.deferredStartupPending = true;

		await mode.completeDeferredStartup();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(starts, 2, "the startup reload started the extension again");
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in session_start'), 1, chat);
		assert.equal(occurrences(chat, "Extension loading failed"), 0, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"one interactive startup shows a resources_discover failure once when startup discovers resources twice (#5501)",
	async () => {
		const { mode } = await createMode((pi) => {
			pi.on("resources_discover", () => {
				throw new Error("review discovery failure");
			});
		});
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: review discovery failure'), 1, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a startup that settles project trust shows a resources_discover failure once, and /reload still shows it (#5501)",
	async () => {
		let discoveries = 0;
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => {
					discoveries++;
					throw new Error("discovery failure");
				});
			},
			{ settlesStartupTrust: true },
		);
		mode.deferredStartupPending = true;

		await mode.completeDeferredStartup();

		const error = 'Extension "<inline:1>" error: discovery failure';
		assert.equal(discoveries, 2, "settling trust discovered the resources again, as documented");
		const startupChat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(startupChat, error), 1, startupChat);

		await mode.handleReloadCommand();

		const reloadChat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(discoveries, 3);
		assert.equal(occurrences(reloadChat, error), 2, reloadChat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

type DiscoveryHandler = (...args: unknown[]) => Promise<unknown>;

function rebuildDiscovery(wrap: (handler: DiscoveryHandler) => DiscoveryHandler) {
	return (base: LoadExtensionsResult): LoadExtensionsResult => ({
		...base,
		extensions: base.extensions.map((ext) => {
			const discovered = ext.handlers.get("resources_discover");
			if (!discovered) return ext;
			const handlers = new Map(ext.handlers);
			handlers.set("resources_discover", discovered.map(wrap));
			return { ...ext, handlers };
		}),
	});
}

test(
	"startup reports both handlers when a factory changes the handler behind a rebuilt forwarder (#5501)",
	async () => {
		const calls: string[] = [];
		function firstDirectory() {
			calls.push("first");
			throw new Error("directory unavailable");
		}
		function secondDirectory() {
			calls.push("second");
			throw new Error("directory unavailable");
		}
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", calls.length === 0 ? firstDirectory : secondDirectory);
			},
			{
				extensionsOverride: rebuildDiscovery(
					(original) =>
						(...args) =>
							original(...args),
				),
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		assert.deepEqual(calls, ["first", "second"]);
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, "at firstDirectory"), 1, chat);
		assert.equal(occurrences(chat, "at secondDirectory"), 1, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["its own", "the first"] as const)(
	"startup reports both installations when each forwards to %s handler (#5501)",
	async (delegate) => {
		let calls = 0;
		const factory: ExtensionFactory = (pi) => {
			pi.on("resources_discover", () => {
				calls++;
				throw new Error("directory unavailable");
			});
		};
		const originals = new Map<string, DiscoveryHandler>();
		const paths = ["<inline:first>", "<inline:second>"];
		const forwarders = new Map(
			paths.map((path) => [
				path,
				(...args: unknown[]) => originals.get(delegate === "the first" ? paths[0] : path)!(...args),
			]),
		);
		let pass = 0;
		const { mode } = await createMode(
			[
				{ name: "first", factory },
				{ name: "second", factory },
			],
			{
				extensionsOverride(base) {
					const path = paths[pass++];
					const ext = base.extensions.find((entry) => entry.path === path)!;
					for (const entry of base.extensions) {
						const handler = entry.handlers.get("resources_discover")?.[0];
						if (handler) originals.set(entry.path, handler);
					}
					const handlers = new Map(ext.handlers);
					handlers.set("resources_discover", [forwarders.get(ext.path)!]);
					return { ...base, extensions: [{ ...ext, handlers }] };
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		assert.equal(calls, 2);
		const chat = normalizeRenderedOutput(mode.chatContainer);
		for (const path of paths) assert.equal(occurrences(chat, `Extension "${path}" error: directory unavailable`), 1);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup reports both failures when rebuilt discovery callbacks replace the handler's error (#5501)",
	async () => {
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => {
					throw new Error("directory unavailable");
				});
			},
			{
				extensionsOverride: rebuildDiscovery((original) => (...args) => {
					try {
						return original(...args);
					} catch {
						throw new Error("directory unavailable");
					}
				}),
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const row = 'Extension "<inline:1>" error: directory unavailable';
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 2);
		await mode.handleReloadCommand();
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 3);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["then", "skillPaths"])(
	"startup reports each failing %s getter installed by a rebuilt discovery callback (#5501)",
	async (property) => {
		let getterCalls = 0;
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => ({ skillPaths: [] }));
			},
			{
				extensionsOverride: rebuildDiscovery(
					(original) =>
						(...args) =>
							Object.defineProperty(original(...args), property, {
								get() {
									getterCalls++;
									throw new Error("directory unavailable");
								},
							}),
				),
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const row = 'Extension "<inline:1>" error: directory unavailable';
		assert.equal(getterCalls, 2);
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 2);
		await mode.handleReloadCommand();
		assert.equal(getterCalls, 3);
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 3);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup reports distinct discovery handlers with the same error but not a repeat of the same handler (#5501)",
	async () => {
		let discoveries = 0;
		const { mode } = await createMode(
			(pi) => {
				// Removing a preceding handler changes the others' list positions, not their identities.
				const unsubscribe = pi.on("resources_discover", () => unsubscribe());
				pi.on("resources_discover", function firstDirectory() {
					discoveries++;
					throw new Error("unavailable directory");
				});
				pi.on("resources_discover", function secondDirectory() {
					if (discoveries === 2) throw new Error("unavailable directory");
				});
			},
			{ settlesStartupTrust: true },
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(discoveries, 2);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: unavailable directory'), 2, chat);
		assert.equal(occurrences(chat, "at firstDirectory"), 1, chat);
		assert.equal(occurrences(chat, "at secondDirectory"), 1, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup reports a loader override and a factory discovery handler separately when both throw the same error (#5501)",
	async () => {
		let overrides = 0;
		let discoveries = 0;
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", function factoryDirectory() {
					discoveries++;
					throw new Error("unavailable directory");
				});
			},
			{
				settlesStartupTrust: true,
				extensionsOverride(base) {
					const extension = base.extensions.find((entry) => entry.path === "<inline:1>");
					extension?.handlers.get("resources_discover")?.unshift(async function overrideDirectory() {
						if (++overrides === 2) throw new Error("unavailable directory");
					});
					return base;
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(overrides, 2);
		assert.equal(discoveries, 2);
		assert.equal(occurrences(chat, "at factoryDirectory"), 1, chat);
		assert.equal(occurrences(chat, "at overrideDirectory"), 1, chat);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: unavailable directory'), 2, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a startup reload reports both registrations of a raw session_start callback beside the factory callback (#5501)",
	async () => {
		let rawCalls = 0;
		let factoryCalls = 0;
		async function sharedStartup() {
			if (++rawCalls > 2) throw new Error("startup error");
		}
		const { mode } = await createMode(
			(pi) => {
				pi.on("session_start", function factoryStartup() {
					factoryCalls++;
					throw new Error("startup error");
				});
			},
			{
				extensionsOverride(base) {
					const extension = base.extensions.find((entry) => entry.path === "<inline:1>");
					extension?.handlers.get("session_start")?.unshift(sharedStartup, sharedStartup);
					return base;
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(factoryCalls, 2);
		assert.equal(rawCalls, 4);
		assert.equal(occurrences(chat, "at factoryStartup"), 1, chat);
		assert.equal(occurrences(chat, "at sharedStartup"), 2, chat);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: startup error'), 3, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a rediscovered file reports its handler once at startup and again on /reload (#5501)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-5501-file-"));
		cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
		const extension = join(dir, "extension.ts");
		const calls = join(dir, "calls");
		writeFileSync(
			extension,
			`import {appendFileSync} from "node:fs";
		export default (pi) => {
			pi.on("resources_discover", () => {
				appendFileSync(${JSON.stringify(calls)}, "x");
				throw "file discovery failed";
			});
		};`,
		);
		const { mode } = await createMode([], { additionalExtensionPaths: [extension] });
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const row = "error: file discovery failed";
		assert.equal(readFileSync(calls, "utf8"), "xx");
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 1);
		await mode.handleReloadCommand();
		assert.equal(readFileSync(calls, "utf8"), "xxx");
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 2);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each([false, true])(
	"startup distinguishes two raw installations from pi.on even for the same callable (separate lists: %s) (#5501)",
	async (separateLists) => {
		let calls = 0;
		async function sharedSite() {
			// With separate lists the last installation only fails on the completion pass.
			if (++calls !== 3 || !separateLists) throw new Error("shared error");
		}
		const factory: ExtensionFactory = (pi) => {
			pi.on("resources_discover", sharedSite);
		};
		const { mode } = await createMode(
			[
				{ name: "same", factory },
				{ name: "same", factory: () => {} },
			],
			{
				settlesStartupTrust: true,
				extensionsOverride(base) {
					const [a, b] = base.extensions.filter((ext) => ext.path === "<inline:same>");
					a.handlers.get("resources_discover")!.push(sharedSite);
					const target = separateLists ? b : a;
					target.handlers.set("resources_discover", [
						...(target.handlers.get("resources_discover") ?? []),
						sharedSite,
					]);
					return base;
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(calls, 6);
		assert.equal(occurrences(chat, "at sharedSite"), 3, chat);
		assert.equal(occurrences(chat, 'Extension "<inline:same>" error: shared error'), 3, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each([
	{ label: "two named factories", name: "filesystem", deferred: false, copy: false },
	{ label: "named and unnamed factories", name: "2", deferred: false, copy: false },
	{ label: "two named factories re-evaluated by deferred startup", name: "filesystem", deferred: true, copy: false },
	{ label: "same-named factories copied by a loader override", name: "filesystem", deferred: true, copy: true },
])(
	"startup distinguishes $label with the same displayed extension path and /reload reports them again (#5501)",
	async ({ name, deferred, copy }) => {
		let left = 0;
		let right = 0;
		const first: ExtensionFactory = (pi) => {
			pi.on("resources_discover", function firstProvider() {
				left++;
				throw new Error("provider error");
			});
		};
		const second: ExtensionFactory = (pi) => {
			pi.on("resources_discover", function secondProvider() {
				if (++right >= 2) throw new Error("provider error");
			});
		};
		const { mode } = await createMode([{ name, factory: first }, name === "2" ? second : { name, factory: second }], {
			settlesStartupTrust: !deferred,
			extensionsOverride: copy
				? (base) => ({ ...base, extensions: base.extensions.map((ext) => ({ ...ext })) })
				: undefined,
		});
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		const row = `Extension "<inline:${name}>" error: provider error`;
		assert.deepEqual([left, right], [2, 2]);
		assert.equal(occurrences(chat, "at firstProvider"), 1, chat);
		assert.equal(occurrences(chat, "at secondProvider"), 1, chat);
		assert.equal(occurrences(chat, row), 2, chat);
		await mode.handleReloadCommand();
		const reload = normalizeRenderedOutput(mode.chatContainer);
		assert.deepEqual([left, right], [3, 3]);
		assert.equal(occurrences(reload, row), 4, reload);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"/reload in the interactive host shows the error of an extension whose session_start throws and keeps the reload (#5501)",
	async () => {
		const { mode } = await createMode((pi) => {
			pi.on("session_start", (event) => {
				if (event.reason === "reload") throw new Error("boom in reload");
			});
			pi.registerCommand("reloaded-command", { description: "registered by every load", handler: async () => {} });
		});
		await mode.bindCurrentSessionExtensions();
		const runnerBefore = mode.session.extensionRunner;

		await mode.handleReloadCommand();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in reload'), 1, chat);
		assert.equal(occurrences(chat, "Reload failed"), 0, chat);
		assert.notEqual(mode.session.extensionRunner, runnerBefore, "the reload took effect");
		assert.ok(mode.session.extensionRunner.getCommand("reloaded-command"));
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"/new in the interactive host shows the error of an extension whose session_start throws and opens the new session (#5501)",
	async () => {
		const { mode, faux } = await createMode((pi) => {
			pi.on("session_start", (event) => {
				if (event.reason === "new") throw new Error("boom in new");
			});
		});
		await mode.bindCurrentSessionExtensions();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		cleanup.push(async () => exit.mockRestore());
		const previous = mode.session;

		await mode.handleClearCommand();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.notEqual(mode.session, previous, "the new session replaced the old one");
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in new'), 1, chat);
		faux.setResponses([fauxAssistantMessage("new session works")]);
		await mode.session.prompt("hello");
		const last = mode.session.messages.at(-1);
		assert.deepEqual(last?.role === "assistant" ? last.content : undefined, [
			{ type: "text", text: "new session works" },
		]);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);
