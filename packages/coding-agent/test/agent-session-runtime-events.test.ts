import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { workflow } from "../../workflows/src/authoring/workflow.js";
import { createInMemoryTestBackend } from "../../workflows/src/durable/factory.js";
import { makeMcpPort } from "../../workflows/src/extension/workflow-ports.js";
import { run } from "../../workflows/src/runs/foreground/executor.js";
import { createStore } from "../../workflows/src/shared/store.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus, type EventBus } from "../src/core/event-bus.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(
		extensionFactory: ExtensionFactory,
		options: { eventBus?: EventBus; beforeCreate?: () => void; shutdownFails?: boolean } = {},
	) {
		const tempDir = join(tmpdir(), `pi-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
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

		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model: faux.getModel(),
			resourceLoaderOptions: {
				...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			options.beforeCreate?.();
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			if (options.shutdownFails)
				await expect(runtimeHost.dispose()).rejects.toMatchObject({ code: "ShutdownFailed" });
			else await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux, createRuntime };
	}

	// #3105: disposal waits for the active provider turn's abort settlement.
	it("public disposal aborts an active provider without starting another turn", async () => {
		const { runtimeHost, faux } = await createRuntimeHost(() => {});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let aborted = false;
		faux.setResponses([
			async (_context, options) => {
				entered();
				await new Promise<void>((resolve) => {
					options!.signal!.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve();
						},
						{ once: true },
					);
				});
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
		]);
		const prompting = runtimeHost.session.prompt("controlled provider");
		await started;
		await runtimeHost.session.dispose();
		await prompting;
		expect(aborted).toBe(true);
		expect(runtimeHost.session.isStreaming).toBe(false);
		await expect(runtimeHost.session.prompt("cannot replay")).rejects.toMatchObject({ code: "SessionClosed" });
	});

	// #3105: public owner disposal cancels active auth without destroying borrowed model state.
	it.each(["dispose", "reload"] as const)(
		"%s settles active OAuth login and preserves the borrowed model runtime",
		async (boundary) => {
			const { runtimeHost } = await createRuntimeHost(() => {});
			const models = runtimeHost.session.modelRuntime;
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let observed: AbortSignal | undefined;
			let completeNext = false;
			models.registerProvider("shutdown-auth", {
				baseUrl: "https://example.test",
				api: "openai-completions",
				models: [],
				oauth: {
					name: "Shutdown auth",
					login: async (_callbacks, signal) => {
						if (completeNext)
							return { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 60_000 };
						observed = signal;
						entered();
						await new Promise<void>((resolve) => {
							signal!.addEventListener("abort", () => resolve(), { once: true });
						});
						throw new DOMException("Cancelled", "AbortError");
					},
					refreshToken: async (credential) => credential,
					getApiKey: (credential) => credential.access,
				},
			});
			const login = runtimeHost.loginOAuthProvider("shutdown-auth", { onAuth: () => {}, onPrompt: async () => "" });
			const rejected = expect(login).rejects.toThrow("Login cancelled");
			await started;
			await runtimeHost.session[boundary]();
			await rejected;
			expect(observed?.aborted).toBe(true);
			expect(models.getRegisteredProviderConfig("shutdown-auth")).toBeDefined();
			if (boundary === "reload") {
				completeNext = true;
				await runtimeHost.loginOAuthProvider("shutdown-auth", { onAuth: () => {}, onPrompt: async () => "" });
				await runtimeHost.session.dispose();
			}
			await expect(
				runtimeHost.loginOAuthProvider("shutdown-auth", { onAuth: () => {}, onPrompt: async () => "" }),
			).rejects.toMatchObject({ code: "SessionClosed" });
		},
	);

	// #3105: replacement retains one owner identity and binds input before startup.
	it("retains runtime ownership and host input across replacement without sharing sibling ownership", async () => {
		const scopes: object[] = [];
		const answers: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			if (pi.lifecycleScope) scopes.push(pi.lifecycleScope);
			pi.on("session_start", async (event, ctx) => {
				if (event.reason !== "startup") answers.push((await ctx.ui.input("replacement"))!);
			});
		});
		await runtimeHost.session.bindExtensions({
			humanInput: {
				confirm: async () => false,
				select: async () => undefined,
				input: async () => " retained ",
				editor: async () => undefined,
				questionnaire: async () => ({ answers: [], cancelled: true }),
			},
		});
		const old = runtimeHost.session;
		await runtimeHost.newSession();
		expect(runtimeHost.session).not.toBe(old);
		expect(answers).toEqual([" retained "]);
		expect(scopes).toHaveLength(2);
		expect(scopes[1]).toBe(scopes[0]);
		await expect(old.prompt("closed")).rejects.toMatchObject({ code: "SessionClosed" });
		let siblingScope: object | undefined;
		await createRuntimeHost((pi) => {
			siblingScope = pi.lifecycleScope;
		});
		expect(siblingScope).not.toBe(scopes[0]);
	});

	it.each(["new", "resume", "fork"] as const)(
		"finalizes retained shutdown handlers when %s creation rejects before constructing a session",
		async (reason) => {
			let rejectCreation = false;
			const events: string[] = [];
			const failure = new Error("replacement factory rejected");
			const { runtimeHost } = await createRuntimeHost(
				(pi) => {
					pi.on("session_shutdown", (event) => {
						events.push(`first:${event.reason}`);
						if (event.reason === "quit") throw new Error("first cleanup failed");
					});
					pi.on("session_shutdown", (event) => {
						events.push(`second:${event.reason}`);
						if (event.reason === "quit") throw new Error("second cleanup failed");
					});
				},
				{
					shutdownFails: true,
					beforeCreate: () => {
						if (rejectCreation) throw failure;
					},
				},
			);
			const { runtimeHost: sibling } = await createRuntimeHost(() => {});
			const target = SessionManager.create(runtimeHost.cwd);
			target.appendMessage(fauxAssistantMessage("saved"));
			const entry = runtimeHost.session.sessionManager.appendMessage({
				role: "user",
				content: "fork",
				timestamp: Date.now(),
			});
			runtimeHost.session.sessionManager.appendMessage(fauxAssistantMessage("saved"));
			const models = runtimeHost.session.modelRuntime;
			rejectCreation = true;
			const replacement =
				reason === "new"
					? runtimeHost.newSession()
					: reason === "resume"
						? runtimeHost.switchSession(target.getSessionFile()!)
						: runtimeHost.fork(entry);
			const error = await replacement.catch((error: unknown) => error);
			expect(events).toEqual([`first:${reason}`, `second:${reason}`, "first:quit", "second:quit"]);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors[0]).toBe(failure);
			expect(String((error as AggregateError).errors[1].errors)).toContain("first cleanup failed");
			expect(String((error as AggregateError).errors[1].errors)).toContain("second cleanup failed");
			await expect(runtimeHost.dispose()).rejects.toMatchObject({ code: "ShutdownFailed" });
			expect(events).toHaveLength(4);
			expect(models.getAvailableSnapshot().length).toBeGreaterThan(0);
			await sibling.session.prompt("still open");
		},
	);

	it("prepares resume with a live outgoing context and preserves it on preflight failure", async () => {
		let shutdowns = 0;
		const { runtimeHost, createRuntime } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				shutdowns++;
			});
		});
		const outgoing = runtimeHost.session;
		const target = SessionManager.create(runtimeHost.cwd);
		target.appendMessage({ role: "user", content: "saved", timestamp: Date.now() });
		target.appendMessage(fauxAssistantMessage("saved"));
		const targetPath = target.getSessionFile()!;
		let preparations = 0;
		createRuntime.prepareResume = async (options) => {
			preparations++;
			expect(outgoing.sessionManager.getCwd()).toBe(runtimeHost.cwd);
			expect(shutdowns).toBe(0);
			expect(options.projectTrustContext?.cwd).toBe(runtimeHost.cwd);
			throw new Error("trust preflight failed");
		};
		await expect(
			runtimeHost.switchSession(targetPath, {
				projectTrustContextFactory: (cwd) => ({
					cwd,
					mode: "print",
					hasUI: false,
					ui: {
						select: async () => undefined,
						confirm: async () => false,
						input: async () => undefined,
						notify: () => {},
					},
				}),
			}),
		).rejects.toThrow("trust preflight failed");
		expect(preparations).toBe(1);
		expect(shutdowns).toBe(0);
		expect(runtimeHost.session).toBe(outgoing);
		createRuntime.prepareResume = async (options) => {
			expect(shutdowns).toBe(0);
			return async () => {
				expect(shutdowns).toBe(1);
				return createRuntime(options);
			};
		};
		expect(await runtimeHost.switchSession(targetPath)).toEqual({ cancelled: false });
		expect(runtimeHost.session).not.toBe(outgoing);
	});

	it("delivers trust waits to a live context before answering and settles observers before shutdown", async () => {
		let answer!: () => void;
		const prompt = new Promise<void>((resolve) => {
			answer = resolve;
		});
		let releaseObserver!: () => void;
		const observer = new Promise<void>((resolve) => {
			releaseObserver = resolve;
		});
		let started!: () => void;
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		const events: string[] = [];
		const { runtimeHost, createRuntime } = await createRuntimeHost((pi) => {
			pi.on("ui_prompt_start", async (event, ctx) => {
				expect(event.reason).toBe("project_trust");
				expect(ctx.sessionManager.getCwd()).toBe(ctx.cwd);
				events.push("start");
				started();
				await observer;
				expect(ctx.sessionManager.getCwd()).toBe(ctx.cwd);
				events.push("settled");
			});
			pi.on("ui_prompt_end", () => {
				events.push("end");
			});
			pi.on("session_shutdown", () => {
				events.push("shutdown");
			});
		});
		const target = SessionManager.create(runtimeHost.cwd);
		target.appendMessage(fauxAssistantMessage("saved"));
		createRuntime.prepareResume = async (options) => {
			await runtimeHost.session.extensionRunner.withProjectTrustPrompt("confirm", "Trust", () => prompt);
			return () => createRuntime(options);
		};
		const replacement = runtimeHost.switchSession(target.getSessionFile()!);
		await start;
		expect(events).toEqual(["start"]);
		answer();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(["start", "end"]);
		releaseObserver();
		await replacement;
		expect(events).toEqual(["start", "end", "settled", "shutdown"]);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("marks shutdown handlers when disposal was caused by a host signal (#3492)", async () => {
		const events: SessionShutdownEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
		});

		await runtimeHost.dispose({ fromSignal: true });

		assert.deepEqual(events, [{ type: "session_shutdown", reason: "quit", fromSignal: true }]);
	});

	it("does not mark an ordinary disposal as host-signal driven (#3492)", async () => {
		const events: SessionShutdownEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
		});

		await runtimeHost.dispose();

		assert.deepEqual(events, [{ type: "session_shutdown", reason: "quit" }]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((pi) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("replaces Markdown transformers and event-bus listeners on reload and dispose", async () => {
		const eventBus = createEventBus();
		let loads = 0;
		let firstApi: ExtensionAPI | undefined;
		let extensionCalls = 0;
		let hostCalls = 0;
		eventBus.on("markdown-transformer-reload", () => {
			hostCalls += 1;
		});
		const { runtimeHost } = await createRuntimeHost(
			(pi) => {
				const load = ++loads;
				firstApi ??= pi;
				pi.events.on("markdown-transformer-reload", () => {
					extensionCalls += 1;
				});
				pi.registerMarkdownTransformer((markdown) => `${load}:${markdown}`);
			},
			{ eventBus },
		);

		const staleApi = firstApi;
		if (!staleApi) throw new Error("Expected the first extension API");
		const emit = async (): Promise<{ extension: number; host: number }> => {
			const extensionBefore = extensionCalls;
			const hostBefore = hostCalls;
			eventBus.emit("markdown-transformer-reload", undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			return { extension: extensionCalls - extensionBefore, host: hostCalls - hostBefore };
		};

		expect(await emit()).toEqual({ extension: 1, host: 1 });

		await runtimeHost.session.reload();
		expect(() => staleApi.registerMarkdownTransformer((markdown) => markdown)).toThrow(
			"This extension ctx is stale after session replacement or reload.",
		);
		expect(await emit()).toEqual({ extension: 1, host: 1 });

		await runtimeHost.session.reload();
		expect(await emit()).toEqual({ extension: 1, host: 1 });
		expect(runtimeHost.session.extensionRunner.getMarkdownTransformers()).toHaveLength(1);
		const [transformer] = runtimeHost.session.extensionRunner.getMarkdownTransformers();
		if (!transformer) throw new Error("Expected the reloaded Markdown transformer");
		expect(transformer("message", { messageType: "assistant", isStreaming: false, availableWidth: 80 })).toBe(
			"3:message",
		);

		await runtimeHost.session.dispose();
		expect(await emit()).toEqual({ extension: 0, host: 1 });
	});

	it("keeps a running workflow's MCP scope calls harmless after reload", async () => {
		const eventBus = createEventBus();
		let scopeEventCount = 0;
		eventBus.on("mcp.scope.set", () => {
			scopeEventCount += 1;
		});
		let mcpPort: ReturnType<typeof makeMcpPort>;
		const { runtimeHost } = await createRuntimeHost(
			(pi) => {
				mcpPort ??= makeMcpPort({ events: pi.events });
			},
			{ eventBus },
		);
		const staleMcpPort = mcpPort;
		if (!staleMcpPort) throw new Error("Expected a workflow MCP port");

		const firstPromptStarted = Promise.withResolvers<void>();
		const releaseFirstPrompt = Promise.withResolvers<void>();
		let promptCalls = 0;
		const definition = workflow({
			name: "stale-mcp-scope",
			description: "keeps a stage's scope events safe across reload",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("restricted-before", { mcp: { allow: ["github"] } }).prompt("before reload");
				await ctx.stage("restricted-after", { mcp: { allow: ["github"] } }).prompt("after reload");
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				store: createStore(),
				durableBackend: createInMemoryTestBackend(),
				mcp: staleMcpPort,
				adapters: {
					prompt: {
						prompt: async () => {
							promptCalls += 1;
							if (promptCalls === 1) {
								firstPromptStarted.resolve();
								await releaseFirstPrompt.promise;
							}
							return "ok";
						},
					},
				},
			},
		);

		await firstPromptStarted.promise;
		expect(scopeEventCount).toBe(1);
		await runtimeHost.session.reload();
		releaseFirstPrompt.resolve();
		const result = await execution;

		expect(result.status).toBe("completed");
		expect(promptCalls).toBe(2);
		expect(scopeEventCount).toBe(1);
	});
});
